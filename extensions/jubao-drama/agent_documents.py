"""新剧本 Agent 的会话级版本稿件，不套用 OA6.1 阶段守卫。"""

from contextlib import closing, nullcontext
import hashlib
import json
import re
from uuid import uuid4

from hermes_constants import get_hermes_home
from plugins.plugin_storage import plugin_db

from .capability_selection import document_owner
from .documents import export_script, read_material
from .document_evidence import receipt_scopes
from .agent_document_delegation import delegated_document_ids
from .agent_document_reading import content_metadata, directory_page, document_metadata, document_page, project_summary
from . import requirement_delivery


_KINDS = {"script", "outline", "analysis", "novel", "document", "internal"}


def _tables(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS agent_documents "
                 "(id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, name TEXT, content TEXT)")
    # 独立保存交付信息，旧版正文表无需改写，历史稿件仍能显式补导出。
    conn.execute("CREATE TABLE IF NOT EXISTS agent_document_delivery "
                 "(document_id TEXT PRIMARY KEY, kind TEXT NOT NULL, receipt TEXT, export_error TEXT)")
    requirement_delivery.create_table(conn)
    conn.commit()


def _documents(conn, session_id, agent_id, document_id=None):
    rows = conn.execute(
        "SELECT d.id,d.name,d.content,COALESCE(e.kind,'document'),e.receipt,e.export_error,q.content_sha256,q.report "
        "FROM agent_documents d LEFT JOIN agent_document_delivery e ON e.document_id=d.id "
        "LEFT JOIN agent_document_quality q ON q.document_id=d.id "
        "WHERE d.session_id=? AND d.agent_id=? "
        + ("AND d.id=? " if document_id else "") + "ORDER BY d.rowid",
        (session_id, agent_id, document_id) if document_id else (session_id, agent_id),
    ).fetchall()
    documents, exports = [], []
    for identifier, name, content, kind, raw_receipt, error, digest, quality in rows:
        document = {"id": identifier, "name": name, "content": content, "kind": kind, "status": "draft"}
        requirement_delivery.annotate(document, digest, quality)
        if raw_receipt:
            # 未通过核验的稿件同样提供 Word 下载；是否达标由 status/quality_check 标明，不以隐藏下载代替说明。
            exports.append(json.loads(raw_receipt))
            document["export_status"] = "ready"
        elif kind == "internal":
            document["export_status"] = "internal"
        else:
            document["export_status"] = "failed" if error else "pending"
        if error:
            document["export_error"] = error
        documents.append(document)
    return documents, exports


def _receipt_is_valid(document, receipt):
    """复用已导出稿前先回读完整 DOCX，防止只相信数据库中的 path。"""
    try:
        material = read_material(receipt["path"])
        expected_text = document["content"].replace("\r\n", "\n").replace("\r", "\n")
        expected_content = hashlib.sha256(expected_text.encode()).hexdigest()
        if material['sha256']!=receipt['sha256'] or receipt['source_sha256']!=expected_content:
            return False
        # 老导出器把排版HTML写成Word正文，文件与源稿摘要仍能对上，必须核对实际可见文本。
        if re.search(r'</?(?:p|div|span|strong|b|em|i|br|h[1-6]|ul|ol|li|table|tr|td|th|blockquote)\b[^>]*>',expected_text,re.I):
            from .manuscript_text import visible_manuscript
            from .documents import _markdown_rows
            visible=visible_manuscript(expected_text)[0]
            if document.get('kind')=='script':
                expected='\n'.join(line for line in visible.splitlines() if line.strip())
                actual='\n'.join(line for line in material['text'].splitlines() if line.strip())
            else:
                expected=_markdown_rows(visible)[1]
                actual=material['text']
            return actual==expected
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False


def _snapshot(session_id, agent_id, verify_identifier=None):
    with closing(plugin_db("jubao-drama")) as conn:
        _tables(conn)
        documents, exports = _documents(conn, session_id, agent_id, verify_identifier)
    # 读取不在数据库连接内进行；失效回执被标为可重试，而正文和其他旧版本保留。
    receipt_by_id = {row["artifact_id"]: row for row in exports}
    invalid = [
        document for document in documents
        if document["id"] == verify_identifier and document["export_status"] == "ready"
        and not _receipt_is_valid(document, receipt_by_id[document["id"]])
    ]
    if invalid:
        with closing(plugin_db("jubao-drama")) as conn:
            _tables(conn)
            for document in invalid:
                conn.execute(
                    "UPDATE agent_document_delivery SET receipt=NULL, export_error=? WHERE document_id=? AND receipt=?",
                    ("已导出的 Word 文件缺失或内容校验失败，请重试导出", document["id"],
                     json.dumps(receipt_by_id[document["id"]], ensure_ascii=False)),
                )
            conn.commit()
        with closing(plugin_db("jubao-drama")) as conn:
            _tables(conn)
            documents, exports = _documents(conn, session_id, agent_id, verify_identifier)
    project = project_summary(session_id, agent_id, documents, exports)
    return documents, project


# “第05集”“第05集至第09集”，以及第一个数字后不带“集”的“第5-9集”“第05至09集”。
_NAMED_EPISODES = re.compile(r"第\s*(\d{1,4})\s*(?:集(?:[^第]{0,40}?[—–\-~至到]\s*第?\s*(\d{1,4})\s*集)?|[—–\-~至到]\s*第?\s*(\d{1,4})\s*集)")


def _name_for_episodes(name, content, kind):
    """剧本与大纲的名称按正文实际集号校正：名称写“第05集”而正文是第5—9集时，界面会把整批当成单集，
    也会把不同批次误合并为同一稿件的版本。名称里没有集号时保持原样。"""
    if kind not in {"script", "outline"}:
        return name
    from .requirement_checks import _episodes
    numbers = sorted({row["episode_number"] for row in _episodes(content) if isinstance(row.get("episode_number"), int)})
    named = _NAMED_EPISODES.search(name)
    if not numbers or not named:
        return name
    low, high = numbers[0], numbers[-1]
    label = f"第{low:02d}集" if low == high else f"第{low:02d}—{high:02d}集"
    if (int(named[1]), int(named[2] or named[3] or named[1])) == (low, high):
        # 集数正确时统一写法（“第08集至第10集”“第8-10集”都写成“第08—10集”），同一批稿件各版本名称一致，
        # 稿件列表里不会出现同一批稿件的几种叫法。
        return name[:named.start()] + label + name[named.end():] if len(named[0]) <= 12 else name
    work = (re.search(r"《[^》]{1,30}》", name) or [""])[0]
    return f"{work}{label} {'剧本正文' if kind == 'script' else '分集大纲'}"


def _save(args, session_id, agent_id, *, automatic_capture=False):
    name, content, kind = args.get("name"), args.get("content"), args.get("kind", "document")
    if (not isinstance(name, str) or not 1 <= len(name.strip()) <= 120
            or not isinstance(content, str) or not 1 <= len(content) <= 1_000_000):
        raise ValueError("请提供稿件名称和完整内容，单份最多一百万字符")
    if not isinstance(kind, str) or kind not in _KINDS:
        raise ValueError("稿件类型必须是 script、outline、analysis、novel、document 或 internal")
    name = _name_for_episodes(name.strip(), content, kind)
    from .requirement_control import _current
    digest = hashlib.sha256(content.encode()).hexdigest()
    current = None if kind == "internal" else _current(session_id)
    # 历史补存不消耗本轮额度；当前已明确拒绝的正文按摘要复用末稿，改标题也不能绕过。
    state = None if automatic_capture else current
    if state:
        from .agent_delivery import mark_managed_input
        mark_managed_input(session_id, state.get("delivery_input"))
    if automatic_capture and current:
        with current["validation_lock"]:
            retained = current.get("rejected_drafts", {}).get(digest)
            if retained:
                return retained, True
    with state["validation_lock"] if state else nullcontext():
        from . import requirement_revision
        name, retained_id, revision_target = requirement_revision.prepare_save(state, session_id, agent_id, name, kind, content)
        if retained_id:
            if state:
                state.setdefault("rejected_drafts", {})[digest] = retained_id
            return retained_id, True
        with closing(plugin_db("jubao-drama")) as conn:
            _tables(conn)
            # 外层validation_lock将目标预算领取、真实插入和质量回执串成一次交付。
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute(
                "SELECT d.id,d.content FROM agent_documents d LEFT JOIN agent_document_delivery e ON e.document_id=d.id "
                "WHERE d.session_id=? AND d.agent_id=? AND d.name=? AND COALESCE(e.kind,'document')=? ORDER BY d.rowid",
                (session_id, agent_id, name, kind),
            ).fetchall()
            existing = next((row[0] for row in rows if row[1] == content), None)
            identifier = existing or uuid4().hex
            if existing is None:
                conn.execute("INSERT INTO agent_documents VALUES (?,?,?,?,?)",
                             (identifier, session_id, agent_id, name, content))
                conn.execute("INSERT INTO agent_document_delivery(document_id,kind) VALUES (?,?)", (identifier, kind))
            conn.commit()
        requirement_revision.saved_revision(state, revision_target, identifier, content)
        return identifier, False


def _version_number(document, session_id, agent_id):
    """同一对话、同名稿件按保存先后编号，从 1 开始。"""
    with closing(plugin_db("jubao-drama")) as conn:
        rows = [row[0] for row in conn.execute(
            "SELECT id FROM agent_documents WHERE session_id=? AND agent_id=? AND name=? ORDER BY rowid",
            (session_id, agent_id, document["name"]))]
    return rows.index(document["id"]) + 1 if document["id"] in rows else max(1, len(rows))


def _export(document, session_id, agent_id):
    """文件写入及安全读取均在数据库连接外执行，避免安全作用域查询互锁。"""
    folder = get_hermes_home() / "workspace" / "agents" / agent_id / hashlib.sha256(session_id.encode()).hexdigest()[:24]
    stem = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", document["name"]).strip(" .")[:60] or "稿件"
    # 同一份稿件每返修一次就多一个 Word：文件名带“第N版”，下载到本地后能分清初稿与后来的修订稿。
    stem = f"{stem}_第{_version_number(document, session_id, agent_id)}版"
    try:
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        target = folder / (stem + "-" + document["id"][:8] + "-" + uuid4().hex[:8] + ".docx")
        receipt = {
            **export_script(document["content"], target, document_kind="document" if document["kind"] == "analysis" else document["kind"]),
            "artifact_id": document["id"], "document_id": document["id"],
            "kind": document["kind"], "status": "draft", "name": stem + ".docx",
        }
        error = None
    except (OSError, ValueError):
        receipt, error = None, "Word 生成失败，正文已保存；请重试导出"
    with closing(plugin_db("jubao-drama")) as conn:
        _tables(conn)
        # 已成功登记的回执不被同时到达的重复导出或失败结果覆盖。
        conn.execute(
            "INSERT INTO agent_document_delivery(document_id,kind,receipt,export_error) VALUES (?,?,?,?) "
            "ON CONFLICT(document_id) DO UPDATE SET receipt=excluded.receipt,export_error=excluded.export_error "
            "WHERE agent_document_delivery.receipt IS NULL",
            (document["id"], document["kind"], json.dumps(receipt, ensure_ascii=False) if receipt else None, error),
        )
        conn.commit()


def _reading_scope(session_id, agent_id):
    state = get_hermes_home() / "state.db"
    lineage = [session_id]
    if state.is_file():
        from hermes_state import SessionDB
        with closing(SessionDB(state, read_only=True)) as database:
            lineage = database._resume_lineage_ids(session_id)
    allowed = []
    for identifier in lineage:
        try:
            owner = document_owner(identifier)
        except PermissionError:
            continue
        if owner == agent_id:
            allowed.append(identifier)
    return allowed


def _list_documents(args, session_id, agent_id, scope, delegated):
    offset, limit = args.get("offset", 0), args.get("limit", 20)
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError("目录起始位置必须为非负整数，每页数量须为 1 至 50")
    snapshot = args.get("snapshot_rowid")
    if "snapshot_rowid" in args and (type(snapshot) is not int or snapshot < 0):
        raise ValueError("目录快照位置必须为非负整数")
    placeholders = ",".join("?" for _ in scope)
    where = f"(d.session_id IN ({placeholders})"
    parameters = (*scope,)
    if delegated:
        where += " OR d.id IN (" + ','.join('?' for _ in delegated) + ')'
        parameters += tuple(delegated)
    where += ") AND d.agent_id=?"
    parameters += (agent_id,)
    with closing(plugin_db("jubao-drama")) as conn:
        _tables(conn)
        if snapshot is None:
            snapshot = conn.execute(f"SELECT COALESCE(MAX(d.rowid),0) FROM agent_documents d WHERE {where}", parameters).fetchone()[0]
        # SQLite rowid 为有符号 64 位；更大的非负上界等同最大 rowid。
        snapshot = min(snapshot, (1 << 63) - 1)
        where += " AND d.rowid<=?"
        parameters += (snapshot,)
        total = conn.execute(f"SELECT COUNT(*) FROM agent_documents d WHERE {where}", parameters).fetchone()[0]
        if offset > total:
            raise ValueError("目录起始位置超出稿件总数")
        # 数据库侧只投影本页元数据，目录读取不把历史长正文搬入返回值。
        conn.create_function("drama_document_metadata", 2, lambda content, name: json.dumps(content_metadata(content, name), ensure_ascii=False))
        conn.create_function('drama_content_sha256',1,lambda content:hashlib.sha256(content.encode()).hexdigest())
        rows = conn.execute(
            "SELECT d.id,d.name,drama_document_metadata(d.content,d.name),COALESCE(e.kind,'document'), "
            "CASE WHEN q.content_sha256=drama_content_sha256(d.content) THEN json_extract(q.report,'$.previous_document_id') END, "
            "CASE WHEN q.content_sha256=drama_content_sha256(d.content) THEN json_extract(q.report,'$.previous_content_sha256') END "
            "FROM agent_documents d LEFT JOIN agent_document_delivery e ON e.document_id=d.id "
            "LEFT JOIN agent_document_quality q ON q.document_id=d.id "
            f"WHERE {where} ORDER BY d.rowid DESC LIMIT ? OFFSET ?", (*parameters, limit, offset),
        ).fetchall()
    documents = [{"id": identifier, "name": name, "kind": kind, **json.loads(metadata),
                  **({'previous_document_id':previous,'previous_content_sha256':previous_hash} if previous and previous_hash else {})}
                 for identifier, name, metadata, kind, previous, previous_hash in rows]
    return directory_page(documents, offset=offset, total=total, snapshot_rowid=snapshot)


def document_action(args, session_id, *, quality_checker=None, automatic_capture=False, defer_revision=False):
    from .requirement_control import _current
    state = _current(session_id) if isinstance(args, dict) and args.get("action") == "save" else None
    # 保存、预算和回执属于一次交付，后到的并行保存必须等前稿质量回执落库。
    with state["validation_lock"] if state else nullcontext():
        return _document_action(args, session_id, quality_checker=quality_checker, automatic_capture=automatic_capture, defer_revision=defer_revision)


def _document_action(args, session_id, *, quality_checker=None, automatic_capture=False, defer_revision=False):
    agent_id = document_owner(session_id)
    from .plain_documents import OWNER, allowed
    if agent_id == OWNER and (automatic_capture or not allowed(args, session_id)):
        raise PermissionError("普通会话仅按用户本轮明确请求保存或导出文档")
    if not isinstance(args, dict):
        raise ValueError("稿件操作参数必须是对象")
    action = args.get("action")
    fields = {"save": {"name", "content", "kind"}, "export": {"document_id"},
              "read": {"document_id", "start_char", "max_chars", "content_sha256"}, "list": {"offset", "limit", "snapshot_rowid"}}
    if not isinstance(action, str) or action not in fields:
        raise ValueError("稿件操作必须是 save、read、list 或 export")
    if set(args) - {"action"} - fields[action]:
        raise ValueError("本次稿件操作包含不支持的参数")
    scope = _reading_scope(session_id, agent_id)
    delegated = delegated_document_ids(agent_id, scope) if action != "save" else []
    if action == "list":
        return _list_documents(args, session_id, agent_id, scope, delegated)
    if action == "save":
        identifier, retained = _save(args, session_id, agent_id, automatic_capture=automatic_capture)
    else:
        identifier, retained = args.get("document_id"), False
    if not isinstance(identifier, str) or not identifier.strip():
        raise ValueError("请提供有效稿件编号")
    with closing(plugin_db("jubao-drama")) as conn:
        _tables(conn)
        placeholders = ",".join("?" for _ in scope)
        row = conn.execute(f"SELECT session_id FROM agent_documents WHERE id=? AND agent_id=? AND (session_id IN ({placeholders}) OR id IN ("
                           + ','.join('?' for _ in delegated) + '))', (identifier, agent_id, *scope, *delegated)).fetchone()
    if row is None:
        raise ValueError("当前 Agent 会话中没有这份稿件")
    owner_session = row[0]
    documents, project = _snapshot(owner_session, agent_id, identifier)
    document = next((row for row in documents if row["id"] == identifier), None)
    if document is None:
        raise ValueError("当前 Agent 会话中没有这份稿件")
    if action == "export" and document["kind"] == "internal":
        raise ValueError("内部稿件不生成 Word，请把要交付的正文另存为用户稿件")
    if automatic_capture:
        from .requirement_control import automatic_quality
        quality_checker = automatic_quality
    quality = (requirement_delivery.record(document, session_id, quality_checker, historical=automatic_capture)
               if action in {"save", "export"} and not retained else document.get('quality_check'))
    if quality is not None:
        from .requirement_control import _current
        from .requirement_revision import repairing
        if repairing(_current(session_id),document['id'],content=document['content'],kind=document['kind']):
            quality = {**quality, 'revisions_remaining': 0}
        document['quality_check'] = quality
        document['status'] = 'checked' if quality['status'] == 'pass' else 'revision_required'
    passed = quality is None or quality['status'] == 'pass'
    if action in {"save", "export"} and document["export_status"] in {"pending", "failed"}:
        _export(document, owner_session, agent_id)
        documents, project = _snapshot(owner_session, agent_id, identifier)
        document = next(row for row in documents if row["id"] == identifier)
    metadata = document_metadata(document)
    result = {"ok": document["export_status"] != "failed", "document": metadata,
              "project": project_summary(session_id, agent_id, [metadata], project["exports"])}
    if quality is not None:
        result['quality_check'] = (requirement_delivery.quality_summary(quality) if action=='read'
                                   else requirement_delivery.public_report(quality))
        if action != "read":
            from .requirement_revision import guidance
            result.update(ok=True, saved=True, next=guidance(quality,session_id,offer_revision=action == "save" and not defer_revision and not automatic_capture))
    if action == "read":
        result.update(document_page(document, args))
    receipt = next((row for row in project["exports"] if row["artifact_id"] == identifier), None)
    if receipt:
        result["receipt"] = {**receipt, **receipt_scopes(receipt)}
        result["project"]["exports"] = [result["receipt"]]
    if document.get("export_error"):
        result.update(saved=True, export_status="failed", export_error=document["export_error"])
    if retained:
        result.update(saved=False, retained=True, blocked_reason="revision_limit",
                      next="本轮一次修改已结束，不再保存、检查或改写新版本；当前回执属于已保留稿件。只说明实际修改及需要用户决定的内容，不输出通过或未通过标签。")
    return result

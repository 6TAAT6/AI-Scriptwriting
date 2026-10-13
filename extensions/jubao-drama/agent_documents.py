"""新剧本 Agent 的会话级版本稿件，不套用 OA6.1 阶段守卫。"""

from contextlib import closing
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


_KINDS = {"script", "outline", "analysis", "novel", "document", "internal"}


def _tables(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS agent_documents "
                 "(id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, name TEXT, content TEXT)")
    # 独立保存交付信息，旧版正文表无需改写，历史稿件仍能显式补导出。
    conn.execute("CREATE TABLE IF NOT EXISTS agent_document_delivery "
                 "(document_id TEXT PRIMARY KEY, kind TEXT NOT NULL, receipt TEXT, export_error TEXT)")
    conn.commit()


def _documents(conn, session_id, agent_id, document_id=None):
    rows = conn.execute(
        "SELECT d.id,d.name,d.content,COALESCE(e.kind,'document'),e.receipt,e.export_error "
        "FROM agent_documents d LEFT JOIN agent_document_delivery e ON e.document_id=d.id "
        "WHERE d.session_id=? AND d.agent_id=? "
        + ("AND d.id=? " if document_id else "") + "ORDER BY d.rowid",
        (session_id, agent_id, document_id) if document_id else (session_id, agent_id),
    ).fetchall()
    documents, exports = [], []
    for identifier, name, content, kind, raw_receipt, error in rows:
        document = {"id": identifier, "name": name, "content": content, "kind": kind, "status": "draft"}
        if raw_receipt:
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
        return (material["sha256"] == receipt["sha256"]
                and receipt["source_sha256"] == expected_content)
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


def _save(args, session_id, agent_id):
    name, content, kind = args.get("name"), args.get("content"), args.get("kind", "document")
    if (not isinstance(name, str) or not 1 <= len(name.strip()) <= 120
            or not isinstance(content, str) or not 1 <= len(content) <= 1_000_000):
        raise ValueError("请提供稿件名称和完整内容，单份最多一百万字符")
    if not isinstance(kind, str) or kind not in _KINDS:
        raise ValueError("稿件类型必须是 script、outline、analysis、novel、document 或 internal")
    name = name.strip()
    with closing(plugin_db("jubao-drama")) as conn:
        _tables(conn)
        # 同时到达的相同保存也只能建立一个版本；文件导出放在事务完成后。
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT d.id FROM agent_documents d LEFT JOIN agent_document_delivery e ON e.document_id=d.id "
            "WHERE d.session_id=? AND d.agent_id=? AND d.name=? AND d.content=? "
            "AND COALESCE(e.kind,'document')=? ORDER BY d.rowid LIMIT 1",
            (session_id, agent_id, name, content, kind),
        ).fetchone()
        identifier = row[0] if row else uuid4().hex
        if row is None:
            conn.execute("INSERT INTO agent_documents VALUES (?,?,?,?,?)",
                         (identifier, session_id, agent_id, name, content))
            conn.execute("INSERT INTO agent_document_delivery(document_id,kind) VALUES (?,?)", (identifier, kind))
        conn.commit()
    return identifier


def _export(document, session_id, agent_id):
    """文件写入及安全读取均在数据库连接外执行，避免安全作用域查询互锁。"""
    folder = get_hermes_home() / "workspace" / "agents" / agent_id / hashlib.sha256(session_id.encode()).hexdigest()[:24]
    stem = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", document["name"]).strip(" .")[:60] or "稿件"
    try:
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        target = folder / (stem + "-" + document["id"][:8] + "-" + uuid4().hex[:8] + ".docx")
        receipt = {
            **export_script(document["content"], target, document_kind="document" if document["kind"] in {"analysis", "novel"} else document["kind"]),
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
        rows = conn.execute(
            "SELECT d.id,d.name,drama_document_metadata(d.content,d.name),COALESCE(e.kind,'document') "
            "FROM agent_documents d LEFT JOIN agent_document_delivery e ON e.document_id=d.id "
            f"WHERE {where} ORDER BY d.rowid DESC LIMIT ? OFFSET ?", (*parameters, limit, offset),
        ).fetchall()
    documents = [{"id": identifier, "name": name, "kind": kind, **json.loads(metadata)}
                 for identifier, name, metadata, kind in rows]
    return directory_page(documents, offset=offset, total=total, snapshot_rowid=snapshot)


def document_action(args, session_id):
    agent_id = document_owner(session_id)
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
    identifier = _save(args, session_id, agent_id) if action == "save" else args.get("document_id")
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
    if action in {"save", "export"} and document["export_status"] in {"pending", "failed"}:
        _export(document, owner_session, agent_id)
        documents, project = _snapshot(owner_session, agent_id, identifier)
        document = next(row for row in documents if row["id"] == identifier)
    metadata = document_metadata(document)
    result = {"ok": document["export_status"] != "failed", "document": metadata,
              "project": project_summary(session_id, agent_id, [metadata], project["exports"])}
    if action == "read":
        result.update(document_page(document, args))
    receipt = next((row for row in project["exports"] if row["artifact_id"] == identifier), None)
    if receipt:
        result["receipt"] = {**receipt, **receipt_scopes(receipt)}
        result["project"]["exports"] = [result["receipt"]]
    if document.get("export_error"):
        result.update(saved=True, export_status="failed", export_error=document["export_error"])
    return result

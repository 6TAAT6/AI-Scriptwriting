"""从真实会话正文补齐稿件交付；不调用模型、不改写历史或创作内容。"""

from contextlib import closing
import hashlib
import json
import re

from hermes_constants import get_hermes_home
from plugins.plugin_storage import plugin_db

from .agent_documents import _documents, _receipt_is_valid, _tables, _reading_scope, document_action
from .agent_document_delegation import delegated_document_ids
from .agent_profiles import AGENT_PROFILES
from .capability_selection import invocation_commands, document_owner


_KIND_WORDS = (
    ("analysis", r"(?:剧情|原剧|故事|人物|情节|结构)分析|分析报告|核心期待|创作依据"),
    ("outline", r"大纲|分集提纲|故事梗概"),
    ("novel", r"小说|第[零〇一二三四五六七八九十百千\d]+[章节回]"),
    ("script", r"剧本(?:正文)?|正文(?:剧本)?"),
    ("document", r"项目档案|项目介绍|人物设定|人物小传|角色档案|世界观(?:设定|规则)?|创作方案|伏笔登记表|故事设定|(?:审稿|审读|审核)报告"),
)
_NO_DOCUMENT = re.compile(r"建议|下一步|操作说明|格式说明|使用说明|写作技巧|教程|是什么|如何|创作笔记|内部|工具|下载|交付文件|进度")
_CONTROL_HEADING = re.compile(r"(?:Step\s*\d|S\d\s*.*前置|灵感碎片|快速启动|已有材料|总控自检报告)|^(?:进入|调用|请选择|请确认|等待确认|需要你确认)", re.I)
_EPISODE = re.compile(r"^第[零〇一二三四五六七八九十百千\d]+集(?:\s|[:：·—-]|$)")
_SCENE = re.compile(r"^\d+\s*[-—－]\s*\d+\s*场?(?:\s|$)")
# 只有明确控制标题才结束文稿；“下一步，她……”这类叙事句必须完整保留。
_TAIL = re.compile(r"^(?:下一步|后续建议|建议下一步|可选方向|创作笔记|交接摘要|内部记录|当前完成情况|Word\s*交付文件|下载(?:链接|文件)|已生成\s*Word|本批(?:已完成|完成情况)|请(?:选择|确认是否继续))(?:\s*[:：]|\s*$)")
_TYPE_CAPTIONS = {
    "analysis": {"剧情分析", "原剧分析", "故事分析", "人物分析", "情节分析", "结构分析", "分析报告", "核心期待", "创作依据"},
    "outline": {"大纲", "分集大纲", "分集提纲", "叙事大纲", "故事梗概"},
    "script": {"剧本", "剧本正文", "正文", "剧本初稿"},
    "novel": {"小说", "小说正文", "小说初稿"},
    "document": {"项目档案", "项目介绍", "人物设定", "人物小传", "角色档案", "世界观", "世界观设定", "世界观规则", "创作方案", "故事设定", "伏笔登记表"},
}


def _source_tables(conn):
    _tables(conn)
    conn.execute("CREATE TABLE IF NOT EXISTS agent_document_sources (session_id TEXT NOT NULL, "
                 "agent_id TEXT NOT NULL, source_id TEXT NOT NULL, response_sha256 TEXT NOT NULL, "
                 "document_ids TEXT NOT NULL, PRIMARY KEY(session_id,agent_id,source_id))")
    conn.execute("CREATE TABLE IF NOT EXISTS agent_document_checks (document_id TEXT PRIMARY KEY, "
                 "receipt_sha256 TEXT NOT NULL, file_signature TEXT NOT NULL)")
    conn.commit()


def _history(session_id):
    state = get_hermes_home() / "state.db"
    if not state.is_file():
        return []
    from hermes_state import SessionDB
    with closing(SessionDB(state, read_only=True)) as database:
        return database.get_messages(session_id, include_compacted=True, include_ancestors=True)


def _owner(session_id):
    if not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 256:
        raise ValueError("稿件交付必须绑定有效会话")
    try:
        return document_owner(session_id)
    except PermissionError:
        return None


def _activation_time(session_id, agent_id):
    """当前绑定只能证明此刻启用，不能把启用之前的消息归给当前 Agent。"""
    with closing(plugin_db("jubao-drama")) as conn:
        row = conn.execute(
            "SELECT updated_at FROM drama_agent_sessions WHERE session_id=? AND agent_id=?",
            (session_id, agent_id),
        ).fetchone()
    return float(row[0]) if row and row[0] is not None else None


def _verify_exports(documents, exports, budget=32):
    from pathlib import Path

    document_by_id = {item["id"]: item for item in documents}
    valid, checks, invalid = [], [], []
    with closing(plugin_db("jubao-drama")) as conn:
        _source_tables(conn)
        cached = {row[0]: row[1:] for row in conn.execute("SELECT document_id,receipt_sha256,file_signature FROM agent_document_checks")}
    for receipt in reversed(exports):
        identifier = receipt["artifact_id"]
        document = document_by_id[identifier]
        try:
            stat = Path(receipt["path"]).stat()
            signature = json.dumps([stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns])
        except OSError:
            signature = "missing"
        fingerprint = (receipt.get("sha256"), signature)
        if cached.get(identifier) == fingerprint:
            valid.append(receipt)
            continue
        if budget <= 0:
            document["export_status"] = "pending"
            continue
        budget -= 1
        if _receipt_is_valid(document, receipt):
            checks.append((identifier, *fingerprint))
            valid.append(receipt)
        else:
            document["export_status"] = "failed"
            document["export_error"] = "已导出的 Word 文件缺失或内容校验失败，请重试导出"
            invalid.append((document["export_error"], identifier, json.dumps(receipt, ensure_ascii=False)))
    with closing(plugin_db("jubao-drama")) as conn:
        _source_tables(conn)
        conn.executemany("INSERT INTO agent_document_checks VALUES (?,?,?) ON CONFLICT(document_id) DO UPDATE "
                         "SET receipt_sha256=excluded.receipt_sha256,file_signature=excluded.file_signature", checks)
        conn.executemany("UPDATE agent_document_delivery SET receipt=NULL,export_error=? WHERE document_id=? AND receipt=?", invalid)
        conn.commit()
    return list(reversed(valid))


def _snapshot(session_id, agent_id, messages=None):
    if not agent_id:
        return {"ok": True, "documents": [], "project": None}
    rows = _history(session_id) if messages is None else messages
    # 祖先范围只采用原生展示读取已验证过的压缩链，不沿任意 parent 跨分支。
    sessions = list(dict.fromkeys([str(row["session_id"]) for row in rows if row.get("session_id")] + [session_id]))
    sessions = [item for item in sessions if _owner(item) == agent_id]
    granted = delegated_document_ids(agent_id, _reading_scope(session_id, agent_id))
    documents, exports, metadata = [], [], {}
    with closing(plugin_db("jubao-drama")) as conn:
        _source_tables(conn)
        for identifier in sessions:
            saved, receipts = _documents(conn, identifier, agent_id)
            for source_id, digest, ids in conn.execute(
                "SELECT source_id,response_sha256,document_ids FROM agent_document_sources "
                "WHERE session_id=? AND agent_id=? ORDER BY rowid", (identifier, agent_id),
            ):
                for document_id in json.loads(ids):
                    metadata[document_id] = {"source_message_id": source_id, "source_response_sha256": digest}
            documents.extend(saved)
            exports.extend(receipts)
        if granted:
            delivered = conn.execute('SELECT id,session_id FROM agent_documents WHERE id IN ('
                                     + ','.join('?' for _ in granted) + ') AND agent_id=?', (*granted, agent_id)).fetchall()
            for document_id, child_session in delivered:
                saved, receipts = _documents(conn, child_session, agent_id, document_id)
                documents.extend(saved)
                exports.extend(receipts)
    for document in documents:
        document.update(metadata.get(document["id"], {}))
    exports = _verify_exports(documents, exports)
    project = {"id": "agent-" + hashlib.sha256((agent_id + ":" + session_id).encode()).hexdigest()[:24],
               "title": documents[0]["name"] if documents else "创作稿件", "stage": "skill",
               "agent_id": agent_id, "artifacts": documents, "exports": exports}
    return {"ok": True, "documents": documents, "project": project}


def session_documents(session_id):
    """读取当前 profile、当前 Agent 的权威稿件及合法压缩祖先，保留旧版本。"""
    return _snapshot(session_id, _owner(session_id))


def _heading(line):
    stripped = line.strip()
    match = re.match(r"^(#{1,6})\s*(.+?)\s*#*\s*$", stripped)
    if match:
        return len(match[1]), match[2].strip("* 【】")
    if re.fullmatch(r"\*\*[^\n]+\*\*", stripped):
        return 2, stripped.strip("* ")
    if re.fullmatch(r"【[^\n]+】", stripped):
        return 2, stripped[1:-1]
    if re.match(r"^[一二三四五六七八九十\d]+[、．.]\s*", stripped) and (_kind(stripped) or _NO_DOCUMENT.search(stripped)):
        return 2, stripped
    return None


def _delivery_heading(title):
    label = re.sub(r"^[一二三四五六七八九十\d]+[、．.]\s*", "", title).replace("**", "").strip()
    return bool(re.match(r"^(?:来源确认|合并交付|稿件交付|正文交付|文件交付|交付说明|核对关键台词)\s*[:：]", label))


def _kind(title):
    if _NO_DOCUMENT.search(title) or _CONTROL_HEADING.search(title) or _delivery_heading(title):
        return None
    # 包含“剧本正文”的核查结果仍是工具/分析说明，不据标题里的产物词补存为剧本。
    if re.search(r"(?:回读|读取|核查|核对|检查).{0,12}(?:结果|报告|说明|记录|清单)", title):
        return None
    if re.search(r"(?:审稿|审读|审核)报告", title):
        return "document"
    kinds = [kind for kind, pattern in _KIND_WORDS if re.search(pattern, title)]
    if len(kinds) > 1 and re.search(r"与|及|和|、|/|&", title):
        return None
    return kinds[0] if kinds else None


def _plain_line(line):
    heading = _heading(line)
    return heading[1] if heading else line.strip()


def _type_caption(line, kind):
    label = _plain_line(line).strip(" :：")
    label = re.sub(r"^[一二三四五六七八九十\d]+[、．.]\s*", "", label)
    label = re.sub(r"^第[零〇一二三四五六七八九十百千\d]+批(?:次)?\s*", "", label)
    return label in _TYPE_CAPTIONS.get(kind, set())


def _delivery_notification(line):
    text = line.strip()
    introduction = re.match(r"^我是巨豹智能体[，,。]", text) and re.search(r"当前已启用|/help.*可(?:查看|用)|可用命令", text)
    notification = (re.match(r"^(?:[一二三四五六七八九十\d]+份|本批|本轮|以上|这些|所有|四类|上述)", text)
                    and re.search(r"(?:已|已经|均).{0,60}(?:保存|生成|导出)", text)
                    and re.search(r"Word|\.docx|稿件栏.*下载|右侧.*下载", text))
    return bool(introduction or notification)


def _clean(text):
    text = re.sub(r"```studio-suggestions\b[^\n]*\n[\s\S]*?(?:```|$)", "", text)
    lines = []
    source_lines = text.splitlines()
    for index, line in enumerate(source_lines):
        standalone = (index == 0 or not source_lines[index - 1].strip()) and (index + 1 == len(source_lines) or not source_lines[index + 1].strip())
        if standalone and _delivery_notification(line):
            continue
        heading = _heading(line)
        label = heading[1] if heading else line.strip().strip("* ")
        label = re.sub(r"^[一二三四五六七八九十\d]+[、．.]\s*", "", label)
        if heading and _CONTROL_HEADING.search(label):
            break
        if _TAIL.match(label) and (heading or _TAIL.fullmatch(label)):
            break
        # 文件链接和导出通知是界面操作，不进入正式文稿。
        if re.search(r"\[[^\]]+\]\([^\n]*\.(?:docx|xlsx)(?:[?#][^)]*)?\)", line):
            continue
        if line.strip() in {"---", "***", "___", "```", "```text", "```markdown"}:
            continue
        lines.append(line.rstrip())
    return "\n".join(lines).strip()


def _normalise_for_dedupe(content, kind):
    """只比较排版与标题包装的差异，正文中任何真实修订都保留新版本。"""
    lines = _clean(content.replace("\r\n", "\n").replace("\r", "\n")).splitlines()
    if lines and _type_caption(lines[0], kind):
        lines = lines[1:]
    normalized = []
    for line in lines:
        if not line.strip():
            continue
        value = _plain_line(line)
        value = re.sub(r"\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`", lambda match: next(part for part in match.groups() if part is not None), value)
        value = re.sub(r"^[-*+]\s+", "", value)
        value = re.sub(r"(?<=[\u3400-\u9fff])\s+|\s+(?=[\u3400-\u9fff])", "", value)
        normalized.append(value)
    return "\n".join(normalized).strip()


def _same_delivered_title(saved_name, displayed_name):
    """同轮已声明交付的同名作品按实际回执读取，不把介绍性复述当成新版本。"""
    version = re.compile(r"v\d+(?:\.\d+)*", re.I)
    saved_versions, displayed_versions = version.findall(saved_name), version.findall(displayed_name)
    if saved_versions and displayed_versions and saved_versions != displayed_versions:
        return False
    def key(value):
        return re.sub(r"[^\w\u3400-\u9fff]", "", version.sub("", value)).replace("_", "")
    displayed = key(displayed_name)
    parts = [key(part) for part in saved_name.removesuffix(".docx").split("_")]
    if len(parts) == 1:
        return parts[0] == displayed
    position = 0
    for part in parts:
        found = displayed.find(part, position)
        if not part or found < 0:
            return False
        position = found + len(part)
    return True


def _saved_body_with_delivery_notes(manuscript, saved_content):
    """全文前缀后仅有说明返回True，有新内容返回False；不匹配返回None。"""
    kind = manuscript["kind"]
    expected = _normalise_for_dedupe(manuscript["content"], kind)
    saved = _normalise_for_dedupe(saved_content, kind)
    if not saved:
        return None
    title = _normalise_for_dedupe(manuscript["name"], kind)
    # 抽取器保留的显示标题不是正文，只有它与候选自己的标题完全一致才去掉。
    candidates = [expected]
    if title and expected.startswith(title + "\n"):
        candidates.append(expected[len(title) + 1:])
    matched = next((body for body in candidates if body == saved or body.startswith(saved + "\n")), None)
    if matched is None:
        return None
    notes = matched[len(saved):].strip()
    if not notes:
        return True
    heading_words = r"(?:系统|字数|汉字|字符|段落|统计|核验|校验|回执|文件|导出|交付|状态|说明|结果|检查|范围|口径|限制|与|和|及|、|Word|WPS|\s)+"
    for line in notes.splitlines():
        line = line.strip()
        if not line:
            continue
        if (_EPISODE.match(line) or _SCENE.match(line) or line.startswith(("△", "▲"))
                or re.match(r"^第[零〇一二三四五六七八九十百千\d]+[章回]", line)):
            return False
        count = (re.match(r"^(?:汉字数|非空白字符数|字符总数|总字符数|字数|段落数|非空顶层正文段落)[:：]", line)
                 and re.search(r"\d", line))
        status = (re.match(r"^(?:回执|检查|校验|导出|文件|文档|格式|版式|排版|WPS|内容回读)(?:(?:与|和|及)?(?:回执|检查|校验|核验|验收|实机|状态|限制|结果|范围|说明|文件|正文)){0,4}[:：]", line)
                  and re.search(r"通过|失败|未(?:执行|检查|核验|验收)|草稿|passed|not_checked|draft", line))
        introduction = re.match(r"^(?:依据|根据|按|以下).{0,24}(?:工具|回执|系统统计|统计证据).*(?:统计|证据|回执|口径)", line)
        download = (re.match(r"^(?:独立|本批|本轮|本篇|当前|上述|这份|该)?(?:Word(?:文件|文档|稿件)?|文档|文件|稿件)(?=《|「|“|已|可|[:：])", line)
                    and re.search(r"已生成|已保存|已导出|可.{0,30}(?:阅读|下载)", line))
        if not (count or status or introduction or download or re.fullmatch(heading_words, line)):
            return False
    return True


def _manuscripts(response, user_message=""):
    text = _clean(response)
    # 交付摘要不是新正文。它与同轮真实工具回执的关联由历史协调器完成。
    summary = bool(re.match(r"^(?:本批|这批|本轮|这份|上述|已)?[\s\S]{0,50}?(?:已经|已)(?:完成并)?(?:保存|生成|导出)|^(?:稿件|文件)(?:已|已经)", text)
                   and re.search(r"Word|\.docx|右侧|资料栏|下载", text[:300]))
    has_manuscript_heading = any(_kind(heading[1]) for line in text.splitlines() if (heading := _heading(line)))
    # 核对结果里的场头、末句台词只是摘录；新正文仍须有独立稿件标题或直接正文结构。
    verification_summary = (re.match(r"^(?:已|以下|核对|读取|检查)", text)
                            and re.search(r"(?:读取|核对|检查).{0,16}(?:结果|如下)|(?:根据|依据).{0,24}(?:读取核对|核对)", text[:160])
                            and re.search(r"(?m)^\s*\d+[.、．]\s*(?:集数|字符|字数|第.{0,10}集|场头|末句|总计)", text))
    if verification_summary and not has_manuscript_heading:
        return []
    if summary and not has_manuscript_heading:
        return []
    lines = text.splitlines()
    if not has_manuscript_heading and any(_delivery_heading(line) for line in lines) and not any(_SCENE.match(_plain_line(line)) for line in lines):
        return []
    headings = []
    for index, line in enumerate(lines):
        heading = _heading(line)
        if heading:
            headings.append((index, heading[0], heading[1], _kind(heading[1])))
    boundaries = []
    for position, item in enumerate(headings):
        start, level, name, kind = item
        if not kind:
            continue
        end = next((row[0] for row in headings[position + 1:] if row[1] <= level and row[3]), len(lines))
        descendants = {row[3] for row in headings[position + 1:] if row[0] < end and row[3]}
        if descendants - {kind}:
            continue
        if boundaries and start < boundaries[-1][4]:
            continue
        boundaries.append((start, level, name, kind, end))
    if boundaries:
        manuscripts = []
        for start, _, name, kind, end in boundaries:
            content = _clean("\n".join(lines[start:end]))
            body = "\n".join(content.splitlines()[1:]).strip()
            if len(body) >= 40:
                if kind == "script":
                    source = body if _type_caption(lines[start], kind) else content
                    content = "\n".join(_plain_line(line) for line in source.splitlines())
                manuscripts.append({"name": name[:120], "content": content, "kind": kind})
        if manuscripts:
            return manuscripts
    lines = [_plain_line(line) for line in lines]
    start = next((i for i, line in enumerate(lines) if _EPISODE.match(line) or _SCENE.match(line)), None)
    if start is not None:
        content = "\n".join(lines[start:]).strip()
        script = any(_SCENE.match(line.strip()) for line in lines[start:])
        if len(content) >= 60 and script:
            episodes = [line.strip() for line in lines[start:] if _EPISODE.match(line.strip())]
            name = (episodes[0] + ("至" + episodes[-1] if len(episodes) > 1 else "")) if episodes else lines[start].strip()
            return [{"name": name[:100] + " 剧本正文", "content": content, "kind": "script"}]
    chapter = next((i for i, line in enumerate(lines) if re.match(r"^第[零〇一二三四五六七八九十百千\d]+[章回]", line.strip())), None)
    if chapter is not None and len("\n".join(lines[chapter:])) >= 80:
        return [{"name": lines[chapter].strip()[:100], "content": "\n".join(lines[chapter:]).strip(), "kind": "novel"}]
    user = user_message.rsplit("【用户本轮消息】", 1)[-1] if isinstance(user_message, str) else ""
    # 无明确产物标题时，只接纳明确创作请求后的多段长正文，问答与操作建议不触发。
    requested = _kind(user[:500])
    if requested and re.search(r"生成|撰写|续写|改写|写出|输出|请分析|分析一下", user) and len(text) >= 160 and text.count("\n") >= 2:
        if not re.match(r"^(?:请|需要你|无法|不能|建议|你可以|我可以|要不要|如何|什么是)", text) and not _CONTROL_HEADING.search(text):
            return [{"name": {"analysis": "剧情分析", "outline": "分集大纲", "script": "剧本正文", "novel": "小说正文", "document": "创作资料"}[requested], "content": text, "kind": requested}]
    return []


def _auto_capture_allowed(user_message):
    """只采用本轮直接保存意图；引用、附件和对白不改变自动交付权限。"""
    if not isinstance(user_message, str):
        return True
    marker = "\n\n【用户本轮消息】\n"
    body = user_message.split(marker, 1)[1] if user_message.startswith("【本轮语言偏好】\n") and marker in user_message else user_message
    body = re.split(r"\n\n--- (?:Attached Context|Context Warnings) ---", body, maxsplit=1)[0]
    body = re.sub(r"(?ms)^[ \t]*(`{3,}|~{3,})[^\n]*\n.*?(?:^[ \t]*\1[ \t]*$|\Z)", "", body)
    body = re.sub(r'(?:撤回|取消)(?:刚才|之前)?[“「"](?:不保存|不另存|只读|不导出)[”」"](?:的)?(?:要求|限制|指令)', "撤回不保存要求", body)
    body = re.sub(r'“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|`[^`\n]*`', "", body)
    lead = r"(?:(?:本|这(?:一)?)(?:轮|次)|当前|最后|现在|请|并且|并|也|且|但是|但|改为|需要|可以|允许|然后|随后|直接|务必|帮我)"
    directives = []
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith((">", "@file:", "△")):
            continue
        # 角色名开头的冒号行是原稿，不是对当前任务的直接要求。
        if re.match(r"^[^\s:：。！？!?；;，,、]{1,16}[:：]", line) and not re.match(rf"^(?:{lead}|要求|任务|注意|修改|补充)", line):
            continue
        for sentence in re.split(r"[。！？!?；;\n]", line):
            if re.search(r"[:：]", sentence):
                heading, quoted = re.split(r"[:：]", sentence, maxsplit=1)
                label = re.sub(rf"^(?:{lead}\s*)*", "", heading.strip())
                # “本轮要求：”引出直接要求；其他冒号后的材料或对白不提升为新指令。
                sentence = quoted if label in {"", "要求", "任务", "注意", "修改", "补充"} else heading
            directives.extend(re.split(r"[，,、]", sentence))
    allowed = True
    for clause in directives:
        clause = re.sub(r"^\s*(?:[-*+]\s+|\d+[.、]\s*)", "", clause).strip()
        if not clause:
            continue
        direct = re.sub(rf"^(?:{lead}\s*)*", "", clause)
        if re.match(r"(?:撤回|取消).{0,12}(?:不保存|不另存|只读|不导出)(?:的)?(?:要求|限制|指令)?", direct):
            allowed = True
            continue
        direct = re.sub(r"^(?:不改稿|不重写|不要改稿|不要重写)(?:也|且|并)?", "", direct)
        denied = re.match(r"(?:不要|不再|不用|无需|禁止|不得|不)(?:再|另行|自动|重新)?(?:保存|另存|存稿|导出|生成(?:新)?(?:稿件|文档|文件|Word))", direct)
        readonly = re.match(r"(?:只读|仅(?:做)?(?:读取|阅读|核查|核对|检查|分析|查看)|只(?:做)?(?:读取|阅读|核查|核对|检查|分析|查看))", direct)
        if denied or readonly:
            allowed = False
        elif re.match(r"(?:保存|另存|导出|生成.{0,8}(?:文档|文件|Word)|(?:把|将)[^:：]*(?:保存|另存|导出|生成.{0,8}(?:文档|文件|Word)))", direct):
            allowed = True
    return allowed


def _capture_ids(session_id, owner, assistant_response, source_id, user_message, scope_sessions=None, preferred_ids=()):
    if not isinstance(assistant_response, str) or len(assistant_response) > 1_000_000:
        raise ValueError("交付正文必须是文本且不超过一百万字符")
    digest = hashlib.sha256(assistant_response.encode()).hexdigest()
    source_id = str(source_id or digest)
    if len(source_id) > 256:
        raise ValueError("稿件来源编号过长")
    with closing(plugin_db("jubao-drama")) as conn:
        _source_tables(conn)
        processed = conn.execute("SELECT response_sha256 FROM agent_document_sources WHERE session_id=? AND agent_id=? AND source_id=?",
                                 (session_id, owner, source_id)).fetchone()
    if processed and processed[0] == digest:
        return []
    if not _auto_capture_allowed(user_message):
        _store_source(session_id, owner, source_id, digest, [])
        return []
    captured = []
    scope_sessions = list(scope_sessions or [session_id])
    for manuscript in _manuscripts(assistant_response, user_message):
        # 模型已保存的同一正文复用真实稿件，不因兜底命名不同重复建立版本。
        with closing(plugin_db("jubao-drama")) as conn:
            placeholders = ",".join("?" for _ in scope_sessions)
            saved_rows = conn.execute("SELECT d.id,d.session_id,d.content,COALESCE(e.kind,'document'),d.name FROM agent_documents d LEFT JOIN agent_document_delivery e ON e.document_id=d.id "
                                    f"WHERE d.session_id IN ({placeholders}) AND d.agent_id=? "
                                    "AND COALESCE(e.kind,'document')!='internal' ORDER BY d.rowid",
                                    (*scope_sessions, owner)).fetchall()
        expected = _normalise_for_dedupe(manuscript["content"], manuscript["kind"])
        existing = next((row for row in saved_rows if row[3] == manuscript["kind"]
                         and _normalise_for_dedupe(row[2], row[3]) == expected), None)
        if existing is None and expected:
            # 同轮正式工具稿可能包含多个子章节；其正文不因展示拆节重复变成独立稿。
            existing = next((row for row in saved_rows if row[0] in preferred_ids
                             and expected in _normalise_for_dedupe(row[2], manuscript["kind"])), None)
        if existing is None:
            existing = next((row for row in saved_rows if row[0] in preferred_ids and row[3] == manuscript["kind"]
                             and _saved_body_with_delivery_notes(manuscript, row[2])), None)
        declared_delivery = re.search(r"已.{0,25}(?:保存|生成|导出)", assistant_response[:500])
        content_structure = any(_SCENE.match(line) or _EPISODE.match(line)
                                or re.match(r"^第[零〇一二三四五六七八九十百千\d]+[章回]", line)
                                for line in expected.splitlines())
        if existing is None and declared_delivery and not content_structure:
            existing = next((row for row in saved_rows if row[0] in preferred_ids and row[3] == manuscript["kind"]
                             and _same_delivered_title(row[4], manuscript["name"])
                             and _saved_body_with_delivery_notes(manuscript, row[2]) is not False), None)
        if _owner(session_id) != owner:
            raise PermissionError("当前会话的 Agent 已变化，请重新读取稿件")
        args = {"action": "export", "document_id": existing[0]} if existing else {"action": "save", **manuscript}
        saved = document_action(args, existing[1] if existing else session_id)
        captured.append(saved["document"]["id"])
    _store_source(session_id, owner, source_id, digest, captured)
    return captured


def _store_source(session_id, owner, source_id, digest, identifiers):
    with closing(plugin_db("jubao-drama")) as conn:
        _source_tables(conn)
        conn.execute("INSERT INTO agent_document_sources VALUES (?,?,?,?,?) ON CONFLICT(session_id,agent_id,source_id) "
                     "DO UPDATE SET response_sha256=excluded.response_sha256,document_ids=excluded.document_ids",
                     (session_id, owner, str(source_id), digest, json.dumps(list(dict.fromkeys(identifiers)))))
        conn.commit()


def _tool_document_ids(row, allowed_documents):
    if (row.get("tool_name") or row.get("name")) != "drama_agent_document":
        return []
    try:
        raw = row.get("content")
        if isinstance(raw, str) and raw.startswith("<persisted-output>"):
            raw = _read_spillover_receipt(raw)
        value = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, OSError):
        return []
    if not isinstance(value, dict) or value.get("ok") is False and not value.get("saved"):
        return []
    document, receipt = value.get("document"), value.get("receipt")
    identifiers = []
    if isinstance(document, dict):
        identifiers.append(document.get("id"))
    if isinstance(receipt, dict):
        identifiers.append(receipt.get("artifact_id") or receipt.get("document_id"))
    # project 是历史快照，不能把其中所有旧版本误关联到本轮。
    return [identifier for identifier in dict.fromkeys(identifiers) if identifier in allowed_documents]


def _read_spillover_receipt(content):
    """仅读取真实工具行引用的本 profile 回执，逐级目录描述符拒绝链接替换。"""
    import os
    from pathlib import Path
    import stat

    from tools.tool_result_storage import extract_persisted_path, get_spillover_dir

    reference = extract_persisted_path(content)
    if not reference:
        return None
    candidate = Path(reference)
    if (candidate.parent != get_spillover_dir() or ".." in candidate.parts
            or not re.fullmatch(r"call_[A-Za-z0-9_-]+\.txt", candidate.name)
            or not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY")):
        return None
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open(get_hermes_home(), flags)
    try:
        for part in ("cache", "spillover"):
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(candidate.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            limit = 16 * 1024 * 1024
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
                return None
            data = handle.read(limit + 1)
            return data.decode("utf-8") if len(data) <= limit else None
    finally:
        os.close(directory)


def _retry_failed_exports(session_id, owner):
    with closing(plugin_db("jubao-drama")) as conn:
        _source_tables(conn)
        pending = conn.execute("SELECT d.id FROM agent_documents d JOIN agent_document_delivery e ON e.document_id=d.id "
                               "WHERE d.session_id=? AND d.agent_id=? AND e.receipt IS NULL AND e.kind!='internal'",
                               (session_id, owner)).fetchall()
    # 每次读取只修复少量未完成文件，成功文件不重新生成，避免旧会话首开长时间阻塞。
    for row in pending[:8]:
        document_action({"action": "export", "document_id": row[0]}, session_id)


def capture_response(session_id, assistant_response, *, source_id="", user_message=""):
    """保存受信任会话读取提供的正文；调用方必须先验证会话归属和助手消息来源。"""
    owner = _owner(session_id)
    if not owner:
        return {**_snapshot(session_id, None), "captures": []}
    captured = _capture_ids(session_id, owner, assistant_response, source_id, user_message)
    if _auto_capture_allowed(user_message):
        _retry_failed_exports(session_id, owner)
    result = session_documents(session_id)
    return {**result, "captures": [item for item in result["documents"] if item["id"] in captured]}


def reconcile_session_documents(session_id):
    """仅补存未处理的可展示助手正文，压缩摘要、工具过程和截断消息不参与。"""
    owner = _owner(session_id)
    if not owner:
        return {**_snapshot(session_id, None), "captures": []}
    messages = _history(session_id)
    origins = {session_id, *(row["session_id"] for row in messages if row.get("session_id"))}
    allowed_sessions = {origin for origin in origins if _owner(origin) == owner}
    with closing(plugin_db("jubao-drama")) as conn:
        _source_tables(conn)
        processed = {(row[0], row[1]): (row[2], json.loads(row[3])) for row in conn.execute(
            "SELECT session_id,source_id,response_sha256,document_ids FROM agent_document_sources WHERE agent_id=?", (owner,)
        ) if row[0] in allowed_sessions}
        allowed_documents = {row[0] for row in conn.execute(
            "SELECT d.id,d.session_id FROM agent_documents d LEFT JOIN agent_document_delivery e ON e.document_id=d.id "
            "WHERE d.agent_id=? AND COALESCE(e.kind,'document')!='internal'", (owner,)
        ) if row[1] in allowed_sessions}
    activated = {origin: _activation_time(origin, owner) for origin in allowed_sessions}
    user_message, selected, captured, candidates, turn_documents = "", None, [], [], []
    explicit_selection_seen = False
    document_actions = {}
    for row in messages:
        text = row.get("content")
        if text is None and row.get("role") == "assistant" and row.get("tool_calls"):
            text = ""
        if row.get("display_kind") or row.get("_compressed_summary") or not isinstance(text, str):
            continue
        if row.get("role") == "user":
            user_message = text
            turn_documents = []
            for action, key in invocation_commands(text):
                if key in AGENT_PROFILES:
                    selected = None if action == "停用" else key
                    explicit_selection_seen = True
            if not explicit_selection_seen:
                timestamp = row.get("timestamp")
                bound_at = activated.get(row.get("session_id", session_id))
                if isinstance(timestamp, (int, float)) and bound_at is not None and timestamp >= bound_at:
                    selected = owner
            continue
        origin = row.get("session_id", session_id)
        if row.get("role") == "assistant":
            calls = row.get("tool_calls") or []
            try:
                calls = json.loads(calls) if isinstance(calls, str) else calls
            except ValueError:
                calls = []
            for call in calls if isinstance(calls, list) else []:
                function = call.get("function", {}) if isinstance(call, dict) else {}
                if function.get("name") == "drama_agent_document" and call.get("id"):
                    args = function.get("arguments", {})
                    try:
                        args = json.loads(args) if isinstance(args, str) else args
                    except ValueError:
                        args = {}
                    if isinstance(args, dict):
                        document_actions[call["id"]] = args.get("action")
        if row.get("role") == "tool" and selected == owner and origin in allowed_sessions:
            if document_actions.get(row.get("tool_call_id")) not in {"read", "list"}:
                turn_documents.extend(_tool_document_ids(row, allowed_documents))
            continue
        if (row.get("role") != "assistant" or row.get("tool_calls") or selected != owner
                or origin not in allowed_sessions
                or row.get("finish_reason") in {"length", "content_filter", "error", "agent_error", "cancelled", "interrupted", "abort", "failed"}):
            continue
        source = str(row["id"])
        digest = hashlib.sha256(text.encode()).hexdigest()
        previous = processed.get((origin, source))
        if previous and previous[0] == digest and set(turn_documents).issubset(previous[1]):
            continue
        candidates.append((origin, text, source, user_message, list(dict.fromkeys(turn_documents)), previous[1] if previous else []))
    automatic_delivery = _auto_capture_allowed(user_message)
    # 最新交付优先，历史大会话逐次补偿；单次最多检查一百条未处理助手消息。
    for origin, text, source, request, linked, previous_ids in candidates[-100:]:
        # 当前只读轮次暂停历史补存，待用户恢复交付后再处理，不能标记旧正文已完成。
        if not automatic_delivery and _auto_capture_allowed(request):
            continue
        # 已保存的部分与最终回复新交付的其他类型合并，只有纯摘要不进入正文分类。
        created = _capture_ids(origin, owner, text, source, request, allowed_sessions, linked)
        identifiers = list(dict.fromkeys([*previous_ids, *linked, *created]))
        _store_source(origin, owner, source, hashlib.sha256(text.encode()).hexdigest(), identifiers)
        captured.extend(identifiers)
    if automatic_delivery:
        for origin in allowed_sessions:
            _retry_failed_exports(origin, owner)
    result = _snapshot(session_id, owner, messages)
    return {**result, "captures": [item for item in result["documents"] if item["id"] in captured]}


def on_session_end(*, session_id, completed=False, failed=False, interrupted=False, **_kwargs):
    # 原生 finalizer 已完成 transcript 持久化；只有本轮正常完成才自动补交付。
    if completed and not failed and not interrupted and _owner(session_id):
        reconcile_session_documents(session_id)

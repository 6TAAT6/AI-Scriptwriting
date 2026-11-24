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
from .child_readonly import is_readonly_child


_KIND_WORDS = (
    ("analysis", r"(?:剧情|原剧|故事|人物|情节|结构)分析|分析报告|核心期待|创作依据|(?:改编|平替)(?:修订)?方案|方案对比|方案与|诊断|解构|骨架|评估|定位分析"),
    ("outline", r"大纲|分集提纲|故事梗概"),
    ("novel", r"小说|第[零〇一二三四五六七八九十百千\d]+[章节回]"),
    # “原剧本”指来源稿；“剧本分析、剧本示范”等是分析稿里的小节，都不是新交付的剧本正文。
    ("script", r"(?<!原)剧本(?:正文)?(?!.{0,6}(?:分析|解构|骨架|诊断|评估|示范|方案|定位))|正文(?:剧本)?"),
    ("document", r"项目档案|项目介绍|人物设定|人物小传|角色档案|世界观(?:设定|规则)?|创作方案|伏笔登记表|故事设定|(?:审稿|审读|审核)报告"),
)
# 章节小标题（如“五、新纲与正文承接边界”“改编原则”）是说明文字，不是稿件标题。
_NO_DOCUMENT = re.compile(r"建议|下一步|操作说明|格式说明|使用说明|写作技巧|教程|是什么|如何|创作笔记|内部|工具|下载|交付文件|进度|边界|承接|原则|要点|注意事项")
_CONTROL_HEADING = re.compile(r"(?:Step\s*\d|S\d\s*.*前置|灵感碎片|快速启动|已有材料|总控自检报告)|^(?:进入|调用|请选择|请确认|等待确认|需要你确认)", re.I)
# 与核验口径（document_evidence._EPISODE_HEADING）一致：“第 1 集”“第 1 章”中间带空格同样是标题。
# 2026-11-23 测试版：只认“第1集”时，回复首行“第 1 集”被收尾补存切掉，稿件少一集、名称变成场次行。
_EPISODE = re.compile(r"^第[ \t]*[零〇一二三四五六七八九十百千两\d]+[ \t]*集(?:\s|[:：·—-]|$)")
_CHAPTER = re.compile(r"^第[ \t]*[零〇一二三四五六七八九十百千两\d]+[ \t]*[章回]")
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
    if agent_id == "independent-skills":
        from .capability_selection import skills_activated_at
        return skills_activated_at(session_id)
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
        # 校验策略更新后旧缓存必须重新回读一次；文件未变不能证明旧HTML导出正确。
        fingerprint = ('visible-word-v2:' + str(receipt.get("sha256")), signature)
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
    readonly = is_readonly_child(session_id)
    granted = [] if readonly else delegated_document_ids(agent_id, _reading_scope(session_id, agent_id))
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
    if not readonly:
        exports = _verify_exports(documents, exports)
    from .requirement_delivery import quality_summary
    documents=[{**document,**({'quality_check':quality_summary(document['quality_check'])}
                             if 'quality_check' in document else {})} for document in documents]
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
    # 回复开头单独成行的《作品名》标题（不带句号）视为整份稿件的标题。
    if re.fullmatch(r"《[^》\n]{1,30}》[^。\n]{0,40}", stripped):
        return 1, stripped
    # 编号条目带冒号说明（如“1. **不可替换的核心期待**：……”）是列表内容，不是稿件标题。
    if (re.match(r"^[一二三四五六七八九十\d]+[、．.]\s*", stripped) and not re.search(r"[：:]", stripped)
            and (_title_kind(stripped) or _NO_DOCUMENT.search(stripped))):
        return 2, stripped
    return None


def _delivery_heading(title):
    label = re.sub(r"^[一二三四五六七八九十\d]+[、．.]\s*", "", title).replace("**", "").strip()
    return bool(re.match(r"^(?:来源确认|合并交付|稿件交付|正文交付|文件交付|交付说明|核对关键台词)\s*[:：]", label))


def _title_kind(title):
    """回复里的标题：向用户提的问题、整句说明不是稿件标题（正式版曾把“3. 你打算融入哪些改编元素？”存成稿件）。"""
    if re.search(r"[？?]", title) or (len(title) > 30 and re.search(r"[，。；]", title)):
        return None
    return _kind(title)


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


# 模型常把进度说明和稿件标题写在同一行（“正在创作……剧本正文。第08集”），标题不在行首就认不出这一集。
_GLUED_HEADING = re.compile(r"^((?:正在|好的|下面|以下|现在|已)[^\n]{0,120}?[。：:！!])\s*(?=#{1,6}\s|\*{0,2}第\s*[0-9一二三四五六七八九十百零〇两]+\s*集|《)", re.M)


def split_glued_heading(text):
    return _GLUED_HEADING.sub(r"\1\n\n", text or "", count=1)


# 2026-11-19 测试版两次实测：Gemini 被上游背诵过滤截断（finish_reason=content_filter: recitation）时，
# 正文末尾留下 483—600 个“♯”，原样显示并进入稿件。正常稿件不会有 64 个以上同一符号连写，分隔线与表格线远短于此。
_SYMBOL_RUN = re.compile(r"([^\w\s])\1{63,}")
SYMBOL_RUN_NOTE = "（此处输出出现异常符号，已自动去除；如果内容没写完，可以让我接着写。）"


def strip_symbol_runs(text, note=""):
    """去掉同一符号的超长连写；note 只放在第一处，返回 (文本, 是否去除过)。"""
    marks = iter([note])
    cleaned = _SYMBOL_RUN.sub(lambda _match: next(marks, ""), text or "")
    if cleaned == (text or ""):
        return text, False
    return re.sub(r"[ \t]+(?=\n|$)", "", cleaned).strip(), True


def _clean(text):
    text = split_glued_heading(strip_symbol_runs(text)[0])
    text = re.sub(r"```studio-suggestions\b[^\n]*\n[\s\S]*?(?:```|$)", "", text)
    lines = []
    source_lines = text.splitlines()
    for index, line in enumerate(source_lines):
        if re.match(r"^\s*>?\s*【系统核验】", line):
            break  # 宿主在回复末尾追加的核验说明不是稿件内容
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
    # Word 文件名末尾的“_第N版”是版本号，不是标题的一部分。
    parts = [key(part) for part in re.sub(r"_第\d+版$", "", saved_name.removesuffix(".docx")).split("_")]
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
                or _CHAPTER.match(line)):
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


def _merge_numbered_sections(manuscripts, text):
    """“一、项目信息 / 二、人物设定 / 三、分集大纲”是同一份大纲或方案的各节，不拆成几份稿件；含剧本或小说正文时仍分开。"""
    if (len(manuscripts) < 2 or any(item["kind"] in {"script", "novel"} for item in manuscripts)
            or not all(re.match(r"^[一二三四五六七八九十]+、", item["name"]) for item in manuscripts)):
        return manuscripts
    kinds = {item["kind"] for item in manuscripts}
    kind = "outline" if "outline" in kinds else "analysis" if "analysis" in kinds else "document"
    title = (re.search(r"《[^》\n]{1,30}》", text) or [""])[0]
    label = {"outline": "分集大纲", "analysis": "分析方案", "document": "创作资料"}[kind]
    start = text.find(manuscripts[0]["content"].splitlines()[0])
    content = _clean(text[start:]) if start >= 0 else "\n\n".join(item["content"] for item in manuscripts)
    return [{"name": f"{title}{label}", "content": content, "kind": kind}]


def _manuscripts(response, user_message="", *, allow_fallback=True):
    text = _clean(response)
    # 交付摘要不是新正文。它与同轮真实工具回执的关联由历史协调器完成。
    summary = bool(re.match(r"^(?:本批|这批|本轮|这份|上述|已)?[\s\S]{0,50}?(?:已经|已)(?:完成并)?(?:保存|生成|导出)|^(?:稿件|文件)(?:已|已经)", text)
                   and re.search(r"Word|\.docx|右侧|资料栏|下载", text[:300]))
    has_manuscript_heading = any(_title_kind(heading[1]) for line in text.splitlines() if (heading := _heading(line)))
    # 核对结果里的场头、末句台词只是摘录；新正文仍须有独立稿件标题或直接正文结构。
    verification_summary = (re.match(r"^(?:已|以下|核对|读取|检查)", text)
                            and re.search(r"(?:读取|核对|检查).{0,16}(?:结果|如下)|(?:根据|依据).{0,24}(?:读取核对|核对)", text[:160])
                            and re.search(r"(?m)^\s*\d+[.、．]\s*(?:集数|字符|字数|第.{0,10}集|场头|末句|总计)", text))
    completion_summary = re.match(r"^(?:(?:本轮|本次|本批)(?:已经|已)(?:完成|修改|修订)|已(?:按|根据).{0,20}(?:完成|修改|修订))", text)
    if completion_summary and not has_manuscript_heading:
        return []
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
            headings.append((index, heading[0], heading[1], _title_kind(heading[1])))
    # 顶层分析方案包含梗概、世界观等子节，仍按整份方案核验与交付；明确分件时保留各组件。
    user = user_message.rsplit("【用户本轮消息】", 1)[-1] if isinstance(user_message, str) else ""
    separate = re.search(r"(?:分别|独立|各自|单独)[^。！？\n]{0,24}(?:交付|保存|文档|文件)|(?:交付|保存)[^。！？\n]{0,16}(?:两|三|四|\d+)份", user)
    # 总标题常写成“原作理解与戏剧资产分析”“平替改编方向方案”，关键词表认不出；只看子标题会把整篇拆成
    # “1. 故事梗概”“5. 核心期待”等几百字的碎片分别存稿（2026-11-19 测试版，正式版 11-08 起也有）。
    whole_title = bool(headings) and (headings[0][3] == "analysis" or (
        headings[0][3] is None and re.search(r"分析|方案|方向|评估|诊断|梳理|拆解|解析|报告|理解|对比", headings[0][2])
        and not re.search(r"[，。；？?！!]|[：:]$|确认|口径|问答|提问|问题", headings[0][2])))
    if whole_title and not separate:
        start, level, name, _ = headings[0]
        if (all(row[1] > level for row in headings[1:])
                and not any(row[3] in {"script", "novel"} for row in headings[1:])):
            content = _clean("\n".join(lines[start:]))
            if len("\n".join(content.splitlines()[1:]).strip()) >= 40:
                return [{"name": name[:120], "content": content, "kind": "analysis"}]
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
        merged = manuscripts if separate else _merge_numbered_sections(manuscripts, text)
        if merged:
            return merged
    lines = [_plain_line(line) for line in lines]
    start = next((i for i, line in enumerate(lines) if _EPISODE.match(line) or _SCENE.match(line)), None)
    if start is not None:
        content = "\n".join(lines[start:]).strip()
        script = any(_SCENE.match(line.strip()) for line in lines[start:])
        if len(content) >= 60 and script:
            # “第 5 集 雨夜”与“第5集 雨夜”起同样的名称，保存时才能按集号规范成“第05集”。
            episodes = [re.sub(r"^第[ \t]*([零〇一二三四五六七八九十百千两\d]+)[ \t]*集", r"第\1集", line.strip())
                        for line in lines[start:] if _EPISODE.match(line.strip())]
            name = (episodes[0] + ("至" + episodes[-1] if len(episodes) > 1 else "")) if episodes else lines[start].strip()
            return [{"name": name[:100] + " 剧本正文", "content": content, "kind": "script"}]
    chapter = next((i for i, line in enumerate(lines) if _CHAPTER.match(line.strip())), None)
    if chapter is not None and len("\n".join(lines[chapter:])) >= 80:
        return [{"name": lines[chapter].strip()[:100], "content": "\n".join(lines[chapter:]).strip(), "kind": "novel"}]
    user = user_message.rsplit("【用户本轮消息】", 1)[-1] if isinstance(user_message, str) else ""
    # 无明确产物标题时，只接纳明确创作请求后的多段长正文，问答与操作建议不触发。
    requested = _kind(user[:500])
    if allow_fallback and requested and re.search(r"生成|撰写|续写|改写|写出|输出|请分析|分析一下", user) and len(text) >= 160 and text.count("\n") >= 2:
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


def _capture_ids(session_id, owner, assistant_response, source_id, user_message, scope_sessions=None, preferred_ids=(), *, allow_create=True, reprocess_empty=False):
    if not isinstance(assistant_response, str) or len(assistant_response) > 1_000_000:
        raise ValueError("交付正文必须是文本且不超过一百万字符")
    digest = hashlib.sha256(assistant_response.encode()).hexdigest()
    source_id = str(source_id or digest)
    if len(source_id) > 256:
        raise ValueError("稿件来源编号过长")
    with closing(plugin_db("jubao-drama")) as conn:
        _source_tables(conn)
        processed = conn.execute("SELECT response_sha256,document_ids FROM agent_document_sources WHERE session_id=? AND agent_id=? AND source_id=?",
                                 (session_id, owner, source_id)).fetchone()
    if processed and processed[0] == digest and (not reprocess_empty or json.loads(processed[1])):
        return []
    if not _auto_capture_allowed(user_message):
        _store_source(session_id, owner, source_id, digest, [])
        return []
    captured = []
    scope_sessions = list(scope_sessions or [session_id])
    # 分析稿中的示例仍是同一交付。只有用户明确合并，并且完整示例确在实际已存稿中才复用。
    body = user_message.rsplit('【用户本轮消息】', 1)[-1] if isinstance(user_message, str) else ''
    body = re.sub(r'(?ms)^\s*```.*?^\s*```\s*$', '', body)
    one_analysis = bool(re.search(r'同一份.{0,20}(?:analysis|分析)|(?:analysis|分析).{0,20}同一份', body))
    for manuscript in _manuscripts(assistant_response, user_message):
        # 模型已保存的同一正文复用真实稿件，不因兜底命名不同重复建立版本。
        with closing(plugin_db("jubao-drama")) as conn:
            placeholders = ",".join("?" for _ in scope_sessions)
            saved_rows = conn.execute("SELECT d.id,d.session_id,d.content,COALESCE(e.kind,'document'),d.name FROM agent_documents d LEFT JOIN agent_document_delivery e ON e.document_id=d.id "
                                    f"WHERE d.session_id IN ({placeholders}) AND d.agent_id=? "
                                    "AND COALESCE(e.kind,'document')!='internal' ORDER BY d.rowid",
                                    (*scope_sessions, owner)).fetchall()
        expected = _normalise_for_dedupe(manuscript["content"], manuscript["kind"])
        if one_analysis and expected:
            contained = next((row for row in saved_rows if row[3] == 'analysis'
                              and expected in _normalise_for_dedupe(row[2], manuscript['kind'])), None)
            if contained:
                captured.append(contained[0])
                continue
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
                                or _CHAPTER.match(line)
                                for line in expected.splitlines())
        if existing is None and declared_delivery and not content_structure:
            existing = next((row for row in saved_rows if row[0] in preferred_ids and row[3] == manuscript["kind"]
                             and _same_delivered_title(row[4], manuscript["name"])
                             and _saved_body_with_delivery_notes(manuscript, row[2]) is not False), None)
        if existing is None and expected and len(expected) >= 200:
            # 结束前把关已把整批稿件（或合并后的返修稿）保存：回复里的片段、分节包含在已存稿件中时不另存一份。
            # 类型可能不同（分节的大纲片段会被识别成分析），按内容包含判断。
            existing = next((row for row in reversed(saved_rows) if row[3] != "internal"
                             and expected in _normalise_for_dedupe(row[2], row[3])), None)
        if existing is None and manuscript["kind"] in {row[3] for row in saved_rows if row[0] in preferred_ids}:
            # 本轮已用稿件工具交付同类稿件时，回复里的复述或小节不再另存：正文的小标题和说明句曾被误存为
            # “三、分集大纲”之类的多余稿件。未保存的其他类型（如只写在回复里的大纲）仍兜底保存。
            continue
        if (existing is None and preferred_ids and not content_structure
                and re.match(r"^[一二三四五六七八九十\d]+[、．.]", manuscript["name"])):
            # 本轮已用工具交付稿件时，回复里的编号条目是逐项核对说明（如“1. 反转钩子取消：……”），
            # 没有集、场、章结构时不当作以编号条目为标题的新稿件。
            continue
        if not allow_create:
            # 新链接管后仅建立 source 关系，不能保存、导出或重验任何版本。
            if existing is not None:
                captured.append(existing[0])
            continue
        if _owner(session_id) != owner:
            raise PermissionError("当前会话的 Agent 已变化，请重新读取稿件")
        args = {"action": "export", "document_id": existing[0]} if existing else {"action": "save", **manuscript}
        saved = document_action(args, existing[1] if existing else session_id, automatic_capture=True)
        captured.append(saved["document"]["id"])
    _store_source(session_id, owner, source_id, digest, captured)
    return captured


def _managed_turn_source_id(source):
    if not isinstance(source, dict):
        return None
    uid = source.get("message_uid")
    if isinstance(uid, str) and uid.strip():
        return "managed-turn:uid:" + uid.strip()
    row_id = source.get("message_row_id")
    if type(row_id) is int and row_id > 0:
        return "managed-turn:row:" + str(row_id)
    return None



def native_delivery_input(user_message, history):
    """只记宿主当前输入身份供禁用旧补存；不解析附件、不产生创作授权。"""
    from .task_requirement_extract import _text
    row = history[-1] if isinstance(history, list) and history else None
    if (not isinstance(row, dict) or row.get("role") != "user"
            or row.get("display_kind") or row.get("_compressed_summary")):
        return None
    # pre_llm_call 先于落盘，保留同一个原生行对象，接收持久层随后回写的 UID/row。
    texts = {_text(row.get("content")), _text(user_message)} - {""}
    return {"row": row, "input_hashes": {hashlib.sha256(text.encode()).hexdigest() for text in texts}}


def mark_managed_input(session_id, captured):
    """核对真实 UID/row 和输入摘要后仅阻止新创作链旧交付；OA6.1保留既有项目交付。"""
    from .agent_profiles import active_agent
    if active_agent(session_id) == "oa6-1":
        return False
    if not isinstance(captured, dict) or is_readonly_child(session_id):
        return False
    live = captured.get("row") or {}
    source_id = _managed_turn_source_id({"message_uid": live.get("message_uid"), "message_row_id": live.get("_row_id")})
    owner = _owner(session_id)
    if not source_id or not owner:
        return False
    for row in reversed(_history(session_id)):
        if row.get("role") != "user" or row.get("display_kind") or row.get("_compressed_summary"):
            continue
        identity = {"message_uid": row.get("message_uid"), "message_row_id": row.get("id")}
        if _managed_turn_source_id(identity) != source_id:
            continue
        origin = row.get("session_id", session_id)
        digest = hashlib.sha256(row["content"].encode()).hexdigest()
        if _owner(origin) != owner or digest not in captured.get("input_hashes", set()):
            return False
        _store_source(origin, owner, source_id, digest, [])
        return True
    return False


def mark_managed_turn(session_id, source):
    """新链只接管有原生身份且正文摘要核对通过的真实人类回合。"""
    owner = _owner(session_id)
    source_id = _managed_turn_source_id(source)
    if not owner or not source_id or not isinstance(source.get("text_sha256"), str):
        return False
    from .task_requirement_extract import source_for_turn
    for row in reversed(_history(session_id)):
        if row.get("role") != "user" or row.get("display_kind") or row.get("_compressed_summary"):
            continue
        identity = {"message_uid": row.get("message_uid"), "message_row_id": row.get("id")}
        if _managed_turn_source_id(identity) != source_id:
            continue
        origin = row.get("session_id", session_id)
        if _owner(origin) != owner:
            return False
        from hermes_state import SessionDB
        with closing(SessionDB(get_hermes_home() / "state.db", read_only=True)) as database:
            session_source = (database.get_session(origin) or {}).get("source")
        stored = {**row, "_row_id": row.get("id"), "_session_source": session_source}
        verified = source_for_turn(row.get("content"), [stored], source.get("turn_id") or "managed-native", allow_legacy=True)
        if not verified or verified["text_sha256"] != source["text_sha256"]:
            return False
        # 标记和助手来源共用已有账本；没有原生 UID/row 的测试状态仅使用内存拒绝记录。
        _store_source(origin, owner, source_id, hashlib.sha256(row["content"].encode()).hexdigest(), [])
        return True
    return False


def _managed_turn_markers(session_id, owner):
    with closing(plugin_db("jubao-drama")) as conn:
        _source_tables(conn)
        rows = conn.execute("SELECT source_id FROM agent_document_sources WHERE session_id=? AND agent_id=? AND source_id LIKE 'managed-turn:%'",
                            (session_id, owner)).fetchall()
    return {row[0] for row in rows}


def _managed_turn_for_row(row, markers):
    uid = row.get("message_uid") if isinstance(row, dict) else None
    if isinstance(uid, str) and "managed-turn:uid:" + uid in markers:
        return True
    row_id = row.get("id", row.get("_row_id")) if isinstance(row, dict) else None
    return type(row_id) is int and "managed-turn:row:" + str(row_id) in markers


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
        document_action({"action": "export", "document_id": row[0]}, session_id, automatic_capture=True)


def _capture_is_managed(session_id, owner, source_id):
    """仅由真实助手行或当前已核实的人类源识别回合，不猜用户文本。"""
    rows = _history(session_id)
    markers = {}
    managed = False
    for row in rows:
        origin = row.get("session_id", session_id)
        if origin not in markers:
            markers[origin] = _managed_turn_markers(origin, owner)
        if row.get("role") == "user" and not row.get("display_kind") and not row.get("_compressed_summary"):
            managed = _managed_turn_for_row(row, markers[origin])
        if row.get("role") == "assistant" and str(source_id) in {str(row.get("id")), str(row.get("message_uid"))}:
            return managed
    from .requirement_control import _current
    state = _current(session_id)
    source = ((state or {}).get("contract") or {}).get("source") or {}
    key = _managed_turn_source_id(source)
    return bool(key and any(key in values for values in markers.values()))


def capture_response(session_id, assistant_response, *, source_id="", user_message=""):
    """保存受信任会话读取提供的正文；调用方必须先验证会话归属和助手消息来源。"""
    owner = _owner(session_id)
    if is_readonly_child(session_id):
        return {**_snapshot(session_id, owner), "captures": []}
    from .plain_documents import OWNER
    if owner == OWNER:
        return {**_snapshot(session_id, owner), "captures": []}
    if not owner:
        return {**_snapshot(session_id, None), "captures": []}
    from .agent_profiles import AGENT_PROFILES
    if AGENT_PROFILES.get(owner, {}).get("own_protocol"):
        # 自带协议的 Agent 交付只在对话正文（Vee R8/R13），不自动存成稿件卡。
        return {**_snapshot(session_id, owner), "captures": []}
    managed = _capture_is_managed(session_id, owner, source_id)
    captured = _capture_ids(session_id, owner, assistant_response, source_id, user_message, allow_create=not managed)
    if not managed and _auto_capture_allowed(user_message):
        _retry_failed_exports(session_id, owner)
    result = session_documents(session_id)
    return {**result, "captures": [item for item in result["documents"] if item["id"] in captured]}


def reconcile_session_documents(session_id):
    """仅补存未处理的可展示助手正文，压缩摘要、工具过程和截断消息不参与。"""
    owner = _owner(session_id)
    if is_readonly_child(session_id):
        return {**_snapshot(session_id, owner), "captures": []}
    from .plain_documents import OWNER
    if owner == OWNER:
        return {**_snapshot(session_id, owner), "captures": []}
    if not owner:
        return {**_snapshot(session_id, None), "captures": []}
    from .agent_profiles import AGENT_PROFILES
    if AGENT_PROFILES.get(owner, {}).get("own_protocol"):
        # 自带协议的 Agent 交付只在对话正文（Vee R8/R13），不自动存成稿件卡。
        return {**_snapshot(session_id, owner), "captures": []}
    messages = _history(session_id)
    origins = {session_id, *(row["session_id"] for row in messages if row.get("session_id"))}
    allowed_sessions = {origin for origin in origins if _owner(origin) == owner}
    managed_markers = {origin: _managed_turn_markers(origin, owner) for origin in allowed_sessions}
    from .delivery_authorization import history_turns, recoverable_turns
    authorized_turns = history_turns(session_id)
    recoverable = recoverable_turns(session_id, authorized_turns)
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
    user_message, selected, captured, candidates, turn_documents, managed_turn = "", None, [], [], [], False
    explicit_selection_seen = False
    document_actions = {}
    for row in messages:
        text = row.get("content")
        if text is None and row.get("role") == "assistant" and row.get("tool_calls"):
            text = ""
        if row.get("display_kind") or row.get("_compressed_summary") or not isinstance(text, str):
            continue
        origin = row.get("session_id", session_id)
        if row.get("role") == "user":
            user_message = text
            turn_documents = []
            managed_turn = _managed_turn_for_row(row, managed_markers.get(origin, set()))
            for action, key in invocation_commands(text):
                if key in AGENT_PROFILES:
                    selected = None if action == "停用" else key
                    explicit_selection_seen = True
                elif owner == "independent-skills" and action != "停用":
                    # 只启用独立技能的对话：本条消息起的回复归独立技能稿件。
                    selected = owner
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
        if previous and previous[0] == digest and set(turn_documents).issubset(previous[1]) and (previous[1] or source not in recoverable):
            continue
        candidates.append((origin, text, source, user_message, list(dict.fromkeys(turn_documents)), previous[1] if previous else [], managed_turn))
    automatic_delivery = _auto_capture_allowed(authorized_turns[-1]["request"] if authorized_turns else user_message)
    # 最新交付优先，历史大会话逐次补偿；单次最多检查一百条未处理助手消息。
    for origin, text, source, request, linked, previous_ids, managed in candidates[-100:]:
        # 当前只读轮次暂停历史补存，待用户恢复交付后再处理，不能标记旧正文已完成。
        if not automatic_delivery and _auto_capture_allowed(request):
            continue
        # 已保存的部分与最终回复新交付的其他类型合并，只有纯摘要不进入正文分类。
        recovery = managed and source in recoverable and not linked
        created = _capture_ids(origin, owner, text, source, recoverable[source] if recovery else request, allowed_sessions, linked,
                               allow_create=not managed or recovery, reprocess_empty=recovery)
        identifiers = list(dict.fromkeys([*previous_ids, *linked, *created]))
        _store_source(origin, owner, source, hashlib.sha256(text.encode()).hexdigest(), identifiers)
        captured.extend(identifiers)
    if automatic_delivery and not managed_turn:
        for origin in allowed_sessions:
            _retry_failed_exports(origin, owner)
    result = _snapshot(session_id, owner, messages)
    return {**result, "captures": [item for item in result["documents"] if item["id"] in captured]}


def on_session_end(*, session_id, completed=False, failed=False, interrupted=False, **_kwargs):
    # 原生 finalizer 已完成 transcript 持久化；只有本轮正常完成才自动补交付。
    if completed and not failed and not interrupted and not is_readonly_child(session_id) and _owner(session_id):
        reconcile_session_documents(session_id)

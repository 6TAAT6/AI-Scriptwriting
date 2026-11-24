"""从当前用户消息应用创作能力选择；不修改会话的历史或系统提示。"""

from contextlib import closing
import json
import logging
import re
import sqlite3
import time

from hermes_constants import get_hermes_home
from agent.message_content import flatten_message_text
from plugins.plugin_storage import plugin_db

from .agent_profiles import CAPABILITIES, active_agent, activate_agent, deactivate_agent, request_agent


_NAMES = {alias: key for key, row in CAPABILITIES.items()
          for alias in (row["display_name"], row.get("label", ""), *row.get("legacy_names", [])) if alias}
_REGISTERED_NAMES = {alias: key for key, row in CAPABILITIES.items()
                     for alias in (row["skill"], row["display_name"], row.get("label", ""), *row.get("legacy_names", [])) if alias}
_COMMAND = re.compile(r"^\s*(?:请\s*)?(调用|启用|使用|停用|确认切换为)\s*(" + "|".join(re.escape(name) for name in _NAMES) + r")")
_COMMAND_BOUNDARY = re.compile(r"^(?:$|[\s。.!！;；,，:：])")
_COMMAND_QUESTION = re.compile(
    r"^[?？]|^(?:吗|么|呢|是否|能否|可否|可以吗|要不要|是不是|好不好|怎么样|如何|怎么|是什么)"
    r"|^(?:示例|例子|(?:只是|仅为)(?:一个)?(?:示例|例子))"
    r"|^(?:请\s*)?(?:不要|不用|不必|别)(?:真的|实际|再)?(?:启用|调用|使用|切换)"
)


def capability_for_skill(name):
    if not isinstance(name, str):
        return None
    value = name.strip()
    if ":" in value:
        namespace, value = value.split(":", 1)
        if namespace != "jubao-drama":
            return None
    return value if value in CAPABILITIES else _REGISTERED_NAMES.get(value)


def _table(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS drama_skill_sessions (session_id TEXT PRIMARY KEY, skills TEXT NOT NULL)")
    # 启用时间供收尾自动交付判断哪些回复属于独立技能；旧记录没有时间，只影响启用前的历史补存。
    if "activated_at" not in {row[1] for row in conn.execute("PRAGMA table_info(drama_skill_sessions)")}:
        conn.execute("ALTER TABLE drama_skill_sessions ADD COLUMN activated_at REAL")


def skills_activated_at(session_id):
    with closing(plugin_db("jubao-drama")) as conn:
        _table(conn)
        row = conn.execute("SELECT activated_at FROM drama_skill_sessions WHERE session_id=?", (session_id,)).fetchone()
    return float(row[0]) if row and row[0] is not None else None


def active_skills(session_id):
    """子任务沿用父会话的选择，账号路径由现有 profile 作用域绑定。"""
    if not isinstance(session_id, str) or not session_id:
        return []
    state = get_hermes_home() / "state.db"
    parents = sqlite3.connect(state.as_uri() + "?mode=ro", uri=True) if state.is_file() else None
    try:
        with closing(plugin_db("jubao-drama")) as conn:
            _table(conn)
            seen = set()
            while session_id and session_id not in seen and len(seen) < 100:
                seen.add(session_id)
                row = conn.execute("SELECT skills FROM drama_skill_sessions WHERE session_id=?", (session_id,)).fetchone()
                if row:
                    return json.loads(row[0])
                if parents is None:
                    break
                parent = parents.execute("SELECT parent_session_id FROM sessions WHERE id=?", (session_id,)).fetchone()
                session_id = parent[0] if parent else ""
    finally:
        if parents is not None:
            parents.close()
    return []


def _creative_table(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS drama_creative_requests (session_id TEXT PRIMARY KEY, marked_at REAL NOT NULL)")


def requested_creative(session_id):
    """本对话（含压缩前的父会话）是否在未选 Agent/技能时要过稿件。"""
    if not isinstance(session_id, str) or not session_id:
        return False
    state = get_hermes_home() / "state.db"
    parents = sqlite3.connect(state.as_uri() + "?mode=ro", uri=True) if state.is_file() else None
    try:
        with closing(plugin_db("jubao-drama")) as conn:
            _creative_table(conn)
            seen = set()
            while session_id and session_id not in seen and len(seen) < 100:
                seen.add(session_id)
                if conn.execute("SELECT 1 FROM drama_creative_requests WHERE session_id=?", (session_id,)).fetchone():
                    return True
                if parents is None:
                    break
                parent = parents.execute("SELECT parent_session_id FROM sessions WHERE id=?", (session_id,)).fetchone()
                session_id = parent[0] if parent else ""
    finally:
        if parents is not None:
            parents.close()
    return False


def creative_session(session_id):
    """创作对话：选了 Agent 或技能，或者员工不选能力直接要稿件。

    正式版员工约三成消息不选 Agent，直接写“第三集扩充至1000字左右”“继续输出第9集和第10集的剧本正文”。
    此前这类对话被当作普通问答，要求清单、字数核验、目标市场检查与返修都不启动。员工一旦在对话里要过稿件，
    整个对话就按创作对话处理（之后的“继续”“字数太少了”也一样）；只提问的对话不受影响。
    """
    return bool(active_agent(session_id) or active_skills(session_id) or requested_creative(session_id))


def _observe_creative_request(session_id, content):
    marker = "\n\n【用户本轮消息】\n"
    body = content.split(marker, 1)[1] if marker in content else content
    # 附件正文里的“写/生成…”是原稿内容，不是本轮要求。
    body = re.split(r"\n\n--- (?:Attached Context|Context Warnings) ---", body, maxsplit=1)[0]
    from .task_requirement_extract import extract
    if not extract({"original_text": body, "wrapper_settings": {}}, {})[1].get("creative"):
        return
    with closing(plugin_db("jubao-drama")) as conn:
        _creative_table(conn)
        conn.execute("INSERT OR IGNORE INTO drama_creative_requests (session_id, marked_at) VALUES (?,?)", (session_id, time.time()))
        conn.commit()


def latest_user_content(request):
    for row in reversed(request.get("messages") or request.get("input") or []):
        if (not isinstance(row, dict) or row.get("role") != "user"
                or row.get("display_kind") or row.get("_compressed_summary")):
            continue
        content = row.get("content", row.get("text", ""))
        if isinstance(content, list):
            content = flatten_message_text(content)
        if not isinstance(content, str):
            return ""
        return content
    return ""


def invocation_commands(content):
    # 图片和音频只提供素材，不能把其元数据当作能力操作。
    if not isinstance(content, str):
        content = flatten_message_text(content if isinstance(content, list) else [content])
    marker = "\n\n【用户本轮消息】\n"
    if content.startswith("【本轮语言偏好】\n") and marker in content:
        control, content = content.split(marker, 1)
        match = re.search(r"\n【本轮能力操作】\n([^\n]+)(?:\n|$)", control)
        if match:
            try:
                operations = json.loads(match[1])
            except ValueError:
                return []
            if not isinstance(operations, list) or len(operations) > len(CAPABILITIES):
                return []
            commands = []
            for operation in operations:
                if (not isinstance(operation, dict) or set(operation) != {"id", "action"}
                        or not isinstance(operation["id"], str) or operation["id"] not in CAPABILITIES
                        or operation["action"] not in ("enable", "disable")):
                    return []
                commands.append(("调用" if operation["action"] == "enable" else "停用", operation["id"]))
            if operations:
                return commands
    # 旧客户端可能把明确的“使用”指令保存为空操作；只恢复原始正文开头的直接指令。
    content = re.split(r"\n\n--- (?:Attached Context|Context Warnings) ---", content, maxsplit=1)[0]
    commands = []
    while match := _COMMAND.match(content):
        tail = content[match.end():]
        clause = re.sub(r"^[\s,，:：]+", "", re.split(r"[。.!！;；\n]", tail, maxsplit=1)[0])
        if not _COMMAND_BOUNDARY.match(tail) or _COMMAND_QUESTION.search(clause):
            break
        commands.append(("调用" if match[1] == "使用" else match[1], _NAMES[match[2]]))
        content = tail
    return commands


def _selection_record_kinds(session_id):
    from .agent_profiles import _table as agent_tables
    with closing(plugin_db("jubao-drama")) as conn:
        agent_tables(conn)
        _table(conn)
        return {kind for kind, table in (("agent", "drama_agent_sessions"), ("skill", "drama_skill_sessions"))
                if conn.execute(f"SELECT 1 FROM {table} WHERE session_id=?", (session_id,)).fetchone()}


def _restore_selection(messages, session_id, missing):
    for row in messages:
        commands = [command for command in invocation_commands(latest_user_content({"messages": [row]}))
                    if CAPABILITIES[command[1]]["kind"] in missing]
        if commands:
            _apply_commands(commands, session_id)


def pre_llm_selection(*, user_message=None, session_id="", **_kwargs):
    """在模型切换通知与用户消息合并前绑定；旧会话仅回放原始用户授权。"""
    from agent.delegation_context import is_delegated_child_context

    # 超级管理员沿用的运营 profile 不受工具限制，但同样需要记录用户选择：稿件归属、要求清单与设定库
    # 都按已选 Agent/技能判断。此前只在受限账号记录，超级管理员选择 Agent 后无法保存稿件。
    if not session_id or is_delegated_child_context():
        return
    existing = _selection_record_kinds(session_id)
    if "agent" not in existing:
        state = get_hermes_home() / "state.db"
        if state.is_file():
            from hermes_state import SessionDB

            # 原始用户行保留选择控制区；模型请求中的合并行已失去这个边界。
            # 显示历史包含压缩前原文，但排除撤回行；摘要和内部通知另行过滤。
            with closing(SessionDB(state, read_only=True)) as database:
                lineage = database._resume_lineage_ids(session_id)
                # 已有的绑定和停用记录优先；独立技能的状态不能阻止主 Agent 恢复。
                for parent in lineage:
                    if parent != session_id:
                        existing.update(_selection_record_kinds(parent))
                if "agent" not in existing:
                    history = database.get_messages(
                        session_id, include_compacted=True, include_ancestors=True)
                    _restore_selection(history, session_id, {"agent", "skill"} - existing)
    content = latest_user_content({"messages": [{"role": "user", "content": user_message}]})
    _apply_commands(invocation_commands(content), session_id)
    if not (active_agent(session_id) or active_skills(session_id)):
        try:
            _observe_creative_request(session_id, content)
        except Exception as exc:
            logging.getLogger(__name__).warning("创作请求识别失败（session=%s）: %s", session_id, exc)


def _apply_commands(commands, session_id):
    main = [(action, key) for action, key in commands if CAPABILITIES[key]["kind"] == "agent" and action != "停用"]
    if len({key for _, key in main}) > 1:
        return
    for action, key in commands:
        if action == "停用" and CAPABILITIES[key]["kind"] == "agent":
            deactivate_agent(session_id, key)
    if main:
        _, selected = main[-1]
        # 用户的新调用从本轮入口替换主 Agent；模型自行读取其他规则不改变绑定。
        activate_agent(session_id, selected, replace=True)
        request_agent(session_id, selected)
    updates = [(action, key) for action, key in commands if CAPABILITIES[key]["kind"] == "skill"]
    if updates:
        selected = set(active_skills(session_id))
        for action, key in updates:
            if action == "停用":
                selected.discard(key)
            else:
                selected.add(key)
        with closing(plugin_db("jubao-drama")) as conn:
            _table(conn)
            now = time.time() if selected else None
            conn.execute("INSERT INTO drama_skill_sessions (session_id, skills, activated_at) VALUES (?,?,?) "
                         "ON CONFLICT(session_id) DO UPDATE SET skills=excluded.skills, "
                         "activated_at=CASE WHEN excluded.activated_at IS NULL THEN NULL ELSE COALESCE(activated_at, excluded.activated_at) END",
                         (session_id, json.dumps(sorted(selected)), now))
            conn.commit()


def transform_clarify_result(*, tool_name="", args=None, result=None, status="ok", session_id="", **_kwargs):
    if tool_name != "clarify" or status != "ok" or not session_id:
        return None
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (TypeError, ValueError):
            return None
    if not isinstance(result, dict) or result.get("outcome") != "submitted":
        return None
    commands = []
    for response in result.get("responses", []):
        if not isinstance(response, dict) or response.get("status") != "answered":
            continue
        choices, answer = response.get("choices_offered"), response.get("user_response")
        if not isinstance(choices, list) or not isinstance(answer, str):
            continue
        key = _NAMES.get(answer.strip())
        if key and any(isinstance(choice, str) and _NAMES.get(choice.strip()) == key for choice in choices):
            commands.append(("调用", key))
    if commands:
        _apply_commands(commands, session_id)
    return None


def document_owner(session_id):
    selected = active_agent(session_id)
    if selected:
        return selected
    if active_skills(session_id):
        return "independent-skills"
    from .plain_documents import OWNER, has_documents, requested
    # 不选能力直接要稿件的对话，稿件与员工明确要求保存时一样归入普通稿件。
    if requested(session_id) or has_documents(session_id) or requested_creative(session_id):
        return OWNER
    raise PermissionError("请先调用一个剧本 Agent 或独立技能，再保存稿件")

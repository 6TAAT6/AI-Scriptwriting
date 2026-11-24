"""受限 Studio 原生子代理的只读工具投影与父会话依据读取。"""
from contextlib import closing
from copy import deepcopy
import json
import sqlite3

from hermes_constants import get_hermes_home
from hermes_state import SessionDB

# schema 和执行入口共用动作/字段表；调用者不能用额外字段申请写权限。
_ACTIONS = {
    "drama_agent_document": {"list": {"offset", "limit", "snapshot_rowid"},
                             "read": {"document_id", "start_char", "max_chars", "content_sha256"}},
    "drama_story_bible": {"list": {"category"}, "read": {"id"}, "search": {"query"}, "history": {"id"}},
    "drama_requirements": {"list": {"include_inactive"}},
}
_READ_TOOLS = frozenset({"skills_list", "skill_view", "drama_rules_read", "session_search", *_ACTIONS})
_HISTORY_FIELDS = {"query", "limit", "session_id"}
_DESCRIPTIONS = {
    "drama_agent_document": "只读父创作会话的同 Agent 稿件。list 查询目录；read 按 document_id 读取正文，按 next_start_char 与 content_sha256 续读。不得保存、核验或导出。",
    "drama_story_bible": "只读父创作会话的设定库；支持 list、read、search、history，不修改任何条目。",
    "drama_requirements": "只读父创作会话的要求清单，不新增、修改要求或细则。",
    "session_search": "只检索父创作会话及其合法压缩续接的文本；query 为关键词，空值读取最近消息。不能读取兄弟或其他会话。",
}


def _function(tool):
    if not isinstance(tool, dict):
        return {}
    return tool.get("function") if isinstance(tool.get("function"), dict) else tool


def project_tools(request):
    changed = deepcopy(request)
    projected = []
    for tool in changed.get("tools") or []:
        function = _function(tool)
        name = function.get("name")
        if name not in _READ_TOOLS:
            continue
        schema_key = "input_schema" if "input_schema" in function else "parameters"
        schema = function.get(schema_key) or {}
        if name in _ACTIONS:
            actions = _ACTIONS[name]
            fields = {"action"} | set().union(*actions.values())
            schema["properties"] = {key: value for key, value in (schema.get("properties") or {}).items() if key in fields}
            schema["properties"]["action"] = {"type": "string", "enum": list(actions)}
            schema["required"] = ["action"]
            schema["additionalProperties"] = False
            if name == "drama_agent_document" and "document_id" in schema["properties"]:
                schema["properties"]["document_id"]["description"] = "action=read 时必填的父会话稿件编号"
            function[schema_key] = schema
        elif name == "session_search":
            schema["properties"] = {key: value for key, value in (schema.get("properties") or {}).items() if key in _HISTORY_FIELDS}
            for field, description in {
                "query": "在父创作会话历史中检索的关键词；省略则读取最近消息。",
                "limit": "最多返回的父创作会话历史消息数量，范围为 1 至 20。",
                "session_id": "可选的父创作会话编号；只能读取父会话，不能读取兄弟或其他会话。",
            }.items():
                if field in schema["properties"]:
                    schema["properties"][field]["description"] = description
            schema["required"] = []
            schema["additionalProperties"] = False
            function[schema_key] = schema
        if name in _DESCRIPTIONS:
            function["description"] = _DESCRIPTIONS[name]
        projected.append(tool)
    changed["tools"] = projected
    choice = changed.get("tool_choice")
    if isinstance(choice, dict) and _function(choice).get("name") not in {_function(tool).get("name") for tool in projected}:
        changed["tool_choice"] = "auto"
    return changed


def allowed(tool_name, args):
    if tool_name not in _READ_TOOLS or not isinstance(args, dict):
        return False
    if tool_name in _ACTIONS:
        action = args.get("action", "list" if tool_name == "drama_requirements" else None)
        fields = _ACTIONS[tool_name].get(action) if isinstance(action, str) else None
        return fields is not None and not set(args) - fields - {"action"}
    return not set(args) - _HISTORY_FIELDS if tool_name == "session_search" else True


def parent_session(session_id):
    """只认可宿主持久化的委派标记，普通 parent/fork/reset 关系不授予父稿读取。"""
    state = get_hermes_home() / "state.db"
    if not state.is_file():
        raise PermissionError("子代理没有可验证的父创作会话")
    with closing(SessionDB(state, read_only=True)) as database:
        chain = database._resume_lineage_ids(session_id)
        root = database.get_session(chain[0]) if chain else None
        config = (root or {}).get("model_config") or {}
        if isinstance(config, str):
            config = json.loads(config)
        parent = (root or {}).get("parent_session_id")
        if (not parent or not isinstance(config, dict) or config.get("_delegate_from") != parent
                or config.get("_branched_from") or config.get("_reset_from") or not database.get_session(parent)):
            raise PermissionError("子代理没有可验证的父创作会话")
        return parent


def is_readonly_child(session_id):
    """完成回调或历史恢复已离开子线程时，仍按原生会话身份保持只读。"""
    from agent.delegation_context import is_delegated_child_context
    from .security import restricted
    if not restricted():
        return False
    if is_delegated_child_context():
        return True
    try:
        parent_session(session_id)
    except (PermissionError, ValueError, TypeError, KeyError):
        return False
    return True


def _document(args, parent):
    from .agent_documents import _documents, _list_documents, _reading_scope
    from .agent_document_reading import document_page
    from .capability_selection import document_owner

    owner = document_owner(parent)
    lineage = _reading_scope(parent, owner)
    if args["action"] == "list":
        # 不继承父会话已接收的其他子稿授权，避免把兄弟输出扩大为本子任务权限。
        return _list_documents(args, parent, owner, lineage, [])
    identifier = args.get("document_id")
    if not isinstance(identifier, str) or not identifier.strip():
        raise ValueError("请提供有效稿件编号")
    database = get_hermes_home() / "plugin-data" / "jubao-drama" / "data.db"
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as conn:
        for sid in lineage:
            documents, _ = _documents(conn, sid, owner, identifier)
            if documents:
                return {"ok": True, **document_page(documents[0], args)}
    raise PermissionError("子代理只能读取父创作会话的稿件")


def _history(args, parent):
    from tools.session_search_tool import _shape_message

    if args.get("session_id") not in (None, parent):
        raise PermissionError("子代理不能读取兄弟或其他会话")
    query, limit = args.get("query", ""), args.get("limit", 10)
    if not isinstance(query, str) or type(limit) is not int or not 1 <= limit <= 20:
        raise ValueError("query 必须是文本，limit 必须为 1 至 20")
    with closing(SessionDB(get_hermes_home() / "state.db", read_only=True)) as database:
        rows = database.get_messages(parent, include_ancestors=True, include_compacted=True)
    matches = [row for row in rows if not query or query.casefold() in str(row.get("content") or "").casefold()]
    return {"success": True, "session_id": parent, "total": len(matches),
            "messages": [_shape_message(row, max_content_len=2000) for row in matches[-limit:]]}


def read_parent_basis(tool_name, args, session_id):
    parent = parent_session(session_id)
    if tool_name == "drama_agent_document":
        result = _document(args, parent)
    elif tool_name == "session_search":
        result = _history(args, parent)
    elif tool_name == "drama_requirements":
        from .creative_tools import requirements_handler
        return requirements_handler(args, session_id=parent)
    else:
        from .creative_tools import bible_handler
        return bible_handler(None)(args, session_id=parent)
    return json.dumps(result, ensure_ascii=False)


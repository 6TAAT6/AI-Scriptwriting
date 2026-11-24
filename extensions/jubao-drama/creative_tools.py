"""设定库与要求清单的模型工具。要求清单对模型只读；设定库的核心变更须经用户确认。"""

from __future__ import annotations

import json

from . import ledger, story_bible
from .creative_scope import scope_for

_BIBLE_FIELDS = {"list": {"category"}, "read": {"id"}, "search": {"query"}, "history": {"id"},
                 "record": {"changes"}, "propose": {"changes"}}


def _format_request(session_id):
    import re
    from . import requirement_control
    state = requirement_control._current(session_id) or {}
    text = ((state.get("contract") or {}).get("source") or {}).get("original_text") or ""
    for clause in re.split(r"[。！？!?\n]", text):
        if re.search(r"格式|规范|排版|体例", clause) and re.search(r"学习|记住|沿用|按照|参照|保持|延续|用这个|照着", clause):
            return clause.strip()
    return None


def _json(value):
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


def _require_creative(session_id):
    from .capability_selection import creative_session
    if not creative_session(session_id):
        raise PermissionError("设定库仅在创作对话中使用")


def _brief(entry):
    content = entry["content"]
    return {"id": entry["id"], "category": entry["category"], "category_label": entry["category_label"],
            "name": entry["name"], "aliases": entry["aliases"], "core": entry["core"], "version": entry["version"],
            "summary": content if len(content) <= 160 else content[:160] + "……"}


def bible_handler(bridge):
    def handle(args, **kwargs):
        if not isinstance(args, dict):
            raise ValueError("设定库参数必须是对象")
        session_id = str(kwargs.get("session_id") or "").strip()
        if not session_id:
            raise ValueError("设定库操作必须来自有会话标识的创作对话")
        action = args.get("action")
        if action not in _BIBLE_FIELDS:
            raise ValueError("action 只能是 list、read、search、history、record 或 propose")
        if set(args) - {"action"} - _BIBLE_FIELDS[action]:
            raise ValueError("本次设定库操作包含不支持的参数")
        _require_creative(session_id)
        scope = scope_for(session_id)
        if action == "list":
            category = args.get("category")
            if category is not None and category not in story_bible.CATEGORIES:
                raise ValueError("未知设定类别")
            entries = story_bible.list_entries(scope, category=category)
            return _json({"ok": True, "entries": [_brief(entry) for entry in entries], "total": len(entries),
                          "next": "需要完整内容时用 read 读取对应 id。"})
        if action == "read":
            return _json({"ok": True, "entry": story_bible.get_entry(scope, str(args.get("id") or ""))})
        if action == "history":
            return _json({"ok": True, "history": story_bible.history(scope, str(args.get("id") or ""))[:20]})
        if action == "search":
            query = args.get("query")
            if not isinstance(query, str) or not query.strip():
                raise ValueError("search 需要非空 query")
            from .memory import story_memory
            hits = story_memory().search(scope, query, limit=10)
            entries = {entry["id"]: entry for entry in story_bible.list_entries(scope)}
            return _json({"ok": True, "entries": [_brief(entries[hit.key]) for hit in hits if hit.key in entries]})
        from agent.delegation_context import is_delegated_child_context
        if is_delegated_child_context():
            raise PermissionError("子代理只能读取设定库，请把需要新增或修改的设定交回主会话")
        if action == "record":
            changes = args.get("changes")
            if not isinstance(changes, list):
                raise ValueError("record 需要 changes 数组")
            written = story_bible.apply_changes(scope, changes, actor="model", session_id=session_id, allow_core=False)
            return _json({"ok": True, "recorded": [_brief(entry) for entry in written],
                          "next": "已记录到设定库，用户可在“创作资料 → 设定”中查看或撤销。"})
        written = bridge.apply(args)
        return _json({"ok": True, "confirmed_by_user": True, "applied": [_brief(entry) for entry in written],
                      "next": "用户已确认，设定库已更新；后续创作和审稿以新设定为准。"})
    return handle


def requirements_handler(args, **kwargs):
    action = args.get("action", "list") if isinstance(args, dict) else None
    allowed = {"list": {"action", "include_inactive"}, "detail": {"action", "id", "detail"}}.get(action)
    if allowed is None or set(args) - allowed:
        raise ValueError("要求清单只支持 list 与 detail；要求本身由用户提出或在资料栏中编辑，模型不能新增、修改或取消")
    session_id = str(kwargs.get("session_id") or "").strip()
    if not session_id:
        raise ValueError("要求清单必须来自有会话标识的对话")
    scope = scope_for(session_id)
    if action == "detail":
        from agent.delegation_context import is_delegated_child_context
        if is_delegated_child_context():
            raise PermissionError("子代理只能读取要求清单")
        identifier = str(args.get("id") or "")
        if not identifier:
            # 本轮原话的提取在后台进行；等它完成后附到最新的一条格式/文风要求上。
            ledger.wait_pending(scope)
            # 先找格式要求，其次文风；“本次交付第几集”之类仅本轮的条目不承载细则。
            items = [item for item in ledger.list_requirements(scope) if item["lifetime"] != "turn"]
            candidates = ([item for item in items if item["category"] == "format"]
                          or [item for item in items if item["category"] == "style"])
            if not candidates:
                # “请你阅读这个剧本，并记住现在的格式”：要求提取有时不把这句当成格式要求。用户本轮原话里确实
                # 要求学习或沿用格式时，以这句原话登记一条格式要求，再把细则附上去。
                quote = _format_request(session_id)
                if not quote:
                    raise ValueError("用户本轮没有要求学习或沿用格式；格式细则只能附在用户提出的格式要求上，直接按用户原话执行即可")
                candidates = [ledger.record_user_requirement(scope, session_id, quote, category="format",
                                                             text="按用户提供的样稿格式写作")]
            identifier = max(candidates, key=lambda item: item["created_at"])["id"]
        item = ledger.set_detail(scope, identifier, args.get("detail"))
        return _json({"ok": True, "requirement": {key: item[key] for key in ("id", "text", "category", "lasting", "detail")},
                      "next": "执行细则已附在用户这条要求上，之后每轮随要求清单提供；用户可在“创作资料 → 要求”中查看。"})
    items = ledger.list_requirements(scope, include_inactive=bool(args.get("include_inactive")))
    return _json({"ok": True, "pending_extraction": ledger.extraction_pending(scope),
                  "requirements": [{key: item[key] for key in ("id", "text", "category", "lifetime", "lasting", "status", "pinned",
                                                               "quote", "constraint", "origin", "detail")} for item in items]})


BIBLE_CHANGE_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["op"],
    "properties": {
        "op": {"type": "string", "enum": ["add", "update", "retire"]},
        "id": {"type": "string", "description": "update/retire 时必填的已有条目 id"},
        "category": {"type": "string", "enum": list(story_bible.CATEGORIES),
                     "description": "核心：world_rule 世界规则、character 人物、relationship 人物关系、key_item 关键物件；"
                                    "非核心：location 地点、timeline 时间线与末态、minor_character 次要人物、style 文风基调、note 备注"},
        "name": {"type": "string", "description": "条目名称，如人物姓名、物件名、规则名"},
        "aliases": {"type": "array", "items": {"type": "string"}, "description": "别名、称呼"},
        "content": {"type": "string", "description": "完整设定内容；update 时给出修改后的全文"},
        "reason": {"type": "string", "description": "为什么需要这项设定（propose 时会展示给用户）"},
    },
}

BIBLE_SCHEMA = {
    "name": "drama_story_bible",
    "description": ("读写当前作品的设定库（权威设定）。list/read/search/history 读取；record 直接记录非核心条目"
                    "（地点、时间线与末态、次要人物、文风、备注）；propose 提交核心设定（世界规则、人物、人物关系、关键物件）"
                    "的新增、修改或停用，会弹出确认卡片，用户确认后才写入，确认前不得把这些设定写进正文。"),
    "parameters": {"type": "object", "additionalProperties": False, "required": ["action"], "properties": {
        "action": {"type": "string", "enum": list(_BIBLE_FIELDS)},
        "category": {"type": "string", "enum": list(story_bible.CATEGORIES), "description": "list 时可按类别过滤"},
        "id": {"type": "string", "description": "read/history 的条目 id"},
        "query": {"type": "string", "description": "search 的检索内容"},
        "changes": {"type": "array", "minItems": 1, "maxItems": 30, "items": BIBLE_CHANGE_SCHEMA,
                    "description": "record/propose 的变更列表"},
    }},
}

REQUIREMENTS_SCHEMA = {
    "name": "drama_requirements",
    "description": ("查看要求清单（用户明确提出的要求，含对所有作品生效的长期要求）。清单由用户维护，模型不能新增、修改或取消。"
                    "detail：用户要求学习或沿用其格式、文风并给出样稿时，把从样稿整理出的可执行规则附到用户那条格式/文风要求上。"),
    "parameters": {"type": "object", "additionalProperties": False, "properties": {
        "action": {"type": "string", "enum": ["list", "detail"]},
        "include_inactive": {"type": "boolean", "description": "list：是否包含已取消、已失效的条目"},
        "id": {"type": "string", "description": "detail：用户格式/文风要求的条目 id；省略时附到最新的一条格式/文风要求"},
        "detail": {"type": "string", "description": "detail：逐条可执行的格式规则（标题、场景行、人物行、动作、台词、结尾标记等），不超过 3000 字"},
    }},
}

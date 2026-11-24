"""确定性请求投影。

只改发给模型的 API 副本，不改会话数据库。历史行的结果只由该行和稳定来源决定，
追加新消息不会重新解释旧行，因此不会让缓存前缀随轮次来回变化。
"""
from __future__ import annotations

from contextlib import closing
from copy import deepcopy
import json
import re
from threading import RLock

from hermes_constants import get_hermes_home, hermes_home_key
from .project_view import project_view

_CONTROL_START = "【本轮语言偏好】\n"
_USER_BODY = "\n\n【用户本轮消息】\n"
_USER_OPEN = "【用户原文】\n"
_USER_CLOSE = "\n【原文结束】"
_CAPSULE_START = "【创作胶囊｜"
_LEDGER_MARKER = "<!-- hermes-persistent-user-requirements:v1 -->"
_LEDGER_SECTION = re.compile(r"(?ms)^## Persistent User Requirements\s*\n.*?(?=^## |\Z)")
_DUPLICATE_SKILL = "[相同规则已在本会话更早的完整 skill_view 结果中提供，此次无变化。]"
_SKILL_DUPLICATE = _DUPLICATE_SKILL
_ORIGINS: dict[tuple[str, str], dict] = {}
_LOCK = RLock()


def _text_fields(row):
    content = row.get("content") if isinstance(row, dict) else None
    if isinstance(content, str):
        return [(row, "content")]
    if isinstance(content, list):
        return [(part, "text") for part in content
                if isinstance(part, dict) and isinstance(part.get("text"), str)]
    return []


def _parse_web_envelope(text):
    if not isinstance(text, str) or not text.startswith(_CONTROL_START) or _USER_BODY not in text:
        return None
    return text.split(_USER_BODY, 1)[1]


def _strip_capsule(text):
    if not isinstance(text, str):
        return text
    marker = text.find(_CAPSULE_START)
    return text[:marker].rstrip("\n") if marker >= 0 else text


def _slim_document(text):
    """稳定删除成功检查的重复证据，失败和后续动作保持原样。"""
    if not isinstance(text, str) or not text.lstrip().startswith("{"):
        return text
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return text
    if not isinstance(data, dict) or not isinstance(data.get("document"), dict):
        return text
    quality = data.get("quality_check")
    if not isinstance(quality, dict) or not isinstance(quality.get("checks"), list):
        return text
    changed = False
    checks = []
    for check in quality["checks"]:
        if isinstance(check, dict) and check.get("status") == "pass" and "evidence" in check:
            check = {key: value for key, value in check.items() if key != "evidence"}
            changed = True
        checks.append(check)
    if not changed:
        return text
    out = deepcopy(data)
    out["quality_check"]["checks"] = checks
    return json.dumps(out, ensure_ascii=False)


def _slim_project(text):
    if not isinstance(text, str) or not text.lstrip().startswith("{"):
        return text
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return text
    project = data.get("project") if isinstance(data, dict) else None
    if not isinstance(project, dict) or "generation_revision" not in project or project.get("view"):
        return text
    out = deepcopy(data)
    out["project"] = project_view(project)
    return json.dumps(out, ensure_ascii=False, indent=2, default=str)


def _compat_slim_receipt(text):
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return text
    document = data.get("document") if isinstance(data, dict) else None
    quality = data.get("quality_check") if isinstance(data, dict) else None
    if not isinstance(document, dict) or not isinstance(quality, dict):
        return text
    issues = []
    for issue in quality.get("issues", []):
        if isinstance(issue, dict):
            issues.append(issue.get("message") or issue.get("code"))
        else:
            issues.append(issue)
    slim = {
        "ok": data.get("ok"),
        "document": {key: document.get(key) for key in ("id", "name", "kind", "status", "episode_range", "characters", "export_status")},
        "quality_check": {"status": quality.get("status"), "issues": issues[:8]},
    }
    return json.dumps(slim, ensure_ascii=False)


def transform_tool_result(*, tool_name="", args=None, result=None, **_kwargs):
    if tool_name != "drama_agent_document" or not isinstance(args, dict):
        return None
    if args.get("action") not in {"save", "check", "export"}:
        return None
    slimmed = _slim_document(result)
    return slimmed if slimmed != result else None


def _session_origin(session_id, platform):
    if not session_id:
        return {"source": "web" if platform == "web" else platform, "all_web": platform == "web"}
    state = get_hermes_home() / "state.db"
    if not state.is_file():
        return {"source": "web" if platform == "web" else platform, "all_web": platform == "web"}
    try:
        from hermes_state import SessionDB
        with closing(SessionDB(state, read_only=True)) as database:
            pending, seen, sessions = [session_id], set(), []
            while pending:
                current = pending.pop()
                if current in seen:
                    continue
                seen.add(current)
                saved = database.get_session(current) or {}
                sessions.append(saved)
                parent = saved.get("parent_session_id")
                if parent:
                    pending.append(parent)
            sources = {row.get("source") for row in sessions if row.get("source")}
            source = (database.get_session(session_id) or {}).get("source") or platform
            return {"source": source, "all_web": bool(sessions) and sources == {"web"}}
    except Exception:
        return {"source": platform, "all_web": False}


def prepare_replay(*, session_id="", platform="", **_kwargs):
    """只读记录会话来源；读取失败时保守关闭网页投影。"""
    origin = _session_origin(session_id, platform)
    origin["session_id"] = session_id
    with _LOCK:
        _ORIGINS[(hermes_home_key(), session_id)] = origin


def on_session_end(*, session_id="", **_kwargs):
    with _LOCK:
        _ORIGINS.pop((hermes_home_key(), session_id), None)


def _origin_for(session_id, platform):
    with _LOCK:
        value = _ORIGINS.get((hermes_home_key(), session_id))
    if value is not None:
        return value
    return {"source": platform, "all_web": platform == "web", "session_id": session_id}


def _web_row(source, origin):
    if not origin.get("all_web"):
        return False
    row_source = source.get("source") if isinstance(source, dict) else None
    return row_source in (None, "web")


def _project_user(source, wire, *, historical, web):
    if not historical or not web or not isinstance(source, dict) or source.get("role") != "user":
        return
    source_content = source.get("content")
    wire_content = wire.get("content")
    if isinstance(source_content, str) and isinstance(wire_content, str):
        body = _parse_web_envelope(source_content)
        if body is not None:
            wire["content"] = _USER_OPEN + body + _USER_CLOSE
            return
        if isinstance(source.get("api_content"), str) and source["api_content"].startswith(source_content + "\n\n"):
            wire["content"] = _strip_capsule(wire_content)
        return
    if not isinstance(source_content, list) or not isinstance(wire_content, list):
        return
    first_text = next((part.get("text") for part in source_content
                       if isinstance(part, dict) and part.get("type") in {"text", "input_text"}
                       and isinstance(part.get("text"), str)), None)
    body = _parse_web_envelope(first_text)
    if body is not None:
        for part in wire_content:
            if isinstance(part, dict) and part.get("type") in {"text", "input_text"}:
                if part.get("text") == first_text:
                    part["text"] = _USER_OPEN + body + _USER_CLOSE
                    break
    # 只有首个文字段是网页包络时，末尾宿主胶囊才是宿主生成物；正文内同名文本不碰。
    if body is not None:
        for part in wire_content:
            if isinstance(part, dict) and part.get("type") in {"text", "input_text"}:
                if isinstance(part.get("text"), str) and part["text"].startswith(_CAPSULE_START):
                    part["text"] = ""


def _calls(rows):
    found = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        if row.get("type") == "function_call" and row.get("call_id"):
            found[row["call_id"]] = (row.get("name"), row.get("arguments"))
        for call in row.get("tool_calls") or []:
            if isinstance(call, dict) and call.get("id"):
                function = call.get("function") or {}
                found[call["id"]] = (function.get("name"), function.get("arguments"))
    return found


def _args(raw):
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw) if isinstance(raw, str) else {}
    except (TypeError, ValueError):
        value = {}
    return value if isinstance(value, dict) else {}


def _result_field(row):
    if row.get("type") == "function_call_output":
        return "output", row.get("call_id")
    if row.get("role") == "tool":
        return "content", row.get("tool_call_id")
    return None, None


def _project_tools(rows):
    calls = _calls(rows)
    seen_skills = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        field, call_id = _result_field(row)
        if field is None or not isinstance(row.get(field), str):
            continue
        name, raw_args = calls.get(call_id, (None, {}))
        args = _args(raw_args)
        text = row[field]
        if name in {"drama_project_create", "drama_project_status", "drama_submit", "drama_confirm",
                    "drama_review", "drama_export", "drama_rules_read"}:
            row[field] = _slim_project(text)
        if name == "drama_agent_document" and args.get("action") in {"save", "check", "export"}:
            row[field] = _slim_document(row[field])
        if name != "skill_view" or len(text) <= 2000:
            continue
        try:
            result = json.loads(text)
        except (TypeError, ValueError):
            continue
        if not isinstance(result, dict) or result.get("success") is not True:
            continue
        key = (args.get("name"), args.get("file_path"))
        if key in seen_skills:
            row[field] = _DUPLICATE_SKILL
        else:
            seen_skills.add(key)


def _remove_requirement_ledger(row):
    changed = False
    for holder, key in _text_fields(row):
        text = holder[key]
        if _LEDGER_MARKER in text:
            replacement = _LEDGER_SECTION.sub("", text)
            if replacement != text:
                holder[key] = replacement
                changed = True
    return changed


def transform_api_messages(*, messages, source_messages, session_id="", platform="", current_turn_index=None, **_kwargs):
    if not isinstance(messages, list) or not isinstance(source_messages, list):
        return {"messages": messages}
    origin = _origin_for(session_id, platform)
    current = current_turn_index if isinstance(current_turn_index, int) else len(source_messages)
    for index, (source, wire) in enumerate(zip(source_messages, messages)):
        if not isinstance(wire, dict) or not isinstance(source, dict):
            continue
        _project_user(source, wire, historical=index < current, web=_web_row(source, origin))
        if source.get("_compressed_summary"):
            _remove_requirement_ledger(wire)
    _project_tools(messages)
    return {"messages": messages}


def llm_request(request, **_kwargs):
    """保留插件直接调用的旧观察入口；生产请求走 ``transform_api_messages``。

    这个入口只在旧插件测试和外部诊断中使用，始终深拷贝输入，避免把会话历史改写掉。
    """
    if not isinstance(request, dict):
        return None
    for key in ("messages", "input"):
        rows = request.get(key)
        if not isinstance(rows, list):
            continue
        candidate = deepcopy(request)
        output = candidate[key]
        users = [index for index, row in enumerate(output)
                 if isinstance(row, dict) and row.get("role") == "user"]
        latest = users[-1] if users else len(output)
        changed = False
        latest_text = ""
        if users:
            content = output[latest].get("content")
            latest_text = content if isinstance(content, str) else ""
        for index, (source, wire) in enumerate(zip(rows, output)):
            if index < latest and isinstance(source, dict) and source.get("role") == "user":
                before = deepcopy(wire)
                _project_user(source, wire, historical=True, web=True)
                if isinstance(wire.get("content"), str) and wire["content"].endswith(_USER_CLOSE):
                    wire["content"] = wire["content"][:-len(_USER_CLOSE)]
                if isinstance(wire.get("content"), str):
                    wire["content"] = _strip_capsule(wire["content"])
                elif isinstance(wire.get("content"), list):
                    wire["content"] = [part for part in wire["content"]
                                       if not (isinstance(part, dict) and isinstance(part.get("text"), str)
                                               and part["text"].startswith(_CAPSULE_START))]
                changed |= wire != before
        if _LEDGER_MARKER in "".join(holder[key2] for row in output for holder, key2 in _text_fields(row)) and _CAPSULE_START in latest_text:
            for row in output:
                changed |= _remove_requirement_ledger(row)
        calls = _calls(output)
        skill_seen = set()
        receipt_rows = []
        tool_rows = []
        for row in output:
            field, call_id = _result_field(row) if isinstance(row, dict) else (None, None)
            if field is None or not isinstance(row.get(field), str):
                continue
            name, raw_args = calls.get(call_id, (None, {}))
            args = _args(raw_args)
            tool_rows.append((row, field, name, args))
        for row, field, name, args in tool_rows:
            if name == "drama_agent_document" and args.get("action") in {"save", "check", "export"}:
                receipt_rows.append(row)
        for row, field, name, args in reversed(tool_rows):
            if name is None and field == "content":
                slimmed = _slim_project(row[field])
                if slimmed != row[field]:
                    row[field] = slimmed
                    changed = True
            if name == "skill_view" and len(row[field]) > 2000:
                key_name = (args.get("name"), args.get("file_path"))
                if key_name in skill_seen:
                    row[field] = _DUPLICATE_SKILL
                    changed = True
                else:
                    skill_seen.add(key_name)
        for row in receipt_rows[:-2]:
            slimmed = _compat_slim_receipt(row["content"] if "content" in row else row.get("output"))
            field = "content" if "content" in row else "output"
            if slimmed != row.get(field):
                row[field] = slimmed
                changed = True
        if changed:
            return {"request": candidate}
    return None

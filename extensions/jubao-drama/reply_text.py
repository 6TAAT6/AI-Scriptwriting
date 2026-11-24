"""稿件写在回复里流式显示，保存时由宿主取用刚写出的正文，模型不在工具参数里再写一遍。

实测模型把整集正文写进 drama_agent_document 的 content 参数时，工具参数不会流式显示，用户要等
一到五分钟才看到第一个字，且模型常在保存后把全文再复述一遍。现在模型先在回复中写出稿件，
随后调用 save/check 并传 from_reply=true；Hermes 的 post_api_request 钩子在工具执行前提供本次回复
原文，这里记下这一次响应的正文，工具执行中间件把它填进 content，后续保存、导出与核验流程不变。

正文只取发出这次保存调用的同一次响应。codex_responses 模型（GPT 系列）常把正文写成工具调用前的
commentary 消息：用户能实时看到，但 assistant content 为空。2026-11-16 起只读 content、空响应又不清
旧值，保存会静默取到上一次回复（上一集或一段进度说明），新文件名下存的是旧稿，正式版约 430 次。
"""

from __future__ import annotations

import json
import re
import threading
from typing import NamedTuple

from hermes_constants import hermes_home_key

_TOOL = "drama_agent_document"
_LOCK = threading.Lock()


class _Reply(NamedTuple):
    api_request_id: str
    turn_id: str
    text: str


_LATEST: dict[tuple[str, str], _Reply] = {}
_USED: dict[tuple[str, str], str] = {}  # 工具执行后钩子拿到的是原始参数，用这里取实际保存的正文
_USED_TURN: dict[tuple[str, str], str] = {}  # _USED 所属轮次：OA6.1 提交只沿用本轮刚保存的正文
_NAMES: dict[tuple[str, str], str] = {}  # 本会话上一次从回复保存的稿件名称，局部返修合并后沿用
# 本轮 check 过、还没保存的正文：check 不产生稿件，随后的保存或收尾补存用它，卡片才显示最新版。
_CHECKED: dict[tuple[str, str], dict] = {}
# 只去掉明显的开场白（如“好的，以下是第1集正文：”）；稿件可能用 HTML、Markdown 或自定义格式开头，拿不准就整段保留。
_PREAMBLE = re.compile(r"^\s*(?:好的|好|以下是|以下为|下面是|下面为|这是|现在|正在|根据|按照|已为你|已为您|我将|接下来)[^\n<△▲【]{0,80}[：:。]?\s*$")
# error 只给模型看；required_user_action 会作为这一步的原因显示给员工（presentation.mjs），不能出现工具写法。
_NOT_IN_REPLY = ("本次回复里没有写出稿件正文（只有说明、进度或提问不算正文）。from_reply=true 只保存发出这次保存调用的同一条回复中的正文，"
                 "不会沿用更早的回复。先在回复中从标题开始完整写出要保存的稿件，再用 from_reply=true 保存；"
                 "按核验结果返修时，只需从集标题开始写出要改的那几集完整新正文，保存时会替换进原稿；"
                 "要交付之前已保存的稿件，用 list/read 找到对应 document_id 后 export。")
_NOT_IN_REPLY_ACTION = "这次回复里没有新写出的稿件正文，所以没有保存，以免把说明文字或之前的内容存成稿件。"
# 只写了一段说明、提问或进度播报就调用保存（11-19 GPT 把 70 字的修订说明存成了第2版剧本）：
# 稿件有标题、集场标号、动作行、台词或表格；没有这些结构的短文本再带工作口吻，就是说明不是稿件。
_NOTE_LIMIT = 400
# 集标题后面紧跟分隔符或换行（“第79集：……”“- **第37集【……】**”）；“第8集正文已……”是说明句，不是标题。
_TITLE_LINE = re.compile(r"(?m)^[\t >*+\-]*(?:#{1,6}[ \t]*\S|(?:第[ \t]*[0-9一二三四五六七八九十百零两]+[ \t]*[集章场幕节]"
                         r"|(?:EP|Ep|ep)[ \t]*\d+)(?:[ \t:：【\[（(·\-—|*#]|$))")
_TABLE_ROW = re.compile(r"(?m)^[ \t]*\|.*\|[ \t]*$")
# 先去掉引号里的台词再看口吻；只认对用户或流程说话的用语，“启动、保存、确认”在故事里也常见，不单独算。
_QUOTED = re.compile(r"“[^”\n]*”|「[^」\n]*」|\"[^\"\n]*\"|《[^》\n]*》")
_WORK_VOICE = re.compile(r"[我你您]|请(?:确认|选择|回复|告知|审阅|查看|直接|指示)|[？?]|已(?:启动|派发|开始)|待.{0,20}(?:返回|完成|回传)"
                         r"|稍后|接下来|以上|本次|本轮|回执|核验|稿件|正文|保存接口|已保存|重新保存|修订|返修|定稿")
# 分析稿本身可以没有结构，只拦“已启动、正在分析、待结果返回后”这类进度播报。
_PROGRESS = re.compile(r"已(?:启动|派发|开始)|正在(?:并行|核对|分析|梳理|整理|处理|读取|撰写|生成|写)"
                       r"|待.{0,20}(?:返回|完成|回传)后|(?:结果|分析)(?:返回|完成|回传)后|稍后")


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content if isinstance(part, dict) and isinstance(part.get("text"), str))
    return ""


def _commentary(message) -> list[str]:
    """codex_responses 在工具调用前写给用户的 commentary 正文（宿主作为中途消息实时显示）。"""
    items = message.get("codex_message_items") if isinstance(message, dict) else getattr(message, "codex_message_items", None)
    if isinstance(items, str):
        try:
            items = json.loads(items)
        except ValueError:
            return []
    parts = []
    for item in items if isinstance(items, list) else ():
        if (not isinstance(item, dict) or item.get("type") != "message"
                or not isinstance(item.get("phase"), str) or item["phase"].strip().lower() != "commentary"):
            continue
        text = "".join(part["text"] for part in item.get("content") or ()
                       if isinstance(part, dict) and part.get("type") == "output_text" and isinstance(part.get("text"), str))
        if text.strip():
            parts.append(text)
    return parts


def post_api_request(*, session_id="", assistant_message=None, api_request_id="", turn_id="", **_kwargs):
    """每次响应都覆盖记录，没写正文就记空，旧回复不会留到下一次保存。"""
    if not session_id:
        return
    content = _text(assistant_message.get("content") if isinstance(assistant_message, dict)
                    else getattr(assistant_message, "content", None))
    parts = _commentary(assistant_message)
    if content.strip() and content.strip() not in {part.strip() for part in parts}:
        parts.append(content)
    with _LOCK:
        _LATEST[(hermes_home_key(), session_id)] = _Reply(str(api_request_id or ""), str(turn_id or ""), "\n\n".join(parts))


def _same_response(reply: _Reply, api_request_id: str, turn_id: str) -> bool:
    if reply.api_request_id and api_request_id:
        return reply.api_request_id == api_request_id
    if reply.turn_id and turn_id:
        return reply.turn_id == turn_id
    return True


def _reply_text(session_id: str, api_request_id: str = "", turn_id: str = "", *, consume: bool) -> str:
    with _LOCK:
        key = (hermes_home_key(), session_id)
        reply = _LATEST.pop(key, None) if consume else _LATEST.get(key)
    return reply.text if reply and _same_response(reply, api_request_id, turn_id) else ""


def manuscript(session_id: str, api_request_id: str = "", turn_id: str = "") -> str:
    """取出发出本次工具调用的那次响应中的稿件正文并清空；不是同一次响应就不用。"""
    return _manuscript_text(_reply_text(session_id, api_request_id, turn_id, consume=True))


def _manuscript_text(text):
    from .agent_delivery import _clean
    text = _clean(re.sub(r"(?s)<think>.*?</think>", "", text))  # _clean 先把粘在进度说明后的标题拆到新行
    lines = text.splitlines()
    while lines and (not lines[0].strip() or _PREAMBLE.match(lines[0])):
        lines = lines[1:]
    return "\n".join(lines).strip()


_USER_KINDS = {"script", "outline", "novel", "analysis"}
_NOT_STREAMED = ("用户稿件要先在回复中从标题开始完整写出，让用户实时看到生成过程，再调用 drama_agent_document(action=\"save\", "
                 "kind=…, name=…, from_reply=true) 保存；不要只把正文写在工具参数里。")
_DUPLICATE_NOTE = "正文已在回复中写出，下次保存直接传 from_reply=true，不要在 content 里再写一遍（重复生成会让用户多等）。"


def _compact(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def work_note(kind, text) -> bool:
    """这段回复是说明、提问或进度播报，而不是要保存的稿件。剧本必须有结构；分析稿只拦进度播报。"""
    from .requirement_checks import script_like
    if (len(_compact(text)) >= _NOTE_LIMIT or _TITLE_LINE.search(text) or _TABLE_ROW.search(text)
            or script_like(text)):
        return False
    if kind == "script":
        return True
    # “本次压缩为百字梗概。”后面跟着梗概正文时，第一段是开场说明，看其余段落。
    paragraphs = [part for part in re.split(r"\n\s*\n", _QUOTED.sub("", text)) if part.strip()]
    body = "\n".join(paragraphs[1:] if len(paragraphs) > 1 else paragraphs)
    return bool((_PROGRESS if kind == "analysis" else _WORK_VOICE).search(body))


def _creative(session_id) -> bool:
    from agent.delegation_context import is_delegated_child_context
    from .capability_selection import creative_session
    return not is_delegated_child_context() and creative_session(session_id)


def _content_save(args, next_call, session_id, api_request_id="", turn_id=""):
    """创作对话中直接用 content 保存用户稿件：正文已在回复里流式写出则照常保存，否则要求先写在回复里。"""
    latest = _reply_text(session_id, api_request_id, turn_id, consume=False)
    probe = _compact(args["content"])
    from .delivery_authorization import historical_save_allowed
    historical = bool(probe and probe not in _compact(latest) and historical_save_allowed(session_id, args["content"]))
    if not probe or probe not in _compact(latest) and not historical:
        return json.dumps({"ok": False, "error": _NOT_STREAMED, "blocked_reason": "manuscript_not_streamed",
                           "required_user_action": "在回复中写出完整稿件后，用 from_reply=true 保存。", "retryable": True,
                           "tool": _TOOL}, ensure_ascii=False)
    # content 明确选定本次稿件；只共用返修预算处理，不扩张成整条回复中的其他独立方案。
    result = next_call(_reply_arguments(args, session_id, args["content"], turn_id))
    try:
        data = json.loads(result) if isinstance(result, str) else None
    except ValueError:
        data = None
    if isinstance(data, dict) and data.get("ok") is not False:
        _forget_checked(session_id, data)
        data["note"] = "已复用本对话中展示过的原稿保存，无需再次输出全文。" if historical else _DUPLICATE_NOTE
        return json.dumps(data, ensure_ascii=False, indent=2)
    return result


_SUBMIT_KINDS = {"core", "outline_batch", "script_batch"}
# 阶段提交按对应稿件类型判断说明文字；核心资料可以是无结构的短文本，只拦进度播报。
_SUBMIT_NOTE_KINDS = {"core": "analysis", "outline_batch": "outline", "script_batch": "script"}


def _submit_from_reply(args, next_call, session_id, api_request_id="", turn_id=""):
    """OA6.1 的阶段产物同样先在回复中写出，提交时把正文填入 data.content，其余字段保持模型给出的值。"""
    rest = {key: value for key, value in args.items() if key != "from_reply"}
    content = manuscript(session_id, api_request_id, turn_id) if args.get("kind") in _SUBMIT_KINDS else ""
    note_kind = _SUBMIT_NOTE_KINDS.get(args.get("kind"))
    if (len(content) < 20 or work_note(note_kind, content)) and args.get("kind") in _SUBMIT_KINDS:
        # 模型常先用稿件工具保存、再把同一份正文提交到 OA6.1 项目：沿用本轮刚保存的那份正文，不跨轮。
        key = (hermes_home_key(), session_id)
        with _LOCK:
            same_turn = not turn_id or not _USED_TURN.get(key) or _USED_TURN[key] == turn_id
            content = _USED.get(key, "") if same_turn else ""
    if len(content) < 20 or work_note(note_kind, content):
        return next_call(rest)
    with _LOCK:
        _USED[(hermes_home_key(), session_id)] = content
        _USED_TURN[(hermes_home_key(), session_id)] = turn_id
    data = rest.get("data") if isinstance(rest.get("data"), dict) else {}
    return next_call({**rest, "data": {**data, "content": content}})


def tool_execution(tool_name, args, next_call, *, session_id="", api_request_id="", turn_id="", **_kwargs):
    if tool_name == "drama_submit" and isinstance(args, dict) and args.get("from_reply") is True:
        return _submit_from_reply(args, next_call, session_id, api_request_id, turn_id)
    if tool_name != _TOOL or not isinstance(args, dict):
        return next_call(args)
    if (args.get("from_reply") is not True and args.get("action") == "save" and args.get("kind") in _USER_KINDS
            and isinstance(args.get("content"), str) and session_id and _creative(session_id)):
        return _content_save(args, next_call, session_id, api_request_id, turn_id)
    if args.get("from_reply") is not True:
        return next_call(args)
    rest = {key: value for key, value in args.items() if key != "from_reply"}
    content = manuscript(session_id, api_request_id, turn_id) if args.get("action") in {"save", "check"} else ""
    if content:
        from .requirement_control import _current
        from .continuation_context import merge_unfinished_reply
        try:
            content = merge_unfinished_reply((_current(session_id) or {}).get("contract", {}), content)
        except ValueError as exc:
            return json.dumps({"ok": False, "error": str(exc), "blocked_reason": "continuation_scope",
                "required_user_action": "只续写当前集未完位置之后的正文，保留已经展示的前段。",
                "retryable": True, "tool": _TOOL}, ensure_ascii=False)
    if len(content) < 40 or work_note(rest.get("kind"), content):
        if args.get("action") == "save":
            checked = take_checked(session_id, turn_id, rest.get("name"))
            if checked:
                # 本轮刚核验过的正文：直接保存这一份，不要求模型把全文再写一遍（核验时已合并过返修集）。
                arguments = _reply_arguments({**rest, "kind": rest.get("kind") or checked["kind"], "name": checked["name"]},
                                             session_id, checked["content"], turn_id, merge=False)
                return _saved(session_id, next_call(arguments))
            return json.dumps({"ok": False, "error": _NOT_IN_REPLY, "blocked_reason": "manuscript_not_streamed",
                               "required_user_action": _NOT_IN_REPLY_ACTION, "retryable": True, "tool": _TOOL},
                              ensure_ascii=False)
        # check 可改用 document_id 核验已保存稿件；中间件自身抛错会被跳过，交给业务处理器说明。
        return next_call(rest)
    arguments = _reply_arguments(rest, session_id, content, turn_id)
    if args.get("action") == "check":
        with _LOCK:
            _CHECKED[(hermes_home_key(), session_id)] = {
                "turn_id": turn_id, "content": arguments["content"],
                "kind": arguments.get("kind") or "script", "name": arguments.get("name") or ""}
        return next_call(arguments)
    return _saved(session_id, next_call(arguments))


def take_checked(session_id, turn_id, name=None):
    """取出本轮核验过、尚未保存的正文；不跨轮，没有稿件名就无法另存。"""
    key = (hermes_home_key(), session_id)
    with _LOCK:
        checked = _CHECKED.get(key)
        if not checked or not turn_id or checked["turn_id"] != turn_id:
            return None
        name = (name if isinstance(name, str) and name.strip() else "") or checked["name"] or _NAMES.get(key)
        if not name:
            return None
        del _CHECKED[key]
    return {**checked, "name": name}


def _saved(session_id, result):
    try:
        data = json.loads(result) if isinstance(result, str) else None
    except ValueError:
        data = None
    if isinstance(data, dict) and data.get("ok") is not False:
        _forget_checked(session_id, data)
    return result


def _forget_checked(session_id, data):
    """真正存下稿件后，之前核验过的草稿不再补存。"""
    if isinstance(data.get("document"), dict) and data["document"].get("id"):
        with _LOCK:
            _CHECKED.pop((hermes_home_key(), session_id), None)


def _reply_arguments(args, session_id, content, turn_id="", *, merge=True):
    """两种流式保存入口共用稿件与名称处理，只有明确失败稿才进入既有返修合并。"""
    from . import requirement_control
    rest = dict(args)
    key = (hermes_home_key(), session_id)
    last = (requirement_control._current(session_id) or {}).get("last") or {}
    if merge and (last.get("report") or {}).get("status") == "fail":
        merged = _merge_partial(session_id, rest.get("kind", "script"), content)
        if merged:
            content = merged
        if merged or _revises_last_draft(session_id, rest.get("kind", "script"), content):
            # 同一轮失败稿的返修沿用原名；仅待核验的独立稿不因此被合并。
            with _LOCK:
                if _NAMES.get(key):
                    rest["name"] = _NAMES[key]
    with _LOCK:
        _USED[key] = content
        _USED_TURN[key] = turn_id
        if rest.get("action") == "save" and isinstance(rest.get("name"), str):
            _NAMES[key] = rest["name"]
    return {**rest, "content": content}


def _revises_last_draft(session_id, kind, content):
    """本轮上一稿未通过、这次稿件写的是同一批集：属于返修。"""
    from . import requirement_control
    from .requirement_checks import _episodes
    base = requirement_control.revision_base(session_id, kind)
    if not base:
        return False
    old = {row["episode_number"] for row in _episodes(base)}
    new = {row["episode_number"] for row in _episodes(content)}
    return bool(old and new and old & new)


def _merge_partial(session_id, kind, content):
    """本轮上一稿未通过核验、这次只重写了其中几集时，把重写的集替换进上一稿，按整批保存与核验。

    批量稿件（如第8—17集）常只有一两集字数不达标；整批重写会让用户再看一遍全部正文、等待翻倍，
    且返修次数有限时其他集也可能被改坏。
    """
    from . import requirement_control
    from .requirement_checks import merge_revised_episodes
    base = requirement_control.revision_base(session_id, kind)
    merged = merge_revised_episodes(base, content) if base else None
    return merged


def content_of(args, session_id) -> str | None:
    """工具参数中的正文；from_reply 调用返回宿主实际填入的正文。"""
    if isinstance(args, dict) and isinstance(args.get("content"), str):
        return args["content"]
    if isinstance(args, dict) and args.get("from_reply") is True:
        with _LOCK:
            return _USED.get((hermes_home_key(), session_id))
    return None

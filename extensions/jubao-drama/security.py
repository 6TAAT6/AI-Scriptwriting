"""创作账号的业务工具权限与资料路径边界；不替代进程隔离。"""

from contextlib import contextmanager
from copy import deepcopy
import json
import logging
import os
from pathlib import Path
import re
import stat

from hermes_constants import get_hermes_home


ALLOWED_TOOLS = frozenset({
    "drama_project_create", "drama_project_status", "drama_material_import", "drama_submit",
    "drama_confirm", "drama_review", "drama_export", "drama_rules_read", "todo_list", "clarify", "delegate_task", "image_generate",
    "skills_list", "skill_view", "drama_agent_document", "memory", "session_search",
})
_DENIED = "当前创作账号只允许处理本账号的剧本资料与创作流程。"
_DRAMA_TOOLS = frozenset({
    "drama_project_create", "drama_project_status", "drama_material_import", "drama_submit",
    "drama_confirm", "drama_review", "drama_export", "drama_rules_read", "drama_agent_document",
})
_DELEGATION_FIELDS = frozenset({"tasks", "goal", "context", "output_schema", "action", "subagent_id", "message"})
_DELEGATION_TASK_FIELDS = frozenset({"goal", "context", "output_schema", "group"})
_LOGGER = logging.getLogger(__name__)


def _blocked(error: str, reason: str, required_user_action: str, *, retryable: bool = False) -> str:
    """Return a machine-readable policy refusal so the model stops replaying the same call."""
    return json.dumps({
        "error": error,
        "blocked_reason": reason,
        "required_user_action": required_user_action,
        "retryable": retryable,
    }, ensure_ascii=False)


def _skill_selection_refusal(candidate, selected):
    from .agent_profiles import CAPABILITIES

    if candidate is None:
        return _blocked("未找到当前请求的创作能力。", "capability_not_found",
                        "请从输入框的 Agent 或独立技能菜单中选择需要的能力，再发送请求。")
    capability = CAPABILITIES[candidate]
    name = capability["display_name"]
    if capability["kind"] == "skill":
        return _blocked(f"当前对话尚未启用“{name}”。", "skill_invocation_required",
                        f"请从输入框的独立技能菜单选择“{name}”，再发送请求；已选的主 Agent 会保留。")
    if selected:
        current = CAPABILITIES[selected]["display_name"]
        return _blocked(f"当前对话已选择“{current}”，本次请求读取了“{name}”的规则。", "agent_mismatch",
                        f"请继续使用已选择的“{current}”处理当前任务；如需使用其他 Agent，请从 Agent 菜单明确选择后发送请求。")
    return _blocked("当前对话尚未成功选择剧本 Agent，暂时无法读取它的创作规则。", "agent_invocation_required",
                    f"请从输入框的 Agent 菜单选择“{name}”后发送请求；也可以在消息开头写“使用{name}。”并附上任务要求。")


def _delegation_allowed(args) -> bool:
    # 原生委派只继承父路由和工具；逐任务白名单阻止模型借未声明字段指定外部能力。
    if not isinstance(args, dict) or set(args) - _DELEGATION_FIELDS:
        return False
    action = args.get("action", "spawn")
    if not isinstance(action, str) or action.strip().lower() not in {"spawn", "list", "steer", "stop"}:
        return False
    if any(key in args and not isinstance(args[key], str) for key in ("goal", "context", "subagent_id", "message")):
        return False
    if "output_schema" in args and not isinstance(args["output_schema"], dict):
        return False
    tasks = args.get("tasks")
    if tasks is None and action.strip().lower() != "spawn":
        return True
    if not tasks:
        tasks = [{"goal": args.get("goal"), **({"context": args["context"]} if "context" in args else {})}]
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= 2:
        return False
    for task in tasks:
        if not isinstance(task, dict) or set(task) - _DELEGATION_TASK_FIELDS:
            return False
        if not isinstance(task.get("goal"), str) or not task["goal"].strip():
            return False
        if any(key in task and not isinstance(task[key], str) for key in ("context", "group")):
            return False
        if "output_schema" in task and not isinstance(task["output_schema"], dict):
            return False
    return True


def restricted() -> bool:
    # 账号目录是服务端分配的身份；配置异常不能使这类账号退回通用工具权限。
    if get_hermes_home().name.startswith("studio-"):
        return True
    from hermes_cli.config import load_config_readonly
    settings = load_config_readonly().get("studio_security") or {}
    return isinstance(settings, dict) and settings.get("restricted") is True


def _account_history_args(args):
    """只解析指向当前账号的历史链接，执行器继续使用已绑定的资料库。"""
    from hermes_cli.profiles import profile_matches_home

    if not isinstance(args, dict):
        return None
    profile = args.get("profile")
    session = args.get("session_id")
    if ((profile is not None and not isinstance(profile, str))
            or (session is not None and not isinstance(session, str))):
        return None
    profiles = [profile]
    if isinstance(session, str):
        if "\\" in session:
            return None
        if "/" in session:
            embedded, session = session.split("/", 1)
            if not embedded.strip() or not session.strip() or "/" in session:
                return None
            profiles.append(embedded)
    if any(value and value.strip() and not profile_matches_home(value, get_hermes_home()) for value in profiles):
        return None
    normalized = {key: value for key, value in args.items() if key != "profile"}
    if "session_id" in args:
        normalized["session_id"] = session
    return normalized


def tool_execution(tool_name, args, next_call, *, session_id="", **_kwargs):
    try:
        limited = restricted()
        from .agent_profiles import (
            CAPABILITIES, activation_required, active_agent, activate_agent, requested_agent,
        )
        from .capability_selection import active_skills, capability_for_skill
        strict = activation_required()
        candidate = capability_for_skill(args.get("name") if tool_name == "skill_view" and isinstance(args, dict) else "")
        if candidate and tool_name == "skill_view":
            # 用户展示名、裸技能名和命名空间技能名都落到注册表中的同一项。
            args = {**args, "name": "jubao-drama:" + CAPABILITIES[candidate]["skill"]}
        if strict:
            selected = active_agent(session_id)
            if tool_name == "skill_view":
                independent = candidate and CAPABILITIES[candidate]["kind"] == "skill"
                allowed = candidate in active_skills(session_id) if independent else candidate and (
                    candidate == selected or not selected and requested_agent(session_id) == candidate)
                if not allowed:
                    return _skill_selection_refusal(candidate, selected)
                if not independent and not selected:
                    activate_agent(session_id, candidate)
            if tool_name in _DRAMA_TOOLS - {"drama_material_import", "drama_agent_document"}:
                if not selected:
                    return _blocked("请先调用三个剧本 Agent 之一，再使用剧本创作工具。",
                                    "agent_invocation_required", "等待用户调用一个剧本 Agent 后再调用该工具。")
                if selected != "oa6-1":
                    return _blocked("当前 Agent 使用独立 skill 与 drama_agent_document，不使用 OA6.1 的改编工作流。",
                                    "agent_workflow_mismatch", "改用当前 Agent 支持的独立 skill/工具，或由用户切换到 OA6.1。")
            if tool_name == "drama_agent_document" and not selected and not active_skills(session_id):
                return _blocked("请先调用一个剧本 Agent 或独立技能。", "capability_required",
                                "等待用户调用一个剧本 Agent 或独立技能后再保存稿件。")
        if limited:
            if tool_name == "session_search":
                args = _account_history_args(args)
                if args is None:
                    return _blocked("历史检索仅支持当前账号的会话。", "account_history_scope_required",
                                    "请使用当前账号的关键词或会话编号重新检索。")
            if tool_name == "image_generate" and (not isinstance(args, dict) or set(args) - {"prompt", "aspect_ratio"}
                    or not isinstance(args.get("prompt"), str) or not 1 <= len(args["prompt"]) <= 12000
                    or args.get("aspect_ratio", "landscape") not in {"landscape", "portrait", "square"}):
                return _blocked("请提供图片描述和横向、竖向或方形比例，一次生成一张。",
                                "invalid_image_request", "修正图片描述或比例后再试。")
            from agent.delegation_context import is_delegated_child_context
            if tool_name == "delegate_task" and (is_delegated_child_context() or not _delegation_allowed(args)):
                return _blocked("请仅委派最多两个剧本子任务，沿用当前账号模型与业务工具；子代理不能继续委派。",
                                "delegation_policy_blocked", "减少为最多两个剧本子任务，并移除继续委派。")
            if tool_name == "drama_confirm" and is_delegated_child_context():
                return _blocked("正式剧本确认必须由主创作会话向用户发起，子代理只能返回分析与建议。",
                                "child_confirmation_forbidden", "由主创作会话向用户发起确认。")
    except Exception as exc:
        # 执行中间件抛错后框架会继续调用下一层，因此必须返回拒绝结果；但未知的
        # 状态库/IO/导入故障不是账号越权，不能伪装成永久权限拒绝。保留 fail-closed
        # 边界，同时让上层按短暂的安全检查故障处理，并留下可排障日志。
        _LOGGER.warning("剧本工具权限检查暂时失败（tool=%s）: %s", tool_name, exc, exc_info=True)
        return _blocked("创作权限校验暂时不可用，请稍后重试。", "security_check_unavailable",
                        "稍后重试同一操作；如果仍失败，请联系管理员检查创作服务。", retryable=True)
    if limited and ((tool_name == "skill_view" and not strict)
                    or tool_name not in ALLOWED_TOOLS
                    or not isinstance(session_id, str) or not session_id.strip()):
        return _blocked(_DENIED, "account_tool_not_allowed", "改用当前账号允许的剧本工具。")
    return next_call(args)


def data_path(value: Path, *, writing=False) -> tuple[Path, Path]:
    home = get_hermes_home().absolute()
    # 系统身份投影使用当前账号的展示别名，旧子任务与相对资料路径也必须能解析。
    parts = value.parts
    if parts and parts[0] == "[内部创作目录]":
        candidate = home.joinpath(*parts[1:])
    elif not value.is_absolute() and parts and parts[0] in {"attachments", "workspace"}:
        candidate = home / value
    else:
        candidate = value if value.is_absolute() else home / "workspace" / value
    roots = ("workspace",) if writing else ("attachments", "workspace")
    try:
        relative = candidate.relative_to(home)
    except ValueError:
        raise PermissionError(_DENIED) from None
    if len(relative.parts) < 2 or relative.parts[0] not in roots or any(
        part in {".", ".."} or part.startswith(".") for part in relative.parts
    ):
        raise PermissionError(_DENIED)
    return home, candidate


@contextmanager
def _parent_descriptor(candidate: Path, *, writing=False):
    home, candidate = data_path(candidate, writing=writing)
    # 逐级持有目录描述符，避免校验后父目录被替换为链接；不支持的平台安全拒绝。
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise PermissionError("当前运行环境尚未配置安全资料目录访问。")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(home, flags)
    try:
        for part in candidate.relative_to(home).parts[:-1]:
            if writing:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd, candidate.name
    except (OSError, NotImplementedError):
        raise PermissionError(_DENIED) from None
    finally:
        os.close(fd)


def read_document_bytes(source: Path, limit: int) -> bytes:
    if not restricted():
        if not source.is_file() or source.is_symlink():
            raise ValueError("材料必须是存在的普通文件，不能是目录或符号链接")
        with source.open("rb") as handle:
            return handle.read(limit + 1)
    with _parent_descriptor(source) as (directory, name):
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise PermissionError(_DENIED)
            return handle.read(limit + 1)


def write_document_bytes(target: Path, data: bytes) -> bytes:
    if not restricted():
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(target, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    else:
        with _parent_descriptor(target, writing=True) as (directory, name):
            try:
                descriptor = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                     0o600, dir_fd=directory)
            except FileExistsError:
                raise ValueError("文件已存在，请使用新文件名，原文件保留") from None
    # 从写入的同一描述符回读，不能重新按可变路径打开。
    with os.fdopen(descriptor, "w+b") as handle:
        handle.write(data)
        handle.flush()
        handle.seek(0)
        return handle.read()


def _product_instructions(text: str) -> str:
    from agent.prompt_builder import (
        DEFAULT_AGENT_IDENTITY, HERMES_AGENT_HELP_GUIDANCE, HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS,
    )
    for guidance in (DEFAULT_AGENT_IDENTITY, HERMES_AGENT_HELP_GUIDANCE, HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS):
        text = text.replace(guidance, "")
    text = re.sub(r"# Hermes runtime environment\b.*?<!-- End Hermes runtime environment -->", "", text, flags=re.S)
    paragraphs = text.split("\n\n")
    text = "\n\n".join(part for part in paragraphs if not part.startswith("Active Hermes profile:"))
    home = get_hermes_home()
    for internal in sorted({str(home), str(home.parent.parent), str(Path.home())}, key=len, reverse=True):
        if len(internal) > 1:
            text = text.replace(internal, "[内部创作目录]")
    return text.strip()


def llm_request(request, **_kwargs):
    if not restricted() or not isinstance(request, dict):
        return None
    changed = deepcopy(request)
    # 只变换请求中的系统身份段；用户稿件、历史回复和工具回执保持原字节内容。
    for key in ("messages", "input"):
        values = changed.get(key)
        if not isinstance(values, list):
            continue
        for message in values:
            if not isinstance(message, dict) or message.get("role") not in {"system", "developer"}:
                continue
            content = message.get("content")
            if isinstance(content, str):
                message["content"] = _product_instructions(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and isinstance(block.get("text"), str):
                        block["text"] = _product_instructions(block["text"])
    if isinstance(changed.get("instructions"), str):
        changed["instructions"] = _product_instructions(changed["instructions"])
    return {"request": changed}

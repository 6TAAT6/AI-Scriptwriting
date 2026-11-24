"""按本会话已启用的能力收窄发给模型的工具列表；执行层的权限检查保持不变，作为第二道防线。

历史数据里约四分之一的工具失败来自模型调用了当前 Agent 不能用的工具（例如在其他 Agent 下调用
OA6.1 的项目工具），每次都要等到执行时被拒绝再重试。模型看不到的工具就不会被误调用。
"""

from __future__ import annotations

from copy import deepcopy

OA6_ONLY = frozenset({"drama_project_create", "drama_project_status", "drama_submit", "drama_confirm",
                      "drama_review", "drama_export", "drama_rules_read"})
CREATIVE_ONLY = frozenset({"drama_story_bible", "drama_requirements"})
# 超级管理员 profile 带代码执行工具；创作中模型曾把整集剧本写进 Python 代码里，用户端看不到流式正文，
# 稿件也绕过了保存与核验。创作对话里不提供它。
# 子代理只读分析由 Studio restricted 安全边界控制；父会话可使用原生委派分析当前用户任务。
# 终端同理：超级管理员的创作对话里模型曾把整集正文写进 python -c 命令里数字数，用户看不到流式正文。
# 通用文件工具同理（只有超级管理员有）：模型曾用 read_file 每次 100—150 行地分四轮读完一份原稿，再用 search_files 翻找，
# 首次回复前耗时三分钟以上；创作对话改用 drama_material_import（一次读一至十万字，识别 docx/xlsx）与稿件工具。
NOT_IN_CREATIVE = frozenset({"execute_code", "terminal", "read_file", "search_files", "write_file", "patch"})
# 浏览器工具同理（只有超级管理员有）：测试版重放中模型在“扩写第4集”时启动浏览器，服务器上启动失败白等一轮。
NOT_IN_CREATIVE_PREFIXES = ("browser_",)
# 自带完整协议的 Agent（Vee）规定交付只在对话正文：不派子任务或后台任务、不弹提问卡、不另存稿件卡，
# 也不用宿主的设定库与要求清单（Vee R6/R8/R13/R22）。模型看不到这些工具，就不会被平台默认流程带偏。
OWN_PROTOCOL_HIDDEN = frozenset({"delegate_task", "clarify", "todo_list", "drama_agent_document",
                                 "drama_story_bible", "drama_requirements"})


def _name(tool):
    if not isinstance(tool, dict):
        return None
    return tool.get("name") or (tool.get("function") or {}).get("name")


def hidden_tools(session_id) -> frozenset:
    from .agent_profiles import activation_required, active_agent
    from .capability_selection import active_skills, requested_creative
    agent = active_agent(session_id) if session_id else None
    skills = active_skills(session_id) if session_id else []
    # 不选能力直接要稿件的对话同样是创作对话。
    creative = bool(agent or skills) or bool(session_id and requested_creative(session_id))
    hidden = set()
    # 未要求显式启用的运营 profile 仍按原逻辑默认走 OA6.1，因此只在明确不是 OA6.1 时隐藏。
    if agent and agent != "oa6-1" or not agent and activation_required():
        hidden |= OA6_ONLY
    from .agent_profiles import AGENT_PROFILES
    profile = AGENT_PROFILES.get(agent, {}) if agent else {}
    if profile.get("own_protocol"):
        # 自带协议的 Agent 可在能力条目 host_tools 里登记仍要用的宿主工具：小说 Agent 用稿件卡交付、
        # 用设定库维护连续性、用提问卡确认；Vee 没有登记，仍全部隐藏。
        hidden |= OWN_PROTOCOL_HIDDEN - frozenset(profile.get("host_tools", ()))
    if not creative:
        hidden |= CREATIVE_ONLY
    else:
        hidden |= NOT_IN_CREATIVE
    return frozenset(hidden)


def llm_request(request, *, session_id="", **_kwargs):
    if not isinstance(request, dict) or not isinstance(request.get("tools"), list) or not session_id:
        return None
    try:
        hidden = hidden_tools(session_id)
    except Exception:
        return None  # 能力状态暂时读不到时不改请求，执行层仍会拦截越权调用。
    prefixes = NOT_IN_CREATIVE_PREFIXES if hidden & NOT_IN_CREATIVE else ()
    blocked = lambda name: name in hidden or (isinstance(name, str) and name.startswith(prefixes) if prefixes else False)
    if not hidden or not any(blocked(_name(tool)) for tool in request["tools"]):
        return None
    changed = deepcopy(request)
    changed["tools"] = [tool for tool in changed["tools"] if not blocked(_name(tool))]
    choice = changed.get("tool_choice")
    if isinstance(choice, dict) and blocked(_name(choice)):
        changed["tool_choice"] = "auto"
    return {"request": changed}

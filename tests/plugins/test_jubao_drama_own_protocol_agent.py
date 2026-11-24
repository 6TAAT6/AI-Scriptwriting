"""自带完整协议的主 Agent（Vee）走真实注册与加载链路：规则原文完整加载，宿主通用创作工作流让路，其他 Agent 不受影响。"""

from contextlib import contextmanager
from copy import deepcopy
import importlib
import json
from pathlib import Path
import shutil

import pytest


SOURCE = Path(__file__).resolve().parents[2] / "extensions" / "jubao-drama"
SKILL = "jubao-agent-vee-2-1"
HOST_ONLY_TOOLS = ("delegate_task", "clarify", "todo_list", "drama_agent_document")


@contextmanager
def profile_scope(home):
    from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from tools.terminal_scope import reset_terminal_scope, set_terminal_scope

    home_token = set_hermes_home_override(home)
    secret_token = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
    terminal_token = set_terminal_scope({})
    try:
        yield
    finally:
        reset_terminal_scope(terminal_token)
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    from agent.secret_scope import is_multiplex_active, set_multiplex_active
    from hermes_cli.plugins import _reset_plugin_managers_for_tests, get_plugin_manager

    home = tmp_path / "studio-vee"
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(bundled))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    previous = is_multiplex_active()
    _reset_plugin_managers_for_tests()
    set_multiplex_active(True)
    try:
        shutil.copytree(SOURCE, home / "plugins" / "jubao-drama",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (home / "workspace").mkdir()
        (home / "attachments").mkdir()
        (home / "config.yaml").write_text(
            "plugins:\n  enabled: [jubao-drama]\nstudio_security:\n"
            "  restricted: true\n  require_agent_invocation: true\n", encoding="utf-8")
        with profile_scope(home):
            manager = get_plugin_manager()
            manager.discover_and_load()
            loaded = manager._plugins["jubao-drama"]
            assert loaded.error is None
            yield home, loaded.module
    finally:
        _reset_plugin_managers_for_tests()
        set_multiplex_active(previous)


def user_prompt(agent, body="原剧大纲如下：女主身患绝症。我想改成囊性纤维化。"):
    return ("【本轮语言偏好】\n简体中文\n【本轮创作能力】\n"
            + json.dumps({"agent": agent, "skills": []}, ensure_ascii=False)
            + "\n【本轮能力操作】\n" + json.dumps([{"id": agent, "action": "enable"}], ensure_ascii=False)
            + "\n\n【用户本轮消息】\n" + body)


def select(agent, session_id):
    from hermes_cli.lifecycle import invoke_hook
    text = user_prompt(agent)
    # 不提供 turn_id，避免触发与本回归无关的付费要求提取。
    invoke_hook("pre_llm_call", session_id=session_id, user_message=text)
    return text


def visible_tools(session_id):
    from hermes_cli.middleware import apply_llm_request_middleware
    names = (*HOST_ONLY_TOOLS, "drama_story_bible", "drama_requirements", "drama_material_import", "skill_view")
    request = {"messages": [{"role": "system", "content": "会话固定前缀"}, {"role": "user", "content": "继续"}],
               "tools": [{"type": "function", "function": {"name": name, "parameters": {"type": "object"}}} for name in names]}
    result = apply_llm_request_middleware(deepcopy(request), session_id=session_id)
    return {tool["function"]["name"] for tool in result.payload["tools"]}


def body(text):
    return text[text.index("\n---\n", 4) + len("\n---\n"):]


def test_vee_rules_load_verbatim_and_host_workflow_steps_aside_only_for_vee(runtime):
    from model_tools import handle_function_call

    home, module = runtime
    plugin = home / "plugins" / "jubao-drama"
    vee_prompt = select("vee-2-1", "vee-session")
    assert module.active_agent("vee-session") == "vee-2-1"
    loaded = json.loads(handle_function_call("skill_view", {"name": "jubao-drama:" + SKILL}, session_id="vee-session"))
    assert loaded.get("success"), loaded
    original = next((plugin / "skill-sources" / SKILL).glob("*.md")).read_text(encoding="utf-8")
    # 用户 11-18 批准把固定停顿句（原文两处）和语气表里四处 confirm 改成中文；其余正文必须逐字完整加载。
    english = '`⏸ Waiting for your confirmation — reply "confirm" to continue, or tell me exactly what to change.`'
    chinese = '`⏸ 等你确认——回复“确认”继续，或直接告诉我要改哪里。`'
    approved = body(original).replace(english, chinese).replace('`⏸ Waiting for your confirmation`', chinese)
    for before, after in (("行就 confirm，我起一卡集纲", "行就回确认，我起一卡集纲"), ("confirm 我接着跑", "回确认我接着跑"),
                          ("confirm 我就开工", "回确认我就开工"), ("只回 confirm 我就当你选 ①", "只回确认我就当你选 ①")):
        approved = approved.replace(before, after)
    assert approved in loaded["content"], "Vee 规则必须原文完整加载，除批准的中文停顿句外不得摘要或改写"
    assert "Waiting for your confirmation" not in loaded["content"]

    capsule = importlib.import_module(module.__name__ + ".capsule").CreativeCapsule(None)
    assert capsule._context(vee_prompt, "vee-session", "", []) is None, "Vee 会话不叠加宿主创作胶囊"
    vee_tools = visible_tools("vee-session")
    assert not vee_tools & set(HOST_ONLY_TOOLS), "Vee 会话不应看到子任务、提问卡、待办与稿件卡工具"
    assert {"drama_material_import", "skill_view"} <= vee_tools, "读取原剧材料与规则的工具必须保留"

    agent1_prompt = select("gm3-1", "agent1-session")
    assert capsule._context(agent1_prompt, "agent1-session", "", [])["context"], "其他 Agent 仍收到创作胶囊"
    assert {"delegate_task", "drama_agent_document"} <= visible_tools("agent1-session"), "其他 Agent 的工具不受影响"

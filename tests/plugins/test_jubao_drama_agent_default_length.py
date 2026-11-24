"""主 Agent 在能力目录里另设的剧本正文默认篇幅，经真实插件加载链路同时进入核验合同、要求清单与创作胶囊；
未设的 Agent 沿用产品默认，胶囊规则逐字不变。（2026-11-23 用户要求 Agent2.2 默认改为每集1400—1600汉字。）"""

from contextlib import contextmanager
import importlib
import json
from pathlib import Path
import shutil

import pytest


SOURCE = Path(__file__).resolve().parents[2] / "extensions" / "jubao-drama"


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

    home = tmp_path / "studio-length"
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
            yield loaded.module.__name__
    finally:
        _reset_plugin_managers_for_tests()
        set_multiplex_active(previous)


def select(agent, session_id):
    from hermes_cli.lifecycle import invoke_hook
    text = ("【本轮语言偏好】\n简体中文\n【本轮创作能力】\n" + json.dumps({"agent": agent, "skills": []})
            + "\n【本轮能力操作】\n" + json.dumps([{"id": agent, "action": "enable"}])
            + "\n\n【用户本轮消息】\n写第1集正文。")
    # 不提供 turn_id，避免触发与本回归无关的付费要求提取。
    invoke_hook("pre_llm_call", session_id=session_id, user_message=text)
    return text


def script(han):
    return "第1集\n\n1-1场  客厅  日  内\n\n人物：林岚\n\n△" + "林" * han + "。\n"


def test_agent_default_length_reaches_contract_requirements_and_capsule(runtime):
    package = runtime
    ledger = importlib.import_module(package + ".ledger")
    profiles = importlib.import_module(package + ".agent_profiles")
    checks = importlib.import_module(package + ".requirement_checks")
    capsule_module = importlib.import_module(package + ".capsule")
    scope_for = importlib.import_module(package + ".creative_scope").scope_for
    capsule = capsule_module.CreativeCapsule(None)

    custom = {key: row["default_script_length"] for key, row in profiles.AGENT_PROFILES.items()
              if row.get("default_script_length") and not row.get("own_protocol")}
    plain = next(key for key, row in profiles.AGENT_PROFILES.items()
                 if not row.get("default_script_length") and not row.get("own_protocol"))
    assert custom, "能力目录中应至少有一个另设默认篇幅的主 Agent"
    product = {key: ledger.DEFAULT_SCRIPT_LENGTH[key] for key in ("minimum", "maximum")}

    for agent_id, length in [*custom.items(), (plain, product)]:
        session = f"{agent_id}-session"
        prompt = select(agent_id, session)
        contract = ledger.check_contract(scope_for(session), session, "")
        default = next(row for row in contract["active_requirements"] if row["id"] == "default-script-length")
        assert {key: default["value"][key] for key in ("minimum", "maximum")} == length

        # 同一份稿件：落在本 Agent 默认区间中点的单集应通过，超过上限的应判未达标。
        middle = (length["minimum"] + length["maximum"]) // 2
        assert checks.check_draft(script(middle), "script", contract)["status"] != "fail"
        assert checks.check_draft(script(length["maximum"] + 50), "script", contract)["status"] == "fail"

        context = capsule._context(prompt, session, "", [])["context"]
        assert f"每集{length['minimum']}—{length['maximum']}个汉字" in context
        if agent_id == plain:
            assert capsule_module._RULES in context, "未另设默认篇幅的 Agent，胶囊规则必须逐字不变"
        else:
            assert capsule_module._PRODUCT_LENGTH_RULE not in context
            assert "每集1000—1200个汉字" not in context


def reply(session_id, api_request_id, content):
    """按宿主 turn_response_intake 的方式触发 post_api_request：模型只在回复里写出正文，没有调用保存。"""
    from agent.transports.types import NormalizedResponse
    from hermes_cli.lifecycle import invoke_hook

    message = NormalizedResponse(content=content, tool_calls=None, finish_reason="stop", provider_data=None)
    invoke_hook("post_api_request", session_id=session_id, turn_id=api_request_id.split(":")[0],
                api_request_id=api_request_id, assistant_message=message)


def test_short_draft_saved_at_turn_end_gets_one_length_repair_only_where_enabled(runtime):
    """测试版 11-23 五轮实测：模型写完不调保存，收尾补存判三集低于下限，自动续轮已关，员工拿到偏短稿。
    标了 length_revision 的 Agent 当轮只按字数返修一次、不夹带语义核验；返修后不再追加；其他 Agent 维持关闭。"""
    from hermes_cli.lifecycle import invoke_hook
    from model_tools import handle_function_call

    package = runtime
    profiles = importlib.import_module(package + ".agent_profiles")
    flagged = next(key for key, row in profiles.AGENT_PROFILES.items() if row.get("length_revision"))
    plain = next(key for key, row in profiles.AGENT_PROFILES.items()
                 if not row.get("length_revision") and not row.get("own_protocol") and key != "oa6-1")
    short = "".join(script(300).replace("第1集", f"第{n}集").replace("1-1场", f"{n}-1场") + "\n" for n in (1, 2, 3))

    def end_turn(agent, session, api_request_id, text):
        reply(session, api_request_id, text)
        return [row for row in invoke_hook("pre_verify", session_id=session, final_response=text)
                if isinstance(row, dict) and row.get("action") == "continue"]

    verdicts = {}
    for agent in (flagged, plain):
        session = agent + "-turn"
        prompt = select(agent, session).replace("写第1集正文。", "直接写第1—3集剧本正文。")
        invoke_hook("pre_llm_call", session_id=session, turn_id="t1", user_message=prompt,
                    conversation_history=[{"role": "user", "content": prompt}])
        skill = profiles.AGENT_PROFILES[agent]["skill"]
        assert json.loads(handle_function_call("skill_view", {"name": "jubao-drama:" + skill}, session_id=session)).get("success")
        verdicts[agent] = end_turn(agent, session, "t1:api:1", short)

    assert len(verdicts[flagged]) == 1, verdicts
    message = verdicts[flagged][0]["message"]
    assert "仅按字数修改一次" in message and "第1集正文" in message and "independent" not in message
    assert verdicts[plain] == [], "未标 length_revision 的 Agent 维持自动续轮关闭"
    assert end_turn(flagged, flagged + "-turn", "t1:api:2", short) == [], "同一稿件只返修一次"

"""剧本 Agent 必须按显式调用和会话范围隔离。"""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


def _agent_profiles():
    source = Path(__file__).resolve().parents[2] / "extensions" / "jubao-drama" / "agent_profiles.py"
    spec = spec_from_file_location("test_jubao_agent_profiles", source)
    module = module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_agent_catalog_uses_the_three_user_facing_names():
    module = _agent_profiles()

    assert [row["display_name"] for row in module.AGENT_PROFILES.values()] == [
        "巨豹 Agent-适配 OA6.1 版本",
        "巨豹 Agent-适配 GM3.1 版本",
        "巨豹 Agent-适配 GR4.7 版本",
    ]
    assert module.agent_for_skill("jubao-drama:jubao-agent-oa6-1") == "oa6-1"
    assert module.agent_for_skill("jubao-drama:jubao-agent-gm3-1") == "gm3-1"
    assert module.agent_for_skill("jubao-drama:jubao-agent-gr4-7") == "gr4-7"


def test_register_skills_exposes_every_declared_capability():
    module = _agent_profiles()
    registered = []

    class Context:
        def register_skill(self, name, path, description="", **_kwargs):
            registered.append((name, path.name, description))

    module.register_skills(Context())

    assert {name for name, _path, _description in registered} == {row["skill"] for row in module.CAPABILITIES.values()}
    assert all(path == "SKILL.md" for _name, path, _description in registered)
    assert all(description for _name, _path, description in registered)



def test_agent_activation_is_session_scoped_and_cannot_mix_rules(tmp_path, monkeypatch):
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    module = _agent_profiles()

    home = tmp_path / "studio-agent"
    home.mkdir()
    token = set_hermes_home_override(home)
    monkeypatch.setenv("HERMES_HOME", str(home))
    try:
        module.activate_agent("session-a", "gm3-1")
        module.activate_agent("session-b", "gr4-7")
        assert module.active_agent("session-a") == "gm3-1"
        assert module.active_agent("session-b") == "gr4-7"
        try:
            module.activate_agent("session-a", "oa6-1")
        except ValueError as error:
            assert "不能在同一会话混用" in str(error)
        else:
            raise AssertionError("同一会话不应切换到第二个剧本 Agent")
    finally:
        reset_hermes_home_override(token)

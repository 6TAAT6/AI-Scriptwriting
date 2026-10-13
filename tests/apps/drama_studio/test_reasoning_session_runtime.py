"""用真实会话与 AIAgent 验证思考参数传递；全程禁止外连与模型生成。"""

import json
from pathlib import Path
import socket

import hermes_yaml as yaml


def test_native_reasoning_rpc_preserves_profile_defaults_and_other_session(tmp_path, monkeypatch):
    from hermes_cli import plugins
    from run_agent import AIAgent
    from tui_gateway import server

    root = tmp_path / ".hermes"
    root.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setenv("HERMES_IGNORE_RULES", "1")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(server, "_hermes_home", root)
    # 固定开始构建的时机；真实构建函数、配置解析、会话存储与 RPC 均保持原实现。
    monkeypatch.setattr(server, "_schedule_agent_build", lambda *_args: None)
    events = []
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload: events.append((event, sid, payload)))

    def deny_network(*_args, **_kwargs):
        raise AssertionError("本验证不允许发起网络请求")

    monkeypatch.setattr(socket.socket, "connect", deny_network)
    monkeypatch.setattr(socket.socket, "connect_ex", deny_network)
    homes = {"default": root, "alpha": root / "profiles" / "alpha", "beta": root / "profiles" / "beta"}
    before = {}
    for name, home in homes.items():
        home.mkdir(parents=True, exist_ok=True)
        config = {
            "model": {"provider": "studio-fixture", "default": "gpt-6.1-sol"},
            "providers": {"studio-fixture": {"base_url": "http://127.0.0.1:1/v1", "key_env": "STUDIO_FIXTURE_API_KEY",
                "transport": "codex_responses", "models": ["gpt-6.1-sol"], "discover_models": False}},
            "agent": {"reasoning_effort": "medium", "environment_probe": False, "coding_context": "off"},
            "toolsets": ["no_mcp"], "platform_toolsets": {"web": ["no_mcp"]},
            "memory": {"memory_enabled": False, "user_profile_enabled": False},
            "skills": {"project_discovery": False, "auto_load": []},
            "terminal": {"cwd": str(home)}, "telemetry": {"shared_metrics": {"enabled": False, "send": False}},
        }
        (home / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
        (home / ".env").write_text("STUDIO_FIXTURE_API_KEY=local-test-no-provider-access\n", encoding="utf-8")
        before[name] = (home / "config.yaml").read_bytes()
    plugins._reset_plugin_managers_for_tests()
    created = {}

    def rpc(method, params):
        result = server.handle_request({"id": "reasoning-test", "method": method, "params": params})
        assert "error" not in result, result
        return result["result"]

    try:
        for profile, effort in [("alpha", "high"), ("beta", "low")]:
            result = rpc("session.create", {"profile": profile, "source": "web", "model": "gpt-6.1-sol",
                "provider": "studio-fixture", "reasoning_effort": effort, "cwd": str(homes[profile])})
            sid = result["session_id"]
            session = server._sessions[sid]
            created[profile] = (sid, session)
            assert session["create_reasoning_override"] == {"enabled": True, "effort": effort}
            server._start_agent_build(sid, session)
            assert session["agent_ready"].wait(20), "真实 AIAgent 未及时完成构建"
            assert not session.get("agent_error"), session.get("agent_error")
            agent = session["agent"]
            assert isinstance(agent, AIAgent)
            assert agent.reasoning_config == {"enabled": True, "effort": effort}
            assert agent._api_call_count == 0
            info = next(payload for event, event_sid, payload in reversed(events) if event == "session.info" and event_sid == sid)
            assert info["reasoning_effort"] == effort
            assert info["reasoning_effort_wire"] == effort
            assert server._ensure_session_db_row(session)

        # A → B → A：修改 A 的会话值不能污染 B 或任何账号的全局默认配置。
        sid, alpha = created["alpha"]
        changed = rpc("config.set", {"profile": "alpha", "session_id": sid, "key": "reasoning", "value": "xhigh", "scope": "session"})
        assert changed["value"] == "xhigh"
        assert alpha["agent"].reasoning_config == {"enabled": True, "effort": "xhigh"}
        info = next(payload for event, event_sid, payload in reversed(events) if event == "session.info" and event_sid == sid)
        assert info["reasoning_effort"] == info["reasoning_effort_wire"] == "xhigh"
        assert rpc("config.get", {"profile": "beta", "session_id": created["beta"][0], "key": "reasoning"})["value"] == "low"
        assert rpc("config.get", {"profile": "alpha", "session_id": sid, "key": "reasoning"})["value"] == "xhigh"
        for profile, home in homes.items():
            assert (home / "config.yaml").read_bytes() == before[profile]
        for _sid, session in created.values():
            assert session["agent"]._api_call_count == 0
        stored = alpha["agent"]._session_db.get_session(alpha["session_key"])
        model_config = stored["model_config"]
        if isinstance(model_config, str):
            model_config = json.loads(model_config)
        assert model_config["reasoning_config"] == {"enabled": True, "effort": "xhigh"}
    finally:
        for sid, _session in created.values():
            rpc("session.close", {"session_id": sid})
        plugins._reset_plugin_managers_for_tests()

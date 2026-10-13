"""A local selection must survive session.info, a new chat and stored-session resume."""
from types import SimpleNamespace

import pytest

from hermes_cli import runtime_provider as rp
from hermes_cli.local_runtime import endpoint
from tui_gateway import server


@pytest.fixture
def local_route(tmp_path, monkeypatch):
    cfg = {"model": {"provider": "anthropic", "default": "claude-test"},
           "local_runtime": {"enabled": True}}
    monkeypatch.setattr(rp, "load_config", lambda: cfg)
    monkeypatch.setattr(rp, "_get_model_config", lambda: cfg["model"])
    monkeypatch.setattr("hermes_cli.config.load_config", lambda: cfg)
    monkeypatch.setattr(server, "_load_cfg", lambda: cfg)
    route = {"base_url": "http://127.0.0.1:18434/v1", "api_key": "local-test-key"}
    monkeypatch.setattr(endpoint, "_state_endpoint", lambda: route)
    monkeypatch.setattr(endpoint, "resolve_llamacpp_endpoint", lambda **kw: route)
    monkeypatch.setattr(server, "_probe_credentials", lambda agent: None)
    monkeypatch.setattr("hermes_cli.banner.get_update_result", lambda **kw: None)
    monkeypatch.setattr("hermes_cli.banner.get_available_skills", lambda: {})
    return route, {"cwd": str(tmp_path), "session_key": "local-identity"}


def test_live_local_identity_survives_new_chat_and_resume(local_route):
    route, session = local_route
    model = "Local.Model-Q4_K_M"
    runtime = rp.resolve_runtime_provider(requested="llamacpp", target_model=model)
    agent = SimpleNamespace(model=model, provider=runtime["provider"], base_url=runtime["base_url"],
                            api_mode=runtime["api_mode"], reasoning_config=None, service_tier=None,
                            session_id=session["session_key"])
    # The renderer carries these two fields into the next session.create.
    info = server._session_info(agent, session)
    assert info["provider"] == "llamacpp"
    assert info["model"] == model
    next_model, next_runtime = server._resolve_agent_model_runtime(
        {"model": info["model"], "provider": info["provider"]}, None)
    assert next_model == model and next_runtime["base_url"] == route["base_url"]
    assert next_runtime["api_key"] == route["api_key"]
    persisted = server._runtime_model_config(agent)
    assert persisted["provider"] == "llamacpp"
    assert "api_key" not in persisted
    # Legacy rows kept the local endpoint but lost the provider slug.
    for provider in ("custom", "llamacpp"):
        row = {"model": model, "model_config": {**persisted, "provider": provider}}
        overrides = server._stored_session_runtime_overrides(row)
        restored_model, restored = server._resolve_agent_model_runtime(
            overrides["model_override"], overrides.get("provider_override"))
        assert restored_model == model
        assert restored["base_url"] == route["base_url"]
        assert restored["api_key"] == route["api_key"]
    # Pending picks and compute-host mirrors still own the reported identity.
    session["pending_model_switch"] = {"display_model": "claude-test", "display_provider": "anthropic"}
    assert server._session_info(agent, session)["provider"] == "anthropic"


def test_resume_follows_live_managed_port_not_snapshot(local_route):
    """A llamacpp session that stored last boot's loopback URL must follow the
    live supervisor after the managed server moves to another port."""
    route, _session = local_route
    model = "Local.Model-Q4_K_M"
    stale = "http://127.0.0.1:51489/v1"
    row = {"model": model, "model_config": {
        "model": model, "provider": "llamacpp", "base_url": stale,
        "api_mode": "chat_completions"}}
    overrides = server._stored_session_runtime_overrides(row)
    restored_model, restored = server._resolve_agent_model_runtime(
        overrides["model_override"], overrides.get("provider_override"))
    assert restored_model == model
    assert restored["base_url"] == route["base_url"]
    assert restored["base_url"] != stale
    assert restored["api_key"] == route["api_key"]


def test_session_info_recovers_identity_from_the_owning_profile(tmp_path, monkeypatch):
    import json
    from pathlib import Path

    from hermes_constants import get_hermes_home

    launch = tmp_path / "launch"
    secondary = launch / "profiles" / "secondary"
    secondary.mkdir(parents=True)
    url = "https://session-endpoint.invalid/v1"
    for home, name in ((launch, "launch-route"), (secondary, "secondary-route")):
        config = {"model": {"provider": "anthropic", "default": "claude-test"},
                  "providers": {name: {"api": url, "models": ["same-model"]}}}
        (home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(launch))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(server, "_hermes_home", launch)
    monkeypatch.setattr(server, "_probe_credentials", lambda agent: None)
    monkeypatch.setattr("hermes_cli.banner.get_update_result", lambda **kw: None)
    monkeypatch.setattr("hermes_cli.banner.get_available_skills", lambda: {})
    agent = SimpleNamespace(model="same-model", provider="custom", base_url=url,
                            reasoning_config=None, service_tier=None, session_id="profile-identity")
    session = {"cwd": str(tmp_path), "session_key": "profile-identity", "profile_home": str(secondary)}
    # Broadcast/resume can publish metadata outside the session's profile scope.
    assert server._session_info(agent, session)["provider"] == "custom:secondary-route"
    assert get_hermes_home() == launch
    # A launch-profile session must also ignore an ambient secondary-profile scope.
    with server._profile_build_scope(secondary):
        assert server._session_info(agent, {**session, "profile_home": None})["provider"] == "custom:launch-route"
        assert get_hermes_home() == secondary
    assert get_hermes_home() == launch
    # Remote compute metadata remains authoritative; never reinterpret it using local profiles.
    session["_metadata_mirror"] = {"model": "remote-model", "provider": "custom:remote-route"}
    assert server._session_info(agent, session)["provider"] == "custom:remote-route"


def test_local_identity_never_claims_an_unrelated_endpoint(local_route):
    route, _ = local_route
    assert rp.canonical_custom_identity(base_url=route["base_url"]) == "llamacpp"
    assert rp.canonical_custom_identity(base_url="http://127.0.0.1:18435/v1") is None
    assert rp.canonical_custom_identity(base_url="https://api.anthropic.com") is None
    assert rp.canonical_custom_identity(model="Local.Model-Q4_K_M") is None



@pytest.fixture
def studio_routes(tmp_path, monkeypatch):
    """真实配置、密钥作用域和本机 HTTP 服务，避免模拟 provider 返回值掩盖身份变化。"""
    from contextlib import contextmanager
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import importlib.util
    import json
    from pathlib import Path
    import threading

    from agent.secret_scope import (build_profile_secret_scope, is_multiplex_active,
                                    reset_secret_scope, set_multiplex_active, set_secret_scope)
    from hermes_cli.config import atomic_config_replace
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    source = Path(__file__).resolve().parents[2] / "apps/drama-studio/server/profiles.py"
    spec = importlib.util.spec_from_file_location("studio_resume_profiles", source)
    profiles = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(profiles)
    expected = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            token = expected.get(self.path)
            accepted = bool(token and self.headers.get("Authorization") == "Bearer " + token)
            self.send_response(200 if accepted else 403)
            self.end_headers()
            self.wfile.write(json.dumps({"accepted": accepted}).encode())

        def log_message(self, *_args):
            pass

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    rows = []
    for label in ("a", "b"):
        home = tmp_path / label
        home.mkdir()
        route = {"base_url": f"http://127.0.0.1:{http.server_port}/scope/{label * 32}/v1",
                 "token": "fixture-" + label * 40, "model": "gpt-6-astra",
                 "models": ["gpt-6-astra"], "api_mode": "chat_completions"}
        route["providers"] = [{"id": "secondary", "name": "第二接入", **route,
            "base_url": f"http://127.0.0.1:{http.server_port}/scope/{('c' if label == 'a' else 'd') * 32}/v1",
            "model": "gpt-6.1-sol", "models": ["gpt-6.1-sol"], "api_mode": "responses"}]
        cfg = profiles._config(home, profiles._inference_route(route))
        atomic_config_replace(home / "config.yaml", cfg)
        (home / ".env").write_text("STUDIO_INFERENCE_TOKEN=" + route["token"] + "\n")
        for entry in [route, *route["providers"]]:
            from urllib.parse import urlsplit
            expected[urlsplit(entry["base_url"]).path + "/models"] = route["token"]
        rows.append((home, cfg, route["token"]))

    @contextmanager
    def scope(home):
        h = set_hermes_home_override(home)
        s = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
        try:
            yield
        finally:
            reset_secret_scope(s)
            reset_hermes_home_override(h)

    previous = is_multiplex_active()
    set_multiplex_active(True)
    try:
        yield rows, scope
    finally:
        set_multiplex_active(previous)
        http.shutdown()
        http.server_close()
        thread.join(timeout=3)


def test_restricted_studio_resume_uses_current_routes_across_profiles(studio_routes):
    """A→B→A 恢复默认及第二接入，历史地址、协议与凭证都不能覆盖当前账号代理。"""
    import json
    from urllib.request import Request, urlopen

    rows, scope = studio_routes
    for home, cfg, token in [rows[0], rows[1], rows[0]]:
        with scope(home):
            for identity, provider_cfg in cfg["providers"].items():
                model = next(iter(provider_cfg["models"]))
                current = rp.resolve_runtime_provider(requested=identity, target_model=model)
                assert current["provider"] == "custom"
                saved = server._runtime_model_config(SimpleNamespace(
                    model=model, provider=current["provider"], base_url=current["base_url"],
                    api_mode=current["api_mode"], reasoning_config=None, service_tier=None))
                assert saved["provider"] == "custom:" + identity
                saved.update(base_url="http://127.0.0.1:1/expired/v1", api_mode="invalid_old_mode")
                persisted = server._stored_session_runtime_overrides({"model": model, "model_config": saved})
                for requested in (persisted["model_override"]["provider"], identity, "custom"):
                    override = {**persisted["model_override"], "provider": requested,
                                "api_key": "expired-fixture-key"}
                    restored_model, runtime = server._resolve_agent_model_runtime(override, None)
                    assert restored_model == model
                    assert runtime["base_url"] == current["base_url"]
                    assert runtime["api_mode"] == current["api_mode"]
                    assert runtime["api_key"] == token
                    request = Request(runtime["base_url"].rstrip("/") + "/models",
                                      headers={"Authorization": "Bearer " + runtime["api_key"]})
                    with urlopen(request, timeout=3) as response:
                        assert json.load(response)["accepted"] is True


def test_unrestricted_resume_preserves_custom_route(studio_routes):
    """相同自定义接入未启用 Studio 隔离时，会话明确指定的运行参数仍然有效。"""
    from hermes_cli.config import atomic_config_replace

    rows, scope = studio_routes
    home, cfg, _token = rows[0]
    cfg["studio_security"]["restricted"] = False
    atomic_config_replace(home / "config.yaml", cfg)
    with scope(home):
        _, runtime = server._resolve_agent_model_runtime({
            "model": "gpt-6-astra", "provider": "custom:studio-inference",
            "base_url": "http://127.0.0.1:1/explicit/v1", "api_mode": "chat_completions",
            "api_key": "explicit-fixture-key"}, None)
        assert runtime["base_url"] == "http://127.0.0.1:1/explicit/v1"
        assert runtime["api_key"] == "explicit-fixture-key"

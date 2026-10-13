"""平台新增接入通过真实配置、密钥和目录解析链路进入隔离账号。"""
import importlib.util
from pathlib import Path


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parents[3]
PROFILES = load_module("studio_model_profiles", ROOT / "apps/drama-studio/server/profiles.py")
SETTINGS = load_module("studio_model_settings", ROOT / "apps/drama-studio/server/worker-settings.py")


def test_saved_custom_provider_resolves_through_isolated_catalog_and_runtime(tmp_path, monkeypatch):
    from hermes_cli.config import atomic_config_replace, read_user_config_raw
    from hermes_cli.web_routers.config_env import upsert_custom_endpoint
    from hermes_cli.web_models import CustomEndpointUpdate
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from agent.secret_scope import build_profile_secret_scope, set_secret_scope, reset_secret_scope, is_multiplex_active, set_multiplex_active
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from hermes_cli.inventory import build_model_options_payload, load_picker_context

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    home = tmp_path / "hermes"
    monkeypatch.setenv("HERMES_HOME", str(home))
    owner = home / "profiles/jubao-drama"
    owner.mkdir(parents=True)
    atomic_config_replace(owner / "config.yaml", {"model": {"provider": "owner", "default": "original-model", "base_url": "https://first.invalid/v1"}, "providers": {"owner": {"base_url": "https://first.invalid/v1", "model": "original-model", "models": ["original-model"], "key_env": "FIRST_KEY"}}})
    (owner / ".env").write_text("FIRST_KEY=first-fixture-secret\n")
    result = upsert_custom_endpoint(CustomEndpointUpdate(name="second", base_url="https://second.invalid/v1", model="second-model", models=["second-model"], api_mode="codex_responses", api_key="second-fixture-secret", discover_models=False), profile="jubao-drama")
    assert result["ok"]
    raw = read_user_config_raw(owner / "config.yaml")
    assert "second-fixture-secret" not in (owner / "config.yaml").read_text()
    assert raw["providers"][result["id"]]["key_env"]
    settings = SETTINGS.read_settings(home)
    assert settings["providers"][0]["apiKey"] == "second-fixture-secret"
    assert settings["providers"][0]["apiMode"] == "responses"
    route = {"base_url": "http://127.0.0.1:45200/scope/" + "a" * 32 + "/v1", "token": "scope-fixture-" + "a" * 40, "model": "original-model", "models": ["original-model"], "api_mode": "chat_completions"}
    route["providers"] = [{"id": "second", "name": "第二接入", **route, "base_url": "http://127.0.0.1:45200/scope/" + "b" * 32 + "/v1", "model": "second-model", "models": ["second-model"], "api_mode": "responses"}]
    created = PROFILES.provision("studio-" + "a" * 20, route, workers_root=home / "studio-workers")
    worker = Path(created["home"])
    contents = (worker / "config.yaml").read_text() + (worker / ".env").read_text()
    assert "second-fixture-secret" not in contents and "second.invalid" not in contents
    assert contents.count("scope-fixture-") == 1
    route_b = {**route, "token": "scope-fixture-" + "b" * 40}
    route_b["providers"] = [{**route["providers"][0], "token": route_b["token"], "model": "second-b", "models": ["second-b"]}]
    worker_b = Path(PROFILES.provision("studio-" + "b" * 20, route_b, workers_root=home / "studio-workers")["home"])
    previous = is_multiplex_active()
    set_multiplex_active(True)
    try:
        for workspace, expected in ((worker, route), (worker_b, route_b), (worker, route)):
            h = set_hermes_home_override(workspace)
            s = set_secret_scope(build_profile_secret_scope(workspace), profile_home=str(workspace))
            try:
                config = read_user_config_raw(workspace / "config.yaml")
                slug = next(key for key in config["providers"] if key != "studio-inference")
                runtime = resolve_runtime_provider(requested=slug)
                assert runtime["api_key"] == expected["token"]
                assert runtime["base_url"].rstrip("/") == expected["providers"][0]["base_url"]
                assert runtime["api_mode"] == "codex_responses"
                payload = build_model_options_payload(load_picker_context(), explicit_only=True, include_unconfigured=False)
                models = [model for row in payload["providers"] for model in row["models"]]
                assert expected["providers"][0]["model"] in models
                assert ("second-b" if workspace == worker else "second-model") not in models
            finally:
                reset_secret_scope(s)
                reset_hermes_home_override(h)
    finally:
        set_multiplex_active(previous)


def test_edge_replaces_saved_model_list_through_real_hermes_http(tmp_path, monkeypatch):
    import json
    import socket
    import subprocess
    import threading
    from fastapi import FastAPI
    import uvicorn
    import httpx
    from hermes_cli.config import atomic_config_replace, read_user_config_raw
    from hermes_cli.web_routers.config_env import router, config_router

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    home = tmp_path / "hermes"
    monkeypatch.setenv("HERMES_HOME", str(home))
    owner = home / "profiles/jubao-drama"
    owner.mkdir(parents=True)
    metadata = {"context_length": 65536, "supports_reasoning": True, "custom_setting": "保留元数据", "name": "保留显示名称"}
    atomic_config_replace(owner / "config.yaml", {
        "model": {"provider": "owner", "default": "source-model"},
        "providers": {
            "owner": {"base_url": "https://original.invalid/v1", "model": "source-model", "models": ["source-model"], "key_env": "MODELS_KEY"},
            "studio-test": {"name": "待修改接入", "base_url": "https://models.invalid/v1", "model": "model-a",
                            "models": {"model-a": metadata, "model-b": {"context_length": 32768}},
                            "key_env": "MODELS_KEY", "api_mode": "chat_completions", "discover_models": False,
                            "extra_headers": {"X-Tenant": "保留租户字段"}},
        },
        "display": {"language": "zh"},
    })
    secret = "fixture-replacement-private-key"
    (owner / ".env").write_text("MODELS_KEY=" + secret + "\n")
    before_env = (owner / ".env").read_bytes()
    runtime = load_module("studio_model_runtime_boundary", ROOT / "apps/drama-studio/server/runtime.py")
    app = FastAPI()
    app.include_router(config_router)
    app.include_router(router)
    @app.get("/{full_path:path}")
    def dashboard_fallback(full_path: str):
        from fastapi.responses import JSONResponse
        return JSONResponse({"error": "不是页面资源"}, status_code=404)
    adapter = load_module("studio_model_http_adapter", ROOT / "apps/drama-studio/server/model_settings.py")
    token = "fixture-runtime-token-" + "x" * 32
    runtime.configure_app(app, adapter.router, token)
    ready = threading.Event()

    class ReadyServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            ready.set()

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    server = ReadyServer(uvicorn.Config(app, log_level="error", access_log=False, ws="none"))
    thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
    thread.start()
    try:
        assert ready.wait(10), "临时 Hermes HTTP 服务未能就绪"
        script = '''
import { createModelSettingsService } from PROCESS_MODULE
let result
const input = JSON.parse(await new Promise(resolve => { let text = ''; process.stdin.on('data', chunk => text += chunk); process.stdin.on('end', () => resolve(text)) }))
const service = { endpoint: new URL(input.endpoint), token: async () => input.token }
const store = { authenticate: () => ({ user: { role: 'super_admin', profile: 'jubao-drama' } }) }
const handler = createModelSettingsService({ service, store })
const response = { setHeader() {}, end(body) { result = JSON.parse(body) } }
await handler.handle({ method: 'POST' }, response, new URL('http://localhost/studio/admin/models'), { token: 'test-account-cookie' }, input.body)
process.stdout.write(JSON.stringify(result))
'''.replace("PROCESS_MODULE", json.dumps((ROOT / "apps/drama-studio/server/model-settings.mjs").as_uri()))
        body = {"id": "studio-test", "name": "待修改接入", "base_url": "https://models.invalid/v1", "model": "model-a", "models": ["model-a"], "api_mode": "chat_completions", "image_model": "gpt-image-2", "image_models": ["gpt-image-2"]}
        endpoint = f"http://127.0.0.1:{listener.getsockname()[1]}"
        with httpx.Client(base_url=endpoint, trust_env=False) as client:
            assert client.get("/api/studio/model-endpoints", params={"profile": "jubao-drama"}, headers={"X-Hermes-Session-Token": token}).status_code == 200
            assert client.post("/api/studio/model-endpoints", params={"profile": "jubao-drama"}, json=body).status_code == 401
            assert client.post("/api/studio/model-endpoints", params={"profile": "other-profile"}, json=body, headers={"X-Hermes-Session-Token": token}).status_code == 403
        result = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps({"endpoint": endpoint, "token": token, "body": body}), text=True, capture_output=True, timeout=30)
        assert result.returncode == 0, result.stderr
        saved = json.loads(result.stdout)
        row = next(row for row in saved["endpoints"] if row["id"] == body["id"])
        assert row["models"] == ["model-a"]
        raw = read_user_config_raw(owner / "config.yaml")
        provider = raw["providers"][body["id"]]
        assert provider["models"] == {"model-a": metadata}
        assert provider["key_env"] == "MODELS_KEY"
        assert provider["extra_headers"] == {"X-Tenant": "保留租户字段"}
        assert row["image_model"] == "gpt-image-2"
        assert raw["image_gen"]["studio_endpoints"]["studio-test"]["models"] == ["gpt-image-2"]
        assert raw["image_gen"]["openai"] == {"provider": "studio-test", "model": "gpt-image-2"}
        settings = SETTINGS.read_settings(home)
        image_route = next(row for row in settings["providers"] if row["imageModel"] == "gpt-image-2")
        assert image_route["imageModels"] == ["gpt-image-2"]
        assert image_route["models"] == ["model-a"]
        assert raw["model"]["default"] == "source-model"
        assert raw["display"]["language"] == "zh"
        assert (owner / ".env").read_bytes() == before_env
        assert secret not in (owner / "config.yaml").read_text() + result.stdout + result.stderr
    finally:
        server.should_exit = True
        thread.join(10)
        listener.close()
        assert not thread.is_alive()

"""在可信父进程读取模型连接，仅通过私有子进程管道交给代理。"""
from pathlib import Path
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
import sys


def _connection(provider, credentials, model=None, images=None):
    from hermes_cli.providers import TRANSPORT_TO_API_MODE

    if provider.get("enabled") is False:
        raise ValueError("当前模型接入已停用")
    model = model or {}
    key_env = model.get("key_env") or provider.get("key_env")
    key = credentials.get(key_env) if key_env else None
    if not key:
        key = model.get("api_key") or provider.get("api_key")
    default = model.get("default") or provider.get("model")
    models = provider.get("models") or {}
    models = list(models) if isinstance(models, (dict, list)) else []
    if default is None and models:
        default = models[0]
    if default not in models:
        models.append(default)
    endpoint = model.get("base_url") or provider.get("base_url")
    mode = provider.get("api_mode") or provider.get("transport") or model.get("api_mode") or "chat_completions"
    if not isinstance(mode, str):
        raise ValueError("模型连接协议不支持")
    mode = TRANSPORT_TO_API_MODE.get(mode, mode)
    if mode == "codex_responses":
        mode = "responses"
    if not all(isinstance(value, str) and value for value in (key, default, endpoint)):
        raise ValueError("模型连接未配置完整")
    if mode not in {"chat_completions", "responses"}:
        raise ValueError("模型连接协议不支持")
    images = images or {}
    fields = ('context_length', 'supported_efforts', 'default_reasoning_effort')
    entries = provider.get('models') or {}
    metadata = {name: {field: entry[field] for field in fields if field in entry}
                for name, entry in entries.items() if name in models and isinstance(entry, dict)} if isinstance(entries, dict) else {}
    metadata = {name: entry for name, entry in metadata.items() if entry}
    return {"baseUrl": endpoint, "apiKey": key, "models": models, "defaultModel": default, "apiMode": mode,
            "imageModels": images.get("models") or [], "imageModel": images.get("model") or "",
            **({'modelMetadata': metadata} if metadata else {})}


def _profile_connections(credentials):
    from hermes_cli.config import load_config
    from hermes_cli.runtime_provider import resolve_runtime_provider

    config = load_config()
    model = config.get("model") or {}
    entries = config.get("providers") or {}
    current = str(model.get("provider", "")).removeprefix("custom:")
    provider = entries.get(current, {})
    images = (config.get("image_gen") or {}).get("studio_endpoints") or {}
    main = _connection(provider, credentials, model, images.get(current))
    # 同一份运营配置必须与真正执行模型请求的 Hermes 解析链保持一致。
    resolved = resolve_runtime_provider(requested=model.get("provider"), target_model=main["defaultModel"])
    mode = resolved.get("api_mode")
    mode = "responses" if mode == "codex_responses" else mode
    if mode not in {"chat_completions", "responses"}:
        raise ValueError("模型连接协议不支持")
    if not all(isinstance(resolved.get(field), str) and resolved[field] for field in ("api_key", "base_url")):
        raise ValueError("模型连接未配置完整")
    main.update(apiKey=resolved["api_key"], baseUrl=resolved["base_url"], apiMode=mode)
    providers = []
    for identifier, entry in entries.items():
        if identifier == current or not isinstance(entry, dict) or entry.get("enabled") is False:
            continue
        try:
            connection = _connection(entry, credentials, images=images.get(identifier))
        except ValueError:
            continue
        providers.append({"id": "provider-" + hashlib.sha256(str(identifier).encode()).hexdigest()[:24],
                          "name": f"创作模型服务 {len(providers) + 2}", **connection})
    timeouts = (config.get("studio_inference") or {}).get("timeouts_ms")
    return {**main, "providers": providers, **({"timeouts": timeouts} if timeouts is not None else {})}


def read_settings(home, native_runtime=False):
    from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    source = Path(home) / "profiles" / "jubao-drama"
    home_token = set_hermes_home_override(source)
    try:
        credentials = build_profile_secret_scope(source)
        secret_token = set_secret_scope(credentials, profile_home=str(source))
        try:
            connections = _profile_connections(credentials)
        finally:
            reset_secret_scope(secret_token)
    finally:
        reset_hermes_home_override(home_token)
    repo = Path(__file__).resolve().parents[3]
    if native_runtime:
        python_path = os.environ.get("PYTHONPATH", str(repo))
    else:
        from pm.environments import activation_environment
        python_path = activation_environment(repo).get("PYTHONPATH", str(repo))
    return {
        **connections,
        "python": sys.executable,
        "pythonPath": python_path,
        "pythonPaths": [str(Path(sys.base_prefix).resolve()), str(Path(sys.prefix).resolve()),
                        *[part for part in python_path.split(os.pathsep)
                          if part and Path(part).resolve() != repo.resolve()]],
    }


if __name__ == "__main__":
    try:
        if sys.argv[2:] not in ([], ["--native-runtime"]):
            raise ValueError("未知运行环境选项")
        # 私有 stdout 管道只承载结构化结果，导入和解析日志不能混入凭证数据。
        with redirect_stdout(io.StringIO()):
            result = read_settings(sys.argv[1], native_runtime=bool(sys.argv[2:]))
        print(json.dumps(result, ensure_ascii=False))
    except Exception:
        print("无法读取员工创作模型连接。", file=sys.stderr)
        sys.exit(1)

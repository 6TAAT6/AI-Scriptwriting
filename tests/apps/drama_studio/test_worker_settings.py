"""模型代理目录遵循框架协议命名与运营者禁用设置，不访问真实模型。"""

import importlib.util
from pathlib import Path

import pytest


SOURCE = Path(__file__).resolve().parents[3] / "apps/drama-studio/server/worker-settings.py"
SPEC = importlib.util.spec_from_file_location("studio_worker_settings_contract", SOURCE)
SETTINGS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SETTINGS)


@pytest.fixture
def settings_home(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    home = tmp_path / "deployment"
    monkeypatch.setenv("HERMES_HOME", str(home))
    source = home / "profiles" / "jubao-drama"
    source.mkdir(parents=True)
    (source / ".env").write_text("MAIN_KEY=main-fixture-token\nOTHER_KEY=other-fixture-token\n")
    return home, source


def provider(model, transport="chat_completions", **extra):
    return {"base_url": "https://fixture.invalid/v1", "model": model, "models": [model],
            "key_env": "OTHER_KEY", "transport": transport, **extra}


def test_loader_maps_supported_framework_transports_without_guessing_unknown_protocols(settings_home):
    from hermes_cli.config import atomic_config_replace

    home, source = settings_home
    config = {"model": {"provider": "main", "default": "main-model"}, "providers": {
        "main": provider("main-model", "openai_chat", key_env="MAIN_KEY"),
        "private-internal-chat": provider("extra-chat", "openai_chat", name="内部网关名称", models={"extra-chat": {"context_length": 1048576, "supported_efforts": ["low", "high"], "default_reasoning_effort": "high", "private": "禁止进入员工配置"}}),
        "private-internal-responses": provider("extra-responses", "codex_responses"),
        "unsupported": provider("unsupported-model", "unknown_protocol"),
    }}
    atomic_config_replace(source / "config.yaml", config)
    result = SETTINGS.read_settings(home)
    assert result["apiMode"] == "chat_completions"
    assert result["apiKey"] == "main-fixture-token"
    assert {(row["defaultModel"], row["apiMode"]) for row in result["providers"]} == {
        ("extra-chat", "chat_completions"), ("extra-responses", "responses"),
    }
    assert all(row["name"].startswith("创作模型服务 ") for row in result["providers"])
    assert all("private-internal" not in row["id"] for row in result["providers"])
    extra = next(row for row in result['providers'] if row['defaultModel'] == 'extra-chat')
    assert extra['modelMetadata'] == {'extra-chat': {'context_length': 1048576, 'supported_efforts': ['low', 'high'], 'default_reasoning_effort': 'high'}}
    for mode, expected in (("codex_responses", "responses"), ("responses", "responses"),
                           ("chat_completions", "chat_completions")):
        config["providers"]["main"]["transport"] = mode
        atomic_config_replace(source / "config.yaml", config)
        assert SETTINGS.read_settings(home)["apiMode"] == expected
    for mode in ("unknown_protocol", "anthropic_messages"):
        config["providers"]["main"]["transport"] = mode
        atomic_config_replace(source / "config.yaml", config)
        with pytest.raises(ValueError, match="协议"):
            SETTINGS.read_settings(home)


def test_disabled_provider_cannot_be_published_as_default_or_additional_route(settings_home):
    from hermes_cli.config import atomic_config_replace

    home, source = settings_home
    config = {"model": {"provider": "main", "default": "main-model"}, "providers": {
        "main": provider("main-model", key_env="MAIN_KEY"),
        "disabled": provider("disabled-model", enabled=False),
        "enabled": provider("enabled-model", enabled=True),
    }}
    atomic_config_replace(source / "config.yaml", config)
    result = SETTINGS.read_settings(home)
    assert [row["defaultModel"] for row in result["providers"]] == ["enabled-model"]
    config["providers"]["main"]["enabled"] = False
    atomic_config_replace(source / "config.yaml", config)
    with pytest.raises(ValueError, match="停用|禁用"):
        SETTINGS.read_settings(home)
    config["providers"]["main"]["enabled"] = True
    config["providers"]["disabled"]["enabled"] = True
    atomic_config_replace(source / "config.yaml", config)
    assert {row["defaultModel"] for row in SETTINGS.read_settings(home)["providers"]} == {"enabled-model", "disabled-model"}

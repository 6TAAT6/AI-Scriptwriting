"""模型目录使用原生档位并尊重当前配置，不进行模型请求。"""
import importlib.util
from pathlib import Path


def test_reasoning_catalog_keeps_declared_levels_and_native_model_contract(tmp_path):
    from agent.reasoning_effort import codex_supported_efforts

    source = Path(__file__).resolve().parents[3] / "apps/drama-studio/server/reasoning-catalog.py"
    spec = importlib.util.spec_from_file_location("studio_reasoning_catalog", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    (tmp_path / "config.yaml").write_text(
        "providers:\n  studio-test:\n    transport: codex_responses\n", encoding="utf-8"
    )
    model = "gpt-6.1-sol"
    data = {"providers": [{"slug": "studio-test", "models": [model, "writer-custom", "plain-chat"], "capabilities": {
        "writer-custom": {"reasoning": True, "supported_efforts": ["low", "high"]},
        "plain-chat": {"reasoning": False, "supported_efforts": ["high"]},
    }}]}
    caps = module.enrich(data, tmp_path)["providers"][0]["capabilities"]
    assert caps[model]["supported_efforts"] == list(codex_supported_efforts(model))
    assert caps["writer-custom"]["supported_efforts"] == ["low", "high"]
    assert caps["plain-chat"]["supported_efforts"] == []
    assert caps["plain-chat"]["reasoning"] is False


def test_image_catalog_uses_profile_choices_without_exposing_connection_secrets(tmp_path):
    import json
    source = Path(__file__).resolve().parents[3] / "apps/drama-studio/server/reasoning-catalog.py"
    spec = importlib.util.spec_from_file_location("studio_catalog_images", source)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    (tmp_path / "config.yaml").write_text("providers:\n  gemini: {models: [gemini-pro], key_env: PRIVATE_KEY}\nimage_gen:\n  studio_endpoints:\n    gemini: {model: gemini-image, models: [gemini-image]}\n")
    result = module.enrich({"providers": [{"slug": "gemini", "models": ["gemini-pro"]}]}, tmp_path)
    assert result["providers"][0]["image_models"] == ["gemini-image"]
    assert result["providers"][0]["image_model"] == "gemini-image"
    assert "PRIVATE_KEY" not in json.dumps(result)


def test_explicit_reasoning_and_context_metadata_reaches_catalog(tmp_path):
    from hermes_cli.config import atomic_config_replace
    source = Path(__file__).resolve().parents[3] / "apps/drama-studio/server/reasoning-catalog.py"
    spec = importlib.util.spec_from_file_location("studio_catalog_metadata", source)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    atomic_config_replace(tmp_path / 'config.yaml', {'providers': {'fixture': {'models': {'writer-pro': {'context_length': 1048576, 'supported_efforts': ['low', 'high'], 'default_reasoning_effort': 'high'}}}}})
    row = module.enrich({'providers': [{'slug': 'fixture', 'models': ['writer-pro'], 'capabilities': {'writer-pro': {'reasoning': False}}}]}, tmp_path)['providers'][0]
    assert row['capabilities']['writer-pro']['supported_efforts'] == ['low', 'high']
    assert row['capabilities']['writer-pro']['default_reasoning_effort'] == 'high'
    assert row['capabilities']['writer-pro']['context_length'] == 1048576

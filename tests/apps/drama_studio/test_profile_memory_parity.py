"""Employee worker profiles must keep the same Hermes memory surface as the main profile."""

import importlib.util
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[3] / "apps/drama-studio/server/profiles.py"
SPEC = importlib.util.spec_from_file_location("studio_profile_memory_parity", SOURCE)
PROFILES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROFILES)


def _route():
    return {
        "base_url": "http://127.0.0.1:45610/v1",
        "token": "memory-parity-" + "m" * 32,
        "model": "agent-model",
        "models": ["agent-model"],
        "api_mode": "chat_completions",
    }


def test_worker_profile_keeps_builtin_memory_and_session_search_enabled():
    config = PROFILES._config(Path("/tmp/studio-worker"), _route())

    assert config["memory"]["memory_enabled"] is True
    assert config["memory"]["user_profile_enabled"] is True
    assert "memory" not in config["agent"]["disabled_toolsets"]
    assert "session_search" not in config["agent"]["disabled_toolsets"]
    for platform in ("cli", "web", "tui", "desktop"):
        assert "memory" in config["platform_toolsets"][platform]
        assert "session_search" in config["platform_toolsets"][platform]

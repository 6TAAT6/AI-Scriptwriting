"""受限账号恢复历史模型时，模型和接入必须属于同一条已授权路由。"""
from contextlib import contextmanager
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent.secret_scope import (build_profile_secret_scope, is_multiplex_active,
                                reset_secret_scope, set_multiplex_active, set_secret_scope)
from hermes_cli.config import atomic_config_replace
from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from hermes_state import SessionDB
from tui_gateway import server


@pytest.fixture
def studio_homes(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    homes = []
    for label in ("a", "b"):
        home = tmp_path / label
        home.mkdir()
        token = "test-only-" + label * 32
        primary = f"http://127.0.0.1:12345/scope/{label * 32}/v1"
        secondary = f"http://127.0.0.1:12345/scope/{('c' if label == 'a' else 'd') * 32}/v1"
        cfg = {
            "studio_security": {"restricted": True},
            "model": {"provider": "studio-inference", "default": "gpt-6-astra", "base_url": primary},
            "providers": {
                "studio-inference": {"base_url": primary, "models": ["gpt-6-astra"],
                                     "key_env": "STUDIO_INFERENCE_TOKEN", "transport": "chat_completions", "discover_models": False},
                "studio-secondary": {"base_url": secondary, "models": {"gemini-pro-agent": {}},
                                     "key_env": "STUDIO_INFERENCE_TOKEN", "transport": "chat_completions", "discover_models": False},
            },
            "fallback_providers": [],
        }
        atomic_config_replace(home / "config.yaml", cfg)
        (home / ".env").write_text(f"STUDIO_INFERENCE_TOKEN={token}\n")
        homes.append((home, cfg, token))

    @contextmanager
    def scope(home):
        home_token = set_hermes_home_override(home)
        secret_token = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
        try:
            yield
        finally:
            reset_secret_scope(secret_token)
            reset_hermes_home_override(home_token)

    previous = is_multiplex_active()
    set_multiplex_active(True)
    try:
        yield homes, scope
    finally:
        set_multiplex_active(previous)


def restored(row):
    overrides = server._stored_session_runtime_overrides(row)
    return server._resolve_agent_model_runtime(overrides["model_override"], overrides.get("provider_override"))


def test_legacy_conflicting_row_uses_current_owned_route_across_profiles(studio_homes):
    """真实首笔用量能复现旧行矛盾；恢复采用有效计费接入或唯一模型归属。"""
    homes, scope = studio_homes
    for home, cfg, token in (homes[0], homes[1], homes[0]):
        with scope(home), SessionDB(home / "state.db") as database:
            key = "legacy-route"
            database.create_session(key, source="web", model="gpt-6-astra",
                                    model_config={"model": "gpt-6-astra", "provider": "studio-inference"})
            database.update_token_counts(key, model="gemini-pro-agent", input_tokens=1, api_call_count=1,
                                         billing_provider="studio-secondary", billing_base_url="http://127.0.0.1:1/expired/v1")
            database.flush_token_counts()
            row = database.get_session(key)
            assert row["model"] != json.loads(row["model_config"])["model"]
            for billing in ("studio-secondary", "custom:studio-secondary", "custom", None):
                model, runtime = restored({**row, "billing_provider": billing})
                assert model == "gemini-pro-agent"
                assert runtime["base_url"] == cfg["providers"]["studio-secondary"]["base_url"]
                assert runtime["api_key"] == token
                assert runtime["api_mode"] == "chat_completions"


def test_ambiguous_routes_fail_closed_and_valid_or_unrestricted_routes_stay(studio_homes):
    """仅修复受限目录内已证不匹配的路由；多个候选必须有明确历史依据。"""
    homes, scope = studio_homes
    home, cfg, _ = homes[0]
    cfg = copy.deepcopy(cfg)
    cfg["providers"]["studio-alternative"] = {**cfg["providers"]["studio-secondary"], "base_url": "http://127.0.0.1:12345/scope/" + "e" * 32 + "/v1"}
    atomic_config_replace(home / "config.yaml", cfg)
    row = {"model": "gemini-pro-agent", "model_config": {"model": "gpt-6-astra", "provider": "custom:studio-inference",
           "base_url": "http://127.0.0.1:1/old/v1", "api_mode": "old_mode"}}
    with scope(home):
        for billing in (None, "custom", "studio-inference", "removed-provider"):
            with pytest.raises(RuntimeError, match="重新选择"):
                restored({**row, "billing_provider": billing})
        _, runtime = restored({**row, "billing_provider": "studio-alternative"})
        assert runtime["base_url"] == cfg["providers"]["studio-alternative"]["base_url"]
        valid = {**row, "model_config": {"model": "gemini-pro-agent", "provider": "studio-secondary"},
                 "billing_provider": "studio-alternative"}
        _, runtime = restored(valid)
        assert runtime["base_url"] == cfg["providers"]["studio-secondary"]["base_url"]
        with pytest.raises(RuntimeError, match="重新选择"):
            restored({**row, "model": "removed-model"})
        cfg["studio_security"]["restricted"] = False
        atomic_config_replace(home / "config.yaml", cfg)
        overrides = server._stored_session_runtime_overrides(row)
        assert overrides["model_override"]["provider"] == "custom:studio-inference"
        assert overrides["model_override"]["base_url"] == row["model_config"]["base_url"]


def test_attaching_deferred_agent_persists_actual_runtime_to_own_existing_row(studio_homes, monkeypatch):
    """预建行不能保留首次选择；真实 Agent 挂接后完整运行路由应写回所属数据库。"""
    homes, scope = studio_homes
    for index, (home, cfg, token) in enumerate((homes[0], homes[1], homes[0])):
        with scope(home), SessionDB(home / "state.db") as database:
            key = f"deferred-{index}"
            database.create_session(key, source="web", model="gpt-6-astra",
                                    model_config={"model": "gpt-6-astra", "provider": "studio-inference", "_branched_from": "original"})
            route = cfg["providers"]["studio-secondary"]
            agent = SimpleNamespace(model="gemini-pro-agent", provider="custom", base_url=route["base_url"],
                                    api_mode="chat_completions", reasoning_config=None, service_tier=None,
                                    _session_db=database, session_id=key, _cached_system_prompt="固定提示")
            session = {"session_key": key, "profile_home": str(home), "cwd": str(home), "source": "web"}
            monkeypatch.setitem(server._sessions, key, session)
            assert server._attach_built_agent(key, session, agent) is True
            row = database.get_session(key)
            model_config = json.loads(row["model_config"])
            assert row["model"] == model_config["model"] == "gemini-pro-agent"
            assert model_config["provider"] == "custom:studio-secondary"
            assert model_config["_branched_from"] == "original"
            assert "api_key" not in model_config and token not in row["model_config"]
            assert agent._cached_system_prompt == "固定提示"
            _, runtime = restored(row)
            assert runtime["base_url"] == route["base_url"]
            other = homes[1][0] if home == homes[0][0] else homes[0][0]
            with SessionDB(other / "state.db") as other_database:
                assert other_database.get_session(key) is None
            cancelled_key = key + "-cancelled"
            database.create_session(cancelled_key, source="web", model="gpt-6-astra",
                                    model_config={"model": "gpt-6-astra", "provider": "studio-inference"})
            cancelled = {**session, "session_key": cancelled_key, "agent": None}
            assert server._attach_built_agent(cancelled_key, cancelled, agent) is False
            cancelled_row = database.get_session(cancelled_key)
            assert cancelled_row["model"] == json.loads(cancelled_row["model_config"])["model"] == "gpt-6-astra"

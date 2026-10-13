"""人工确认必须对应本 profile、本次调用和当前产物，自动放行不能替代人的决定。"""

from __future__ import annotations

import importlib
import json
import sys
import types
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest


SOURCE = Path(__file__).resolve().parents[2] / "extensions" / "jubao-drama"
PACKAGE = "_jubao_drama_approval_test_source"


def _source_module(name):
    if PACKAGE not in sys.modules:
        package = types.ModuleType(PACKAGE)
        package.__path__ = [str(SOURCE)]
        sys.modules[PACKAGE] = package
    return importlib.import_module(f"{PACKAGE}.{name}")


@contextmanager
def _scope(home):
    from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from tools.terminal_scope import reset_terminal_scope, set_terminal_scope

    home_token = set_hermes_home_override(str(home))
    secret_token = set_secret_scope(build_profile_secret_scope(home))
    terminal_token = set_terminal_scope({})
    try:
        yield
    finally:
        reset_terminal_scope(terminal_token)
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    """真实加载插件与 SQLite；只有人的点击以本地 callback 代替。"""
    from agent.secret_scope import set_multiplex_active
    from hermes_cli.plugins import _reset_plugin_managers_for_tests, get_plugin_manager
    from tools.terminal_tool import set_approval_callback

    _source_module("approvals")
    _source_module("workflow")
    homes = [tmp_path / "a", tmp_path / "b"]
    empty_bundled = tmp_path / "bundled"
    empty_bundled.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(empty_bundled))
    monkeypatch.setenv("HERMES_INTERACTIVE", "1")
    for name in ("HERMES_GATEWAY_SESSION", "HERMES_EXEC_ASK", "HERMES_YOLO_MODE",
                 "HERMES_CRON_SESSION", "HERMES_SESSION_PLATFORM"):
        monkeypatch.delenv(name, raising=False)
    _reset_plugin_managers_for_tests()
    set_multiplex_active(True)
    modules = {}
    for home in homes:
        plugin = home / "plugins" / "approval-fixture"
        plugin.mkdir(parents=True)
        (home / "config.yaml").write_text(
            "plugins:\n  enabled: [approval-fixture]\napprovals:\n  mode: manual\n",
            encoding="utf-8",
        )
        (plugin / "plugin.yaml").write_text(
            "name: approval-fixture\nversion: 1.0.0\ndescription: 人工确认行为测试\n",
            encoding="utf-8",
        )
        (plugin / "__init__.py").write_text(
            "import json\n"
            f"from {PACKAGE}.approvals import ApprovalBridge\n"
            f"from {PACKAGE}.workflow import ProjectStore\n"
            "store = ProjectStore()\n"
            "bridge = ApprovalBridge(store)\n"
            "receipts = []\n"
            "def register(ctx):\n"
            "    ctx.register_hook('pre_tool_call', bridge.pre_tool_call)\n"
            "    ctx.register_hook('post_approval_response', bridge.post_approval_response)\n"
            "    ctx.register_hook('post_approval_response', lambda **kw: receipts.append(kw))\n"
            "    ctx.register_middleware('tool_execution', bridge.tool_execution)\n"
            "    ctx.register_tool('drama_confirm', 'drama_workflow',\n"
            "        {'name': 'drama_confirm', 'description': '确认当前阶段',\n"
            "         'parameters': {'type': 'object', 'additionalProperties': False,\n"
            "           'properties': {'project_id': {'type': 'string'},\n"
            "                          'gate': {'type': 'string', 'enum': ['core', 'plan']},\n"
            "                          'plan_id': {'type': 'string'}},\n"
            "           'required': ['project_id', 'gate']}},\n"
            "        lambda args, **kw: json.dumps(bridge.confirm(**args), ensure_ascii=False))\n",
            encoding="utf-8",
        )
        with _scope(home):
            manager = get_plugin_manager()
            manager.discover_and_load()
            loaded = manager._plugins["approval-fixture"]
            assert loaded.error is None
            modules[home] = loaded.module
    try:
        yield homes, modules
    finally:
        set_approval_callback(None)
        _reset_plugin_managers_for_tests()
        set_multiplex_active(False)


def _ids():
    return {"session_id": "session-" + uuid.uuid4().hex,
            "turn_id": "turn-" + uuid.uuid4().hex,
            "tool_call_id": "call-" + uuid.uuid4().hex}


def _call(args, ids, **kwargs):
    from model_tools import handle_function_call
    from tools.approval_context import reset_current_session_key, set_current_session_key

    token = set_current_session_key(ids["session_id"])
    try:
        return json.loads(handle_function_call("drama_confirm", args, **ids, **kwargs))
    finally:
        reset_current_session_key(token)


def _draft(module, gate):
    from tools.terminal_tool import set_approval_callback

    project = module.store.create("人类审批测试", source={"content": "原剧情节：主角发现家族秘密。"})
    project_id = project["id"]
    module.store.submit(project_id, "core", {"content": "保留主角逐步揭开家族秘密的期待感。"}, "writer")
    args = {"project_id": project_id, "gate": gate}
    if gate == "plan":
        set_approval_callback(lambda *_args, **_kw: "once")
        result = _call({"project_id": project_id, "gate": "core"}, _ids())
        assert "error" not in result, result
        module.store.submit(project_id, "candidates", {"items": [
            {"id": "plan-a", "title": "古风家族", "content": "以古风商贾家族替代现代公司。"}
        ]}, "writer")
        args["plan_id"] = "plan-a"
    return args


def _approved(project, gate):
    return project["core"].get("approval") if gate == "core" else project["plan"].get("selection")


@pytest.mark.parametrize("gate", ["core", "plan"])
def test_human_receipt_is_bound_to_one_call_and_profile(runtime, gate):
    """缺少调用绑定、重复消费或把 A 的真人回执交给 B，都不能批准。"""
    from hermes_cli.middleware import run_tool_execution_middleware
    from tools.registry import registry
    from tools.terminal_tool import set_approval_callback

    (a, b), modules = runtime
    with _scope(a):
        args_a = _draft(modules[a], gate)
        ids = _ids()
        with pytest.raises(PermissionError):
            modules[a].bridge.confirm(**args_a)
        set_approval_callback(lambda *_args, **_kw: "once")
        result = _call(args_a, ids)
        assert "error" not in result, result
        receipt = _approved(modules[a].store.get(args_a["project_id"]), gate)
        assert receipt and receipt["evidence"]
        target = modules[a].store.gate_target(**args_a)
        assert receipt["content_hash"] == target["content_hash"]
        assert receipt["receipt"]["session_id"] == ids["session_id"]
        event = dict(modules[a].receipts[-1])
        replay = run_tool_execution_middleware(
            "drama_confirm", args_a, lambda payload: registry.dispatch("drama_confirm", payload), **ids
        )
        assert "error" in json.loads(replay)
        modules[a].bridge.post_approval_response(**event)
        assert _approved(modules[a].store.get(args_a["project_id"]), gate) == receipt
    with _scope(b):
        args_b = _draft(modules[b], gate)
        pending = modules[b].bridge.pre_tool_call("drama_confirm", args_b, **ids)
        assert pending["action"] == "approve"
        modules[b].bridge.post_approval_response(**event)
        result = run_tool_execution_middleware(
            "drama_confirm", args_b, lambda payload: registry.dispatch("drama_confirm", payload), **ids
        )
        assert "error" in json.loads(result)
        assert not _approved(modules[b].store.get(args_b["project_id"]), gate)
    with _scope(a):
        assert _approved(modules[a].store.get(args_a["project_id"]), gate) == receipt


@pytest.mark.parametrize("gate", ["core", "plan"])
@pytest.mark.parametrize("failure", [
    "forged_parameter", "off", "allowlist", "smart", "deny", "timeout", "coalesced",
    "missing_id", "edited_draft", "missing_middleware",
])
def test_nonhuman_stale_or_unbound_confirmation_cannot_advance(runtime, gate, failure):
    """只有当前产物的真实人工回执能推进阶段，关闭审批和模型自批均不能替代。"""
    from hermes_cli.config import set_config_value
    from hermes_cli.middleware import run_tool_execution_middleware
    from tools.approval import approve_session
    from tools.registry import registry
    from tools.terminal_tool import set_approval_callback

    (home, _), modules = runtime
    with _scope(home):
        module = modules[home]
        args = _draft(module, gate)
        ids = _ids()
        set_approval_callback(lambda *_args, **_kw: "once")
        if failure == "forged_parameter":
            args["approved"] = True
            result = _call(args, ids)
        elif failure == "off":
            set_config_value("approvals.mode", "off")
            result = _call(args, ids)
        elif failure == "allowlist":
            pending = module.bridge.pre_tool_call("drama_confirm", args, **ids)
            approve_session(ids["session_id"], "plugin_rule:" + pending["rule_key"])
            result = _call(args, ids)
        elif failure == "edited_draft":
            def edit_before_click(*_args, **_kw):
                module.store.submit(args["project_id"], "core", {"content": "改为主角主动放弃秘密的新期待。"}, "writer")
                return "once"
            set_approval_callback(edit_before_click)
            result = _call(args, ids)
        elif failure == "missing_middleware":
            result = _call(args, ids, skip_tool_execution_middleware=True)
        else:
            pending = module.bridge.pre_tool_call("drama_confirm", args, **ids)
            event = dict(ids, pattern_key="plugin_rule:" + pending["rule_key"], surface="gateway", choice="once")
            changes = {
                "smart": {"surface": "smart", "choice": "smart_approve", "decided_by": "aux_llm"},
                "deny": {"choice": "deny"}, "timeout": {"choice": "timeout"},
                "coalesced": {"coalesced": True}, "missing_id": {"tool_call_id": ""},
            }
            event.update(changes[failure])
            module.bridge.post_approval_response(**event)
            result = json.loads(run_tool_execution_middleware(
                "drama_confirm", args, lambda payload: registry.dispatch("drama_confirm", payload), **ids
            ))
        assert "error" in result, result
        assert not _approved(module.store.get(args["project_id"]), gate)

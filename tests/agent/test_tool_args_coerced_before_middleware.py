"""Agent tool loop hands plugins schema-typed arguments, matching ``model_tools.handle_function_call``.

Regression (2026-11-23 test deployment): a model sent ``"from_reply": "true"`` for a boolean
parameter. The direct dispatch path coerces before tool middleware, but the agent tool loop
passed the raw string to middleware, so a plugin's ``is True`` check rejected the save and the
model rewrote the whole manuscript in the same reply.
"""

import json
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from run_agent import AIAgent

SCHEMA = {"name": "probe_tool", "description": "probe",
          "parameters": {"type": "object", "properties": {"flag": {"type": "boolean"}, "count": {"type": "integer"}}}}


def _make_agent() -> AIAgent:
    tool_defs = [{"type": "function", "function": SCHEMA}]
    with (
        patch("model_tools.get_tool_definitions", return_value=tool_defs),
        patch("model_tools.check_toolset_requirements", return_value={}),
        patch("hermes_cli.config.load_config", return_value={}),
        patch("hermes_cli.config.load_config_readonly", return_value={}),
        patch("agent.process_bootstrap.OpenAI"),
    ):
        agent = AIAgent(api_key="test-key-1234567890", base_url="https://openrouter.ai/api/v1", quiet_mode=True,
                        skip_context_files=True, skip_memory=True, platform="cli")
    agent.client = MagicMock()
    agent._cached_system_prompt = "You are helpful."
    agent.compression_enabled = False
    agent.save_trajectories = False
    return agent


def test_agent_loop_middleware_sees_the_same_typed_args_as_direct_dispatch():
    import hermes_cli.middleware as middleware
    from tools.arg_coercion import coerce_tool_args

    agent = _make_agent()
    raw = {"flag": "true", "count": "3"}
    seen = []
    original = middleware.apply_tool_request_middleware

    def recording(tool_name, args, **context):
        seen.append(dict(args))
        return original(tool_name, args, **context)

    call = SimpleNamespace(id=f"call_{uuid.uuid4().hex[:8]}", type="function",
                           function=SimpleNamespace(name="probe_tool", arguments=json.dumps(raw)))
    with (
        patch("tools.arg_coercion.registry.get_schema", side_effect=lambda name: SCHEMA if name == "probe_tool" else None),
        patch.object(middleware, "apply_tool_request_middleware", recording),
        patch("model_tools.handle_function_call", return_value=json.dumps({"ok": True})),
    ):
        direct = coerce_tool_args("probe_tool", dict(raw))
        agent._execute_tool_calls_sequential(SimpleNamespace(content="", tool_calls=[call]), [], "task-1")

    assert seen == [direct], seen
    assert seen[0]["flag"] is True

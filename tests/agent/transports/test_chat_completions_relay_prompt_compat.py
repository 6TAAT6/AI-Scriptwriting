"""Gemini relays (codex2api, 2026-11-17) answer HTTP 429 to stock Hermes English in the system message;
every outgoing Gemini request -- main agent, subagent and auxiliary -- carries it in Chinese instead."""

import copy

import pytest

from agent import prompt_builder as pb
from agent.auxiliary_client import _build_call_kwargs
from agent.transports import get_transport
from providers import get_provider_profile
from tools.delegate_tool_progress import _build_child_system_prompt

_STOCK_ENGLISH = (
    pb.DEFAULT_AGENT_IDENTITY, pb.MEMORY_GUIDANCE, pb.SESSION_SEARCH_GUIDANCE, pb.SKILLS_GUIDANCE,
    pb.TOOL_USE_ENFORCEMENT_GUIDANCE, pb.ASYNC_HANDOFF_GUIDANCE, pb.PARALLEL_TOOL_CALL_GUIDANCE,
    pb.TASK_COMPLETION_GUIDANCE, pb.STEER_CHANNEL_NOTE, pb.GOOGLE_MODEL_OPERATIONAL_GUIDANCE,
)
_VERBATIM = (pb.STEER_MARKER_OPEN, pb.STEER_MARKER_CLOSE, "[SKILL_PRUNED]", "skill_view", "session_search",
             "delegate_task", "/srv/studio/workspace")


def _system_prompt(tmp_path):
    child = _build_child_system_prompt(
        "写一场戏", "保持人物口吻一致", workspace_path=str(tmp_path), role="orchestrator", max_spawn_depth=3,
    )
    runtime = (f"{pb.RUNTIME_ENVIRONMENT_HEADING}\n\nHost: Linux\nCurrent working directory: /srv/studio/workspace"
               f"\n\n{pb.RUNTIME_ENVIRONMENT_END}")
    return "\n\n".join([*_STOCK_ENGLISH, runtime, child])


def _sent_system(path, model, messages):
    if path == "auxiliary":
        return _build_call_kwargs("custom", model, messages)["messages"]
    import agent.transports.chat_completions  # noqa: F401
    params = {"provider_profile": get_provider_profile("custom")} if path == "custom-profile" else {}
    return get_transport("chat_completions").build_kwargs(model, messages, None, **params)["messages"]


@pytest.mark.parametrize("path", ["legacy", "custom-profile", "auxiliary"])
def test_gemini_requests_carry_no_stock_hermes_english_and_keep_transcript(tmp_path, path):
    messages = [{"role": "system", "content": _system_prompt(tmp_path)}, {"role": "user", "content": "你好"}]
    original = copy.deepcopy(messages)

    first = _sent_system(path, "gemini-4-hydrogen-xhigh", messages)
    second = _sent_system(path, "gemini-4-hydrogen-xhigh", messages)

    sent = first[0]["content"]
    assert messages == original, "the stored transcript must never be rewritten"
    leaked = [text for text in (*_STOCK_ENGLISH, pb.RUNTIME_ENVIRONMENT_HEADING, pb.RUNTIME_ENVIRONMENT_END,
                                "You are a focused subagent", "Complete this task using the tools",
                                "Subagent Spawning", "NOTE: You are at depth") if text.strip() in sent]
    assert not leaked
    assert all(token in sent for token in (*_VERBATIM, str(tmp_path))), "markers, tool names and paths stay verbatim"
    assert first[1:] == original[1:] and second == first, "deterministic, so the provider prefix cache stays warm"


@pytest.mark.parametrize("path", ["legacy", "auxiliary"])
@pytest.mark.parametrize("model", ["gpt-6-astra", "claude-sonnet-4-6", "doubao-seed-2-1-pro-260915"])
def test_non_gemini_models_receive_the_system_prompt_unchanged(tmp_path, path, model):
    messages = [{"role": "system", "content": _system_prompt(tmp_path)}, {"role": "user", "content": "你好"}]

    assert _sent_system(path, model, messages)[0]["content"] == messages[0]["content"]

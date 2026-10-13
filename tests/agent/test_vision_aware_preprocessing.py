"""Tests for the vision-aware image preprocessing in run_agent.py.

Covers:

* ``_prepare_anthropic_messages_for_api`` — passes image parts through
  unchanged when the active model reports ``supports_vision=True`` (the
  adapter handles them natively), and falls back to text-description
  replacement when the model lacks vision.

* ``_prepare_messages_for_non_vision_model`` — the mirror method for the
  chat.completions / codex_responses paths. Same contract.
"""

from __future__ import annotations

from unittest.mock import patch


from run_agent import AIAgent


def _make_agent() -> AIAgent:
    """Build a bare-bones AIAgent instance without running __init__.

    Avoids the heavy provider/credential setup for these pure-method tests.
    """
    agent = object.__new__(AIAgent)
    agent.provider = "anthropic"
    agent.model = "claude-sonnet-4"
    agent._anthropic_image_fallback_cache = {}
    return agent


IMG_PARTS_USER_MSG = {
    "role": "user",
    "content": [
        {"type": "text", "text": "What's in this image?"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
    ],
}

PLAIN_USER_MSG = {"role": "user", "content": "hello, no images here"}


# ─── _prepare_anthropic_messages_for_api ─────────────────────────────────────


class TestPrepareAnthropicMessages:
    def test_no_images_passes_through(self):
        agent = _make_agent()
        msgs = [PLAIN_USER_MSG]
        out = agent._prepare_anthropic_messages_for_api(msgs)
        assert out is msgs  # unchanged reference

    def test_vision_capable_passes_images_through(self):
        """The Anthropic adapter handles image_url/input_image natively."""
        agent = _make_agent()
        with patch.object(agent, "_model_supports_vision", return_value=True):
            out = agent._prepare_anthropic_messages_for_api([IMG_PARTS_USER_MSG])
        # Passes through unchanged — image_url parts still present.
        assert out[0]["content"][1]["type"] == "image_url"

    def test_non_vision_replaces_images_with_text(self):
        agent = _make_agent()
        with patch.object(agent, "_model_supports_vision", return_value=False), \
             patch.object(
                 agent,
                 "_describe_image_for_anthropic_fallback",
                 return_value="[Image description: a cat]",
             ):
            out = agent._prepare_anthropic_messages_for_api([IMG_PARTS_USER_MSG])
        # Content collapsed to a string containing the description + user text.
        content = out[0]["content"]
        assert isinstance(content, str)
        assert "[Image description: a cat]" in content
        assert "What's in this image?" in content
        # No more image parts.
        assert "image_url" not in content


# ─── _prepare_messages_for_non_vision_model ──────────────────────────────────


class TestPrepareMessagesForNonVision:
    def test_no_images_passes_through(self):
        agent = _make_agent()
        msgs = [PLAIN_USER_MSG]
        out = agent._prepare_messages_for_non_vision_model(msgs)
        assert out is msgs

    def test_vision_capable_passes_through(self):
        """For vision-capable models on chat.completions path, provider handles pixels."""
        agent = _make_agent()
        agent.provider = "openrouter"
        agent.model = "anthropic/claude-sonnet-4"
        with patch.object(agent, "_model_supports_vision", return_value=True):
            out = agent._prepare_messages_for_non_vision_model([IMG_PARTS_USER_MSG])
        assert out[0]["content"][1]["type"] == "image_url"

    def test_non_vision_strips_images(self):
        agent = _make_agent()
        agent.provider = "openrouter"
        agent.model = "qwen/qwen3-235b-a22b"
        with patch.object(agent, "_model_supports_vision", return_value=False), \
             patch.object(
                 agent,
                 "_describe_image_for_anthropic_fallback",
                 return_value="[Image description: a dog]",
             ):
            out = agent._prepare_messages_for_non_vision_model([IMG_PARTS_USER_MSG])
        content = out[0]["content"]
        assert isinstance(content, str)
        assert "[Image description: a dog]" in content
        assert "image_url" not in content

    def test_multiple_messages_with_mixed_content(self):
        agent = _make_agent()
        agent.model = "qwen/qwen3-235b"
        msgs = [
            {"role": "user", "content": "first turn"},
            {"role": "assistant", "content": "ack"},
            IMG_PARTS_USER_MSG,
        ]
        with patch.object(agent, "_model_supports_vision", return_value=False), \
             patch.object(
                 agent,
                 "_describe_image_for_anthropic_fallback",
                 return_value="[Image: thing]",
             ):
            out = agent._prepare_messages_for_non_vision_model(msgs)
        # First two messages unchanged (no images), third stripped.
        assert out[0]["content"] == "first turn"
        assert out[1]["content"] == "ack"
        assert isinstance(out[2]["content"], str)
        assert "[Image: thing]" in out[2]["content"]


# ─── _model_supports_vision ──────────────────────────────────────────────────


class TestModelSupportsVision:
    def test_missing_provider_or_model_returns_false(self):
        agent = _make_agent()
        agent.provider = ""
        agent.model = "claude-sonnet-4"
        assert agent._model_supports_vision() is False
        agent.provider = "anthropic"
        agent.model = ""
        assert agent._model_supports_vision() is False


    def test_none_caps_returns_false(self):
        agent = _make_agent()
        with patch("agent.models_dev.get_model_capabilities", return_value=None):
            assert agent._model_supports_vision() is False


    def test_top_level_model_override_wins(self):
        agent = _make_agent()
        agent.provider = "custom"
        agent.model = "my-llava"
        with patch("hermes_cli.config.load_config", return_value={"model": {"supports_vision": True}}), \
             patch("agent.models_dev.get_model_capabilities", return_value=None):
            assert agent._model_supports_vision() is True


    def test_named_custom_provider_resolved_via_config_provider(self):
        # Named custom providers get runtime self.provider rewritten to
        # "custom" while the config keeps the original name under
        # model.provider. The override must still resolve.
        agent = _make_agent()
        agent.provider = "custom"
        agent.model = "my-llava"
        cfg = {
            "model": {"provider": "my-vllm", "default": "my-llava"},
            "providers": {"my-vllm": {"models": {"my-llava": {"supports_vision": True}}}},
        }
        with patch("hermes_cli.config.load_config", return_value=cfg), \
             patch("agent.models_dev.get_model_capabilities", return_value=None):
            assert agent._model_supports_vision() is True



def test_image_fallback_uses_bounded_same_message_context_without_rewriting_history(tmp_path, monkeypatch):
    """同图同题只识别一次；新题重附同图单独识别，历史前缀仍稳定。"""
    import copy
    import json
    import tools.vision_tools as vision

    agent = _make_agent()
    monkeypatch.setattr(agent, '_model_supports_vision', lambda: False)
    image = tmp_path / 'screen.png'
    image.write_bytes(b'synthetic-image-fixture')
    calls = []

    async def analyze(image_url, user_prompt):
        assert image_url == str(image)
        calls.append(user_prompt)
        return json.dumps({'analysis': f'合成观察结果{len(calls)}'}, ensure_ascii=False)

    monkeypatch.setattr(vision, 'vision_analyze_tool', analyze)
    first_question = '请读取截图右下角红框中的编号。'
    second_question = '请核对截图左上角余额的小数位。'
    first = {'role': 'user', 'content': [
        {'type': 'text', 'text': '界面核查背景。' + '重复格式约束。' * 4000 + first_question},
        {'type': 'image_url', 'image_url': {'url': str(image)}},
    ]}
    original = copy.deepcopy(first)
    initial = agent._prepare_messages_for_non_vision_model([first])
    assert first_question in calls[0]
    assert len(calls[0]) < 9000
    assert agent._prepare_messages_for_non_vision_model([first]) == initial
    second = {'role': 'user', 'content': [
        {'type': 'text', 'text': second_question},
        {'type': 'image_url', 'image_url': {'url': str(image)}},
    ]}
    history = [first, {'role': 'assistant', 'content': '已经读取第一处。'}, second]
    followup = agent._prepare_messages_for_non_vision_model(history)
    assert len(calls) == 2
    assert second_question in calls[1]
    assert first_question not in calls[1]
    assert followup[0] == initial[0]
    assert agent._prepare_messages_for_non_vision_model(history) == followup
    assert len(calls) == 2
    assert first == original


def test_failed_image_fallback_stays_stable_for_same_question_but_not_new_question(tmp_path, monkeypatch):
    """同题失败不在工具循环反复计费；新问题不会继承旧失败。"""
    import json
    import tools.vision_tools as vision

    agent = _make_agent()
    monkeypatch.setattr(agent, '_model_supports_vision', lambda: False)
    image = tmp_path / 'screen.png'
    image.write_bytes(b'synthetic-image-fixture')
    calls = []

    async def analyze(image_url, user_prompt):
        calls.append(user_prompt)
        return json.dumps({'error': '合成视觉服务故障'} if len(calls) == 1 else {'analysis': '新问题所问数字为1234'}, ensure_ascii=False)

    monkeypatch.setattr(vision, 'vision_analyze_tool', analyze)
    def message(question):
        return {'role': 'user', 'content': [{'type': 'text', 'text': question}, {'type': 'image_url', 'image_url': {'url': str(image)}}]}

    first = message('请描述整张截图。')
    failed = agent._prepare_messages_for_non_vision_model([first])
    assert '未成功读取' in failed[0]['content']
    assert "Here's what it contains" not in failed[0]['content']
    assert agent._prepare_messages_for_non_vision_model([first]) == failed
    assert len(calls) == 1
    recovered = agent._prepare_messages_for_non_vision_model([first, {'role': 'assistant', 'content': '图片未读成功。'}, message('重新附图，请读取红框内数字。')])
    assert len(calls) == 2
    assert recovered[0] == failed[0]
    assert '1234' in recovered[-1]['content']

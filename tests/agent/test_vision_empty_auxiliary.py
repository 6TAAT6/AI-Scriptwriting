"""真实辅助识图返回空内容时，工具与主模型预处理都不能声称已读图。"""

import asyncio
import copy
import json
from types import SimpleNamespace

from PIL import Image

from agent.auxiliary_client import extract_content_or_reasoning
from agent.vision_message_prep import VisionMessagePrepMixin
import tools.vision_tools as vision


def test_real_empty_vision_result_is_failure_with_existing_single_retry(tmp_path, monkeypatch):
    image = tmp_path / "empty.png"
    Image.new("RGB", (8, 8), "white").save(image)
    calls = []

    async def empty_response(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="", reasoning_content=None))])

    monkeypatch.setattr(vision, "async_call_llm", empty_response)
    monkeypatch.setattr(vision, "extract_content_or_reasoning", extract_content_or_reasoning)
    result = json.loads(asyncio.run(vision.vision_analyze_tool(str(image), "读取错误码")))
    assert len(calls) == 2
    assert result["success"] is False and result["error"]

    instance = VisionMessagePrepMixin()
    instance._anthropic_image_fallback_cache = {}
    monkeypatch.setattr(instance, "_model_supports_vision", lambda: False)
    messages = [{"role": "user", "content": [
        {"type": "text", "text": "请检查错误码。"},
        {"type": "image_url", "image_url": {"url": str(image)}},
    ]}]
    original = copy.deepcopy(messages)
    failed = instance._prepare_messages_for_non_vision_model(messages)
    assert len(calls) == 4 and messages == original
    assert "未成功读取" in failed[0]["content"] and "Here's what it contains" not in failed[0]["content"]
    assert instance._prepare_messages_for_non_vision_model(messages) == failed and len(calls) == 4


def test_explicit_auxiliary_failure_is_not_relabelled_as_success(tmp_path, monkeypatch):
    instance = VisionMessagePrepMixin()
    instance._anthropic_image_fallback_cache = {}

    async def failed_response(**_kwargs):
        return json.dumps({"success": False, "analysis": "服务当前不可用，未读取图像。"}, ensure_ascii=False)

    monkeypatch.setattr(vision, "vision_analyze_tool", failed_response)
    text = instance._describe_image_for_anthropic_fallback(str(tmp_path / "screen.png"), "user", "检查号码")
    assert "未成功读取" in text and "Here's what it contains" not in text

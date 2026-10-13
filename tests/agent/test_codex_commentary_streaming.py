"""公开进度必须在消息完成前到达，同时不成为最终回答或泄露分析文本。"""

from types import SimpleNamespace

from agent.agent_runtime_helpers import strip_think_blocks
from agent.codex_runtime import run_codex_stream
from agent.stream_delivery import StreamDeliveryMixin


class _Agent(StreamDeliveryMixin):
    def __init__(self, delivered, *, stream=True, commentary=True):
        self._interrupt_requested = False
        self.show_commentary = commentary
        self.stream_delta_callback = None
        self._stream_callback = (lambda text: delivered.append(("delta", text))) if stream else None
        self.interim_assistant_callback = lambda text, **kw: delivered.append(("interim", text, kw["already_streamed"]))
        self.reasoning_callback = lambda text: None
        self.session_id, self.model, self.provider, self.platform = "commentary-test", "test-model", "custom", "tui"

    def _strip_think_blocks(self, text):
        return strip_think_blocks(self, text)

    def _touch_activity(self, _message):
        pass

    def _client_log_context(self):
        return "测试流"


def _message(kind, item_id, phase, text=""):
    return SimpleNamespace(type=f"response.output_item.{kind}", item=SimpleNamespace(
        type="message", role="assistant", id=item_id, phase=phase, status="completed",
        content=[SimpleNamespace(type="output_text", text=text)]))


def _delta(text, item_id):
    return SimpleNamespace(type="response.output_text.delta", delta=text, item_id=item_id)


def _complete():
    return SimpleNamespace(type="response.completed", response=SimpleNamespace(status="completed"))


def _run(agent, events, on_first_delta=None):
    client = SimpleNamespace(responses=SimpleNamespace(create=lambda **_: iter(events)))
    return run_codex_stream(agent, {"model": "test-model"}, client=client, on_first_delta=on_first_delta)


def test_commentary_arrives_before_done_and_stays_separate_from_final_and_analysis():
    delivered = []
    first_deltas = []
    agent = _Agent(delivered)

    def events():
        yield _message("added", "analysis", "analysis")
        yield _delta("私密分析不能进入正文", "analysis")
        yield _message("done", "analysis", "analysis", "私密分析不能进入正文")
        for item_id, first, second in (
            ("c1", "**正在起草第9—12集**，", "继续核对第13集。"),
            ("c2", "已修补 structured-tool-results，", "继续核对人物关系。"),
        ):
            before = len(delivered)
            yield _message("added", item_id, "commentary")
            yield _delta(first, item_id)
            assert delivered[before:] == [("delta", first)]
            assert first_deltas == ["started"], "公开说明已输出时应停止旧等待动画，且整次请求只触发一次"
            yield _delta(second, item_id)
            assert delivered[before:] == [("delta", first), ("delta", second)]
            yield _message("done", item_id, "commentary", first + second)
            assert delivered[-1] == ("interim", first + second, True)
            assert agent._current_streamed_assistant_text == ""
        tool = SimpleNamespace(type="function_call", id="tool", call_id="call", name="read_file", arguments="{}")
        yield SimpleNamespace(type="response.output_item.added", item=tool)
        yield SimpleNamespace(type="response.output_item.done", item=tool)
        yield _complete()

    response = _run(agent, events(), lambda: first_deltas.append("started"))
    assert response.output_text == ""
    assert agent._codex_streamed_text_parts == []
    final = _run(agent, [
        _message("added", "final", "final_answer"), _delta("最终", "final"), _delta("正文。", "final"),
        _message("done", "final", "final_answer", "最终正文。"), _complete(),
    ])
    assert final.output_text == agent._current_streamed_assistant_text == "最终正文。"
    assert "私密" not in str(delivered)
    before = list(delivered)
    _run(agent, [
        _message("added", "duplicate", "commentary"), _delta("**正在起草第9—12集**，", "duplicate"),
        _delta("继续核对第13集。", "duplicate"),
        _message("done", "duplicate", "commentary", "**正在起草第9—12集**，继续核对第13集。"), _complete(),
    ])
    assert delivered == before


def test_commentary_stream_preserves_redaction_scrubbers_and_legacy_consumers(monkeypatch):
    monkeypatch.setattr("agent.redact._REDACT_ENABLED", True)
    secret = "sk-" + "A" * 32
    delivered = []
    agent = _Agent(delivered)
    chunks = ["开始检查。<thi", "nk>隐藏分析", "</think>\n<memory-con", "text>\n隐藏记忆\n</memory-context>\n", "使用凭证 sk-", "A" * 16, "A" * 16, "，继续检查。"]

    def events():
        yield _message("added", "c1", "commentary")
        for text in chunks:
            yield _delta(text, "c1")
            assert secret not in str(delivered)
            assert "隐藏分析" not in str(delivered)
            assert "隐藏记忆" not in str(delivered)
        yield _message("done", "c1", "commentary", "".join(chunks))
        yield _complete()

    _run(agent, events())
    assert delivered[0] == ("delta", "开始检查。")
    assert secret not in str(delivered)
    assert delivered[-1][0] == "interim"
    assert agent._current_streamed_assistant_text == ""
    for stream, commentary in ((False, True), (True, False)):
        legacy = []
        _run(_Agent(legacy, stream=stream, commentary=commentary), [
            _message("added", "c", "commentary"), _delta("公开进度。", "c"),
            _message("done", "c", "commentary", "公开进度。"), _complete(),
        ])
        assert legacy == ([("interim", "公开进度。", False)] if commentary else [])

    from agent.redact import clear_vault_redaction_values, register_vault_redaction_value

    vault = []
    register_vault_redaction_value("中文口令")
    try:
        benign = []
        _run(_Agent(benign), [
            _message("added", "benign", "commentary"),
            _delta("正在检查工具状态。", "benign"),
            _message("done", "benign", "commentary", "正在检查工具状态。"),
            _complete(),
        ])
        assert ("delta", "正在检查工具状态。") in benign

        def vault_events():
            yield _message("added", "vault", "commentary")
            yield _delta("中文", "vault")
            assert vault == []
            yield _delta("口令", "vault")
            yield _message("done", "vault", "commentary", "中文口令")
            yield _complete()
        _run(_Agent(vault), vault_events())
        assert "中文口令" not in str(vault)
    finally:
        clear_vault_redaction_values()

    fenced = []
    fenced_agent = _Agent(fenced)
    def superseded_events():
        yield _message("added", "old", "commentary")
        yield _delta("已发送进度。", "old")
        fenced_agent._claim_stream_writer()
        yield _delta("迟到进度。", "old")
        yield _message("done", "old", "commentary", "已发送进度。迟到进度。")
        yield _complete()
    _run(fenced_agent, superseded_events())
    assert fenced == [("delta", "已发送进度。")]

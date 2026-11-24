"""from_reply 保存只能取发出本次保存调用的那次响应里的正文，绝不能把更早的回复存成新稿件。

回归：2026-11-16 起 GPT（codex_responses）把正文写成工具调用前的 commentary，assistant content 为空；
插件只读 content、空响应又不清旧值，新文件名下静默存进上一集或一段进度说明（正式版约 430 次）。
"""

from contextlib import contextmanager
import json
from pathlib import Path
import shutil

import pytest


SOURCE = Path(__file__).resolve().parents[2] / "extensions" / "jubao-drama"
OLD = "# 第1集大纲\n\n埃利站在医院天台边缘，手里捏着诊断书。一张广告单拍在他脸上，写着荒岛生存挑战。"
NEW = "# 第2集大纲\n\n第二天早上六点，城堡窗帘同时升起。早餐盘里是发白的鱼鳃和扭动的水蛭，有人当场掀翻餐盘。"


@contextmanager
def scope(home):
    from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from tools.terminal_scope import reset_terminal_scope, set_terminal_scope

    home_token = set_hermes_home_override(home)
    secret_token = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
    terminal_token = set_terminal_scope({})
    try:
        yield
    finally:
        reset_terminal_scope(terminal_token)
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)


@pytest.fixture
def employee(tmp_path, monkeypatch):
    from agent.secret_scope import is_multiplex_active, set_multiplex_active
    from hermes_cli.plugins import _reset_plugin_managers_for_tests, get_plugin_manager

    home = tmp_path / ("studio-" + "c" * 20)
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(bundled))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    before = is_multiplex_active()
    _reset_plugin_managers_for_tests()
    set_multiplex_active(True)
    try:
        shutil.copytree(SOURCE, home / "plugins" / "jubao-drama", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (home / "workspace").mkdir()
        (home / "attachments").mkdir()
        (home / "config.yaml").write_text(
            "plugins:\n  enabled: [jubao-drama]\nstudio_security:\n  restricted: false\n  require_agent_invocation: true\n", encoding="utf-8")
        with scope(home):
            manager = get_plugin_manager()
            manager.discover_and_load()
            assert manager._plugins["jubao-drama"].error is None
            _select_agent()
            yield home
    finally:
        _reset_plugin_managers_for_tests()
        set_multiplex_active(before)


def _select_agent():
    """员工先选主 Agent 并读取规则，稿件工具才允许保存（与真实入站顺序一致）。"""
    from hermes_cli.lifecycle import invoke_hook
    from hermes_cli.middleware import apply_llm_request_middleware
    from model_tools import handle_function_call

    message = {"role": "user", "content": "调用 巨豹 Agent-适配 GM3.1 版本"}
    invoke_hook("pre_llm_call", session_id="employee", user_message=message["content"], conversation_history=[message])
    apply_llm_request_middleware({"messages": [message]}, session_id="employee")
    assert json.loads(handle_function_call(
        "skill_view", {"name": "巨豹 Agent-适配 GM3.1 版本"}, session_id="employee")).get("success")


def _response(api_request_id, *, content="", commentary=""):
    """按宿主 turn_response_intake 的方式对插件触发 post_api_request。"""
    from agent.transports.types import NormalizedResponse
    from hermes_cli.lifecycle import invoke_hook

    items = [{"type": "message", "role": "assistant", "phase": "commentary",
              "content": [{"type": "output_text", "text": commentary}]}] if commentary else None
    message = NormalizedResponse(content=content or None, tool_calls=None,
                                 finish_reason="tool_calls" if not content else "stop",
                                 provider_data={"codex_message_items": items} if items else None)
    invoke_hook("post_api_request", session_id="employee", turn_id=api_request_id.split(":")[0],
                api_request_id=api_request_id, assistant_message=message)


def _save(api_request_id, name):
    from model_tools import handle_function_call

    return json.loads(handle_function_call(
        "drama_agent_document", {"action": "save", "kind": "outline", "name": name, "from_reply": True},
        session_id="employee", turn_id=api_request_id.split(":")[0], api_request_id=api_request_id))


def _saved_text(result):
    from model_tools import handle_function_call

    assert result.get("ok") is not False, result
    read = json.loads(handle_function_call(
        "drama_agent_document", {"action": "read", "document_id": result["document"]["id"], "max_chars": 100000},
        session_id="employee"))
    return read.get("content") or read["document"]["content"]


def test_save_uses_manuscript_from_the_same_response_on_both_transports(employee):
    # 上一轮的最终回复（chat_completions 写在 content）
    _response("t1:api:1", content=OLD)
    # 本轮 GPT 把新正文写在 commentary 里，content 为空，同一次响应发出保存
    _response("t2:api:1", commentary=NEW)
    saved = _saved_text(_save("t2:api:1", "第2集大纲"))
    assert "鱼鳃" in saved and "天台" not in saved

    # chat_completions：正文与保存调用在同一次响应的 content 里，照常保存
    _response("t3:api:1", content=OLD)
    saved = _saved_text(_save("t3:api:1", "第1集大纲"))
    assert "天台" in saved and "鱼鳃" not in saved


def test_save_without_manuscript_in_its_response_never_reuses_an_earlier_reply(employee):
    from model_tools import handle_function_call

    _response("t1:api:1", content=OLD)
    # 本次响应没写正文（空回复直接重试保存）
    _response("t2:api:1")
    empty = _save("t2:api:1", "第2集大纲")
    # 本次响应没有触发记录（钩子缺失），缓存里只有上一轮的回复
    _response("t3:api:1", content=OLD)
    unrecorded = _save("t4:api:1", "第3集大纲")

    for result in (empty, unrecorded):
        assert result["ok"] is False
        assert result["retryable"] is True
        # required_user_action 会显示给员工，只能是说明，不能出现工具参数写法
        assert result["required_user_action"] and "from_reply" not in result["required_user_action"]
        assert "from_reply" in result["error"]
    listed = json.loads(handle_function_call("drama_agent_document", {"action": "list"}, session_id="employee"))
    assert not listed.get("documents")


SCRIPT = ("第01集\n\n1-1场  医院天台  夜  外\n\n人物：埃利\n\n△埃利站在天台边缘，手里捏着诊断书。\n\n"
          "埃利：（低声）如果这就是结局，至少让我自己选。\n\n△一张广告单被风卷起，拍在他脸上。")


def _creative_turn(turn_id, message):
    """按真实入站顺序开启一轮创作请求，让稿件核验有本轮任务合同。"""
    from hermes_cli.lifecycle import invoke_hook

    invoke_hook("pre_llm_call", session_id="employee", turn_id=turn_id, user_message=message,
                conversation_history=[{"role": "user", "content": message}])


def _call(action, api_request_id, **extra):
    from model_tools import handle_function_call

    return json.loads(handle_function_call(
        "drama_agent_document", {"action": action, "kind": "script", "name": "第01集 剧本正文", "from_reply": True, **extra},
        session_id="employee", turn_id=api_request_id.split(":")[0], api_request_id=api_request_id))


def _documents():
    from model_tools import handle_function_call

    return json.loads(handle_function_call("drama_agent_document", {"action": "list"}, session_id="employee")).get("documents") or []


def test_checked_draft_is_never_reported_saved_and_lands_as_the_latest_document(employee):
    """check 不产生稿件：回执不能说已保存；同轮随后的保存、或收尾时都要把核验过的这一版存下。"""
    from hermes_cli.lifecycle import invoke_hook

    _creative_turn("t2", "写第1集剧本正文")
    _response("t2:api:1", content=SCRIPT)
    checked = _call("check", "t2:api:1")
    assert checked["saved"] is False and "save" in checked["next"]
    assert not _documents()
    # 模型照指引在下一次响应里直接保存，不再重写全文
    _response("t2:api:2")
    assert "广告单" in _saved_text(_call("save", "t2:api:2"))

    # 模型核验后没保存就结束本轮：收尾补存核验过的这一版
    _creative_turn("t3", "把第1集台词改得更狠一些，写出修改后的剧本正文")
    revised = SCRIPT.replace("至少让我自己选", "我偏要活着看你们怎么收场")
    _response("t3:api:1", content=revised)
    _call("check", "t3:api:1")
    before = {row["id"] for row in _documents()}
    invoke_hook("pre_verify", session_id="employee", turn_id="t3", final_response="已按要求调整第1集台词。")
    added = [row for row in _documents() if row["id"] not in before]
    assert len(added) == 1 and "我偏要活着" in _saved_text({"document": added[0]})


def test_symbol_run_left_by_upstream_cutoff_never_reaches_reply_or_document(employee):
    from hermes_cli.lifecycle import invoke_hook

    tail = "♯" * 483
    final = invoke_hook("transform_llm_output", session_id="employee", turn_id="t9", response_text=SCRIPT + tail)
    shown = next(value for value in final if isinstance(value, str))
    assert "♯" not in shown and shown.startswith(SCRIPT) and len(shown) > len(SCRIPT)
    _creative_turn("t4", "写第1集剧本正文")
    _response("t4:api:1", content=SCRIPT + tail)
    assert "♯" not in _saved_text(_call("save", "t4:api:1"))


def _plugin_module(name):
    import importlib
    from hermes_cli.plugins import get_plugin_manager

    return importlib.import_module(get_plugin_manager()._plugins["jubao-drama"].module.__name__ + "." + name)


ANALYSIS = ("# 《晚来不识卿》原作理解与戏剧资产分析（第1—7集）\n\n## 一、来源索引\n\n- 来源：一卡剧本正文。\n\n"
            "## 二、故事五个观察面\n\n### 1. 故事梗概（基于第1—7集原文事实）\n\n伊芙琳替妹出嫁，换走三座晶矿。\n\n"
            "### 5. 核心期待\n\n观众等待卡伦认出真正的救命恩人。\n\n## 三、主要人物小传\n\n伊芙琳外柔内韧，从不哭闹。\n\n"
            "## 四、原作逐集纲\n\n- **第1集**：三年前焦黑战场，银白雪貂安抚暴走的少主后化为少女。\n"
            "- **第2集**：闪回中伊芙琳收卡伦为血卫，烤饼干讨好却被冷漠拒绝。\n\n"
            "## 五、可迁移戏剧机制\n\n开篇救命底牌加三年后反手交易的结构值得保留，能迅速立住女主不恋爱脑的基调。")


def test_whole_analysis_reply_is_one_document_with_real_episode_counts(employee):
    delivery, evidence = _plugin_module("agent_delivery"), _plugin_module("document_evidence")
    captured = delivery._manuscripts(ANALYSIS, "完整改编给我前20集正文")
    assert len(captured) == 1 and all(part in captured[0]["content"] for part in ("故事梗概", "核心期待", "人物小传", "可迁移"))
    episodes = {row["episode"]: row["non_whitespace_characters"] for row in evidence.text_statistics(ANALYSIS)["episodes"]}
    line = {number: len("".join(next(text for text in ANALYSIS.splitlines() if f"第{number}集" in text and "**" in text)
                                 .split("：", 1)[1].split())) for number in (1, 2)}
    assert episodes == {"第1集": line[1], "第2集": line[2]}
    questions = "材料我看完了，有两件事要你定：\n\n1. 这个剧本你打算做多少集？\n2. 这版你想融入什么改编元素？（人设、世界观都可以）"
    assert delivery._manuscripts(questions, "开始") == []


def test_episodes_the_user_keeps_unchanged_are_not_cut_for_length(employee):
    checks = _plugin_module("requirement_checks")
    body = "△林知微拔掉网线。\n\n林知微：用不着连主库。\n\n"
    draft = "\n\n".join(f"第0{number}集\n\n{number}-1场  会议室  日  内\n\n" + body * repeat for number, repeat in ((4, 1), (5, 1), (6, 80)))
    contract = {"source": {"original_text": "请调整第4集和第5集的台词。第6集保持不变。"}, "current_task": {},
                "active_requirements": [{"id": "R1", "kind": "min_words", "status": "active", "value": {
                    "metric": "non_whitespace_characters", "unit": "per_episode", "minimum": 10, "maximum": 1200}}],
                "semantic_requirements": []}
    report = checks.check_draft(draft, "script", contract)
    flagged = {issue.get("episode") for check in report["checks"] for issue in check.get("issues", [])}
    assert 6 not in flagged and report["checks"][0]["status"] == "pass"
    contract["source"]["original_text"] = "请调整第4集到第6集的台词。"
    assert checks.check_draft(draft, "script", contract)["checks"][0]["status"] == "fail"


def test_reply_that_only_explains_the_revision_is_never_saved_as_the_manuscript(employee):
    """11-19 GPT 返修时只写一句修订说明就保存，说明被存成第2版剧本；说明不是稿件，写出正文后照常保存。"""
    _creative_turn("t1", "写第1集剧本")
    _response("t1:api:1", commentary=SCRIPT)
    assert _call("save", "t1:api:1").get("ok") is not False
    before = len(_documents())

    note = "我按核验回执仅定向修订第1集：补足低于1000个非空白字符的篇幅，并补完整结尾；其余内容保持原稿不变。"
    _response("t1:api:2", commentary=note)
    rejected = _call("save", "t1:api:2")
    assert rejected["ok"] is False and rejected["blocked_reason"] == "manuscript_not_streamed"
    assert "from_reply" not in rejected["required_user_action"]
    assert len(_documents()) == before

    _response("t1:api:3", commentary=note + "\n\n" + SCRIPT + "\n\n△埃利把广告单折好，塞进口袋。")
    assert "折好" in _saved_text(_call("save", "t1:api:3"))


def test_short_analysis_is_kept_but_a_progress_report_is_not(employee):
    from model_tools import handle_function_call

    def save(api_request_id, text):
        _response(api_request_id, commentary=text)
        return json.loads(handle_function_call(
            "drama_agent_document", {"action": "save", "kind": "analysis", "name": "核心期待", "from_reply": True},
            session_id="employee", turn_id=api_request_id.split(":")[0], api_request_id=api_request_id))

    kept = save("t1:api:1", "核心期待：女主被当众退婚后，要在婚礼当天亲手揭穿未婚夫伪造的借据，让真正的债主站到她这一边。")
    assert kept.get("ok") is not False
    progress = save("t2:api:1", "两路只读分析已启动，正在并行核对人物因果与十集篇幅预算；待分析结果返回后，我将直接写出并保存完整正文。")
    assert progress["ok"] is False and progress["blocked_reason"] == "manuscript_not_streamed"


def test_turn_end_capture_keeps_every_episode_the_checker_counts(employee):
    """回归 2026-11-23 测试版：回复首行写成“第 1 集”（带空格）时，收尾补存把它切掉，稿件只剩第2—3集，
    名称变成场次行“1-1场 … 剧本正文”，核验判缺第1集。补存认出的集必须与核验在同一回复里认出的集一致。"""
    delivery, evidence = _plugin_module("agent_delivery"), _plugin_module("document_evidence")
    body = "\n\n人物：林岚、周小满\n\n△林岚推门进来，把病历摔在桌上。\n\n林岚：这份记录是谁改过的？\n\n"
    for heading in ("第 {n} 集", "第{n}集", "第 {n}集"):
        reply = "".join(heading.format(n=n) + f"\n\n{n}-1场  急诊室  夜  内" + body for n in (1, 2, 3))
        captured = delivery._manuscripts(reply, "直接写第1—3集剧本正文")
        assert [row["kind"] for row in captured] == ["script"], (heading, captured)
        assert evidence.text_statistics(captured[0]["content"])["episodes"] == evidence.text_statistics(reply)["episodes"]
    novel = "第 1 章 雨夜来信\n\n" + "雨下了一整夜，许舟推开旧站的铁门，左肩的伤口又渗出血来。\n\n" * 4
    assert delivery._manuscripts(novel, "写第一章")[0]["content"].startswith("第 1 章")

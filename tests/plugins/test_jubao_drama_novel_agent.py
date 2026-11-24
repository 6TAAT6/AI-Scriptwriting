"""小说 Agent V1.0 走真实注册与加载链路：规则和参考模块完整加载，宿主剧本工作流让路，
仍能用稿件卡交付章节、用设定库和提问卡协作；Vee 与其他 Agent 不受影响。"""

from contextlib import contextmanager
from copy import deepcopy
import importlib
import json
from pathlib import Path
import shutil

import pytest


SOURCE = Path(__file__).resolve().parents[2] / "extensions" / "jubao-drama"
SKILL = "jubao-agent-novel-1-0"
KEPT = {"drama_agent_document", "drama_story_bible", "clarify", "todo_list"}
CHAPTER = ("第一章 雨夜来信\n\n　　雨下了一整夜。许舟推开旧站的铁门，左肩的伤口又渗出血来。\n\n"
           "　　“别开灯。”黑暗里有人说。\n\n" + "　　站台尽头的钟停在十一点五十九分，玻璃上贴着一封没有寄件人的信。\n\n" * 12)


@contextmanager
def profile_scope(home):
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
def runtime(tmp_path, monkeypatch):
    from agent.secret_scope import is_multiplex_active, set_multiplex_active
    from hermes_cli.plugins import _reset_plugin_managers_for_tests, get_plugin_manager

    home = tmp_path / "studio-novel"
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(bundled))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    previous = is_multiplex_active()
    _reset_plugin_managers_for_tests()
    set_multiplex_active(True)
    try:
        shutil.copytree(SOURCE, home / "plugins" / "jubao-drama",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (home / "workspace").mkdir()
        (home / "attachments").mkdir()
        (home / "config.yaml").write_text(
            "plugins:\n  enabled: [jubao-drama]\nstudio_security:\n"
            "  restricted: true\n  require_agent_invocation: true\n", encoding="utf-8")
        with profile_scope(home):
            manager = get_plugin_manager()
            manager.discover_and_load()
            loaded = manager._plugins["jubao-drama"]
            assert loaded.error is None
            yield home, loaded.module
    finally:
        _reset_plugin_managers_for_tests()
        set_multiplex_active(previous)


def user_prompt(agent, body):
    return ("【本轮语言偏好】\n简体中文\n【本轮创作能力】\n"
            + json.dumps({"agent": agent, "skills": []}, ensure_ascii=False)
            + "\n【本轮能力操作】\n" + json.dumps([{"id": agent, "action": "enable"}], ensure_ascii=False)
            + "\n\n【用户本轮消息】\n" + body)


def select(agent, session_id, body="写一本都市悬疑长篇，主角许舟，每集1000—1200字。"):
    from hermes_cli.lifecycle import invoke_hook
    text = user_prompt(agent, body)
    # 不提供 turn_id，避免触发与本回归无关的付费要求提取。
    invoke_hook("pre_llm_call", session_id=session_id, user_message=text)
    return text


def visible_tools(session_id):
    from hermes_cli.middleware import apply_llm_request_middleware
    names = (*KEPT, "delegate_task", "drama_requirements", "drama_material_import", "skill_view")
    request = {"messages": [{"role": "system", "content": "会话固定前缀"}, {"role": "user", "content": "继续"}],
               "tools": [{"type": "function", "function": {"name": name, "parameters": {"type": "object"}}} for name in names]}
    result = apply_llm_request_middleware(deepcopy(request), session_id=session_id)
    return {tool["function"]["name"] for tool in result.payload["tools"]}


def reply(session_id, api_request_id, content):
    """按宿主 turn_response_intake 的方式触发 post_api_request，模拟模型在回复里写出整章。"""
    from agent.transports.types import NormalizedResponse
    from hermes_cli.lifecycle import invoke_hook

    message = NormalizedResponse(content=content, tool_calls=None, finish_reason="tool_calls", provider_data=None)
    invoke_hook("post_api_request", session_id=session_id, turn_id=api_request_id.split(":")[0],
                api_request_id=api_request_id, assistant_message=message)


def test_novel_agent_loads_its_rules_keeps_needed_host_tools_and_leaves_vee_unchanged(runtime):
    from model_tools import handle_function_call

    home, module = runtime
    plugin = home / "plugins" / "jubao-drama"
    novel_prompt = select("novel-1-0", "novel-session")
    assert module.active_agent("novel-session") == "novel-1-0"
    loaded = json.loads(handle_function_call("skill_view", {"name": "jubao-drama:" + SKILL}, session_id="novel-session"))
    assert loaded.get("success"), loaded
    entry = (plugin / "skills" / SKILL / "SKILL.md").read_text(encoding="utf-8")
    assert entry[entry.index("\n---\n", 4) + len("\n---\n"):].strip() in loaded["content"], "入口规则必须完整加载"
    for name in ("planning", "craft", "reader-and-titles", "review", "anti-ai", "import-polish-finish"):
        part = json.loads(handle_function_call(
            "skill_view", {"name": "jubao-drama:" + SKILL, "file_path": f"references/{name}.md"}, session_id="novel-session"))
        assert part.get("success"), (name, part)
        assert (plugin / "skills" / SKILL / "references" / f"{name}.md").read_text(encoding="utf-8").strip() in part["content"]

    capsule = importlib.import_module(module.__name__ + ".capsule").CreativeCapsule(None)
    assert capsule._context(novel_prompt, "novel-session", "", []) is None, "小说 Agent 不叠加剧本创作胶囊"
    tools = visible_tools("novel-session")
    assert KEPT <= tools, "小说 Agent 需要稿件卡、设定库、提问卡与任务清单"
    assert not tools & {"delegate_task", "drama_requirements"}
    assert {"drama_material_import", "skill_view"} <= tools

    select("vee-2-1", "vee-session", "原剧大纲如下：女主身患绝症。")
    assert not visible_tools("vee-session") & {"delegate_task", "clarify", "todo_list", "drama_agent_document"}, \
        "Vee 没有登记宿主工具，仍全部隐藏"
    agent1_prompt = select("gm3-1", "agent1-session")
    assert capsule._context(agent1_prompt, "agent1-session", "", [])["context"], "其他 Agent 仍收到创作胶囊"


def test_novel_chapter_saves_as_a_card_without_script_episode_checks(runtime):
    from model_tools import handle_function_call

    home, module = runtime
    select("novel-1-0", "novel-session")
    assert json.loads(handle_function_call("skill_view", {"name": "jubao-drama:" + SKILL}, session_id="novel-session")).get("success")
    reply("novel-session", "t1:api:1", CHAPTER)
    saved = json.loads(handle_function_call(
        "drama_agent_document", {"action": "save", "kind": "novel", "name": "《雾城来信》第1章 雨夜来信", "from_reply": True},
        session_id="novel-session", turn_id="t1", api_request_id="t1:api:1"))
    assert saved.get("ok") is not False, saved
    document = saved["document"]
    # 用户原话里的“每集1000—1200字”是剧本口径；小说章节不按分集合同核验，也不进入返修。
    assert "quality_check" not in document and document.get("status") == "draft", document
    read = json.loads(handle_function_call(
        "drama_agent_document", {"action": "read", "document_id": document["id"], "max_chars": 100000}, session_id="novel-session"))
    text = read.get("content") or read["document"]["content"]
    assert text.startswith("第一章 雨夜来信") and "\n\n　　“别开灯。”" in text

    # 下载的 Word 与稿件卡一致：章标题加粗顶格，正文每段保留两个全角空格。
    from zipfile import ZipFile
    from plugins.plugin_storage import plugin_db
    from contextlib import closing
    with closing(plugin_db("jubao-drama")) as conn:
        receipt = json.loads(conn.execute("SELECT receipt FROM agent_document_delivery WHERE document_id=?",
                                          (document["id"],)).fetchone()[0])
    documents = importlib.import_module(module.__name__ + ".documents")
    with ZipFile(receipt["path"]) as archive:
        paragraphs = documents._docx_paragraphs(archive)
        xml = archive.read("word/document.xml").decode()
    assert paragraphs[0] == "第一章 雨夜来信" and all(line.startswith("　　") for line in paragraphs[1:]), paragraphs[:3]
    first = xml[:xml.index("</w:p>")]
    assert "<w:b" in first and "w:val=\"center\"" not in first, "章标题加粗且顶格"

    control = importlib.import_module(module.__name__ + ".requirement_control")
    assert control.saved_quality({"id": "x", "kind": "script", "content": "第1集\n台词"}, "agent1-session") is not None, \
        "其他 Agent 的存稿核验不变"


SUMMARY = ("我建议把这本书定为现实都市背景下的地铁悬疑长篇。\n\n暂定书名\n\n1. **《末班车没有终点》**（推荐）\n"
           "2. **《零点之后的地铁》**\n3. **《第十三节车厢》**\n\n### 作品定位\n\n"
           + "- 篇幅：番茄长篇，计划约30万字，每章约2200—2800字；主角沈既明是夜班调度员，第一章从零点十三分的监控异常写起。\n" * 30
           + "\n请选择：\n\n1. 确认，生成设定和大纲（推荐）\n2. 我要修改设定\n")


def test_turn_end_never_turns_a_novel_agent_summary_into_a_manuscript(runtime):
    """测试版实测：建项汇总没调用保存，回合收尾补存按标题把汇总切成了一份名为“3. **《第十三节车厢》**”的小说稿。"""
    from hermes_cli.lifecycle import invoke_hook
    from model_tools import handle_function_call

    home, module = runtime
    # 与宿主入站一致：本轮用户原话在会话历史的最后一条 user 行里，才建立本轮来源合同。
    text = user_prompt("novel-1-0", "我想写一本番茄长篇都市悬疑，其他你帮我定，确认后先给我设定和大纲。")
    invoke_hook("pre_llm_call", session_id="novel-session", turn_id="t1", user_message=text,
                conversation_history=[{"role": "user", "content": text}])
    assert json.loads(handle_function_call("skill_view", {"name": "jubao-drama:" + SKILL}, session_id="novel-session")).get("success")
    reply("novel-session", "t1:api:1", SUMMARY)
    invoke_hook("pre_verify", session_id="novel-session", final_response=SUMMARY)
    listed = json.loads(handle_function_call("drama_agent_document", {"action": "list"}, session_id="novel-session"))
    assert listed.get("documents") == [], listed


def test_vee_turn_end_capture_and_markdown_novel_export_stay_as_before(runtime):
    """推广小说 Agent 不改变其他 Agent：正式版员工一直在用 Vee 收尾补存的稿件卡；其他 Agent 用 Markdown 写的小说照旧转换。"""
    from hermes_cli.lifecycle import invoke_hook
    from model_tools import handle_function_call

    home, module = runtime
    text = user_prompt("vee-2-1", "写第1集剧本。")
    invoke_hook("pre_llm_call", session_id="vee-session", turn_id="t1", user_message=text,
                conversation_history=[{"role": "user", "content": text}])
    assert json.loads(handle_function_call("skill_view", {"name": "jubao-drama:jubao-agent-vee-2-1"}, session_id="vee-session")).get("success")
    script = "第1集\n\n1-1场  公主府寝室  夜  内\n人物：艾洛蒂、伊莎博\n" + "△艾洛蒂推开窗，冷风灌进寝室。\n艾洛蒂：你来晚了。\n伊莎博：门外有人。\n" * 20
    reply("vee-session", "t1:api:1", script)
    invoke_hook("pre_verify", session_id="vee-session", final_response=script)
    listed = json.loads(handle_function_call("drama_agent_document", {"action": "list"}, session_id="vee-session"))
    assert listed.get("documents"), "Vee 的收尾补存保持正式版现状"

    documents = importlib.import_module(module.__name__ + ".documents")
    from zipfile import ZipFile
    target = home / "workspace" / "markdown-novel.docx"
    documents.export_script("## 第一章 婚车停在校门口\n\n高考结束那天，**林晚**没有等到录取通知。\n", target, document_kind="novel")
    with ZipFile(target) as archive:
        paragraphs = documents._docx_paragraphs(archive)
    assert not any("##" in line or "**" in line for line in paragraphs), paragraphs

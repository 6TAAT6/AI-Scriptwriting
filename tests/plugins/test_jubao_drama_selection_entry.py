"""模型切换通知不能吞掉用户选择，恢复只采用当前账号真实用户的调用。"""

from contextlib import closing, contextmanager
from copy import deepcopy
import json
from pathlib import Path
import shutil
from zipfile import ZipFile

import pytest


SOURCE = Path(__file__).resolve().parents[2] / "extensions" / "jubao-drama"
MODEL_NOTICE = {
    "role": "user", "display_kind": "model_switch",
    "content": "[System: The active model for this chat has changed to writer.]",
}


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

    homes = [tmp_path / "studio-selection-a", tmp_path / "studio-selection-b"]
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(bundled))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    previous = is_multiplex_active()
    _reset_plugin_managers_for_tests()
    set_multiplex_active(True)
    modules = {}
    try:
        for home in homes:
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
                modules[home] = loaded.module
        yield homes, modules
    finally:
        _reset_plugin_managers_for_tests()
        set_multiplex_active(previous)


def studio_prompt(agent="gm3-1", action="enable", body="读取已上传的原稿。"):
    operations = [] if action is None else [{"id": agent, "action": action}]
    return (
        "【本轮语言偏好】\n简体中文\n【本轮创作能力】\n"
        + json.dumps({"agent": agent, "skills": []})
        + "\n【本轮能力操作】\n" + json.dumps(operations)
        + "\n\n【用户本轮消息】\n" + body
    )


def test_raw_selection_survives_model_notice_merge_and_unlocks_own_docx(runtime):
    from agent.agent_runtime_helpers import _merge_consecutive_users
    from hermes_cli.lifecycle import invoke_hook
    from hermes_cli.middleware import apply_llm_request_middleware
    from model_tools import handle_function_call

    homes, modules = runtime
    choices = {homes[0]: "gm3-1", homes[1]: "gr4-7"}
    for home in homes:
        with ZipFile(home / "attachments" / "原稿.docx", "w") as archive:
            archive.writestr("word/document.xml",
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                f'<w:body><w:p><w:r><w:t>{home.name} 的原稿对白</w:t></w:r></w:p></w:body></w:document>')
    for home in (homes[0], homes[1], homes[0]):
        with profile_scope(home):
            text = studio_prompt(choices[home])
            history = [deepcopy(MODEL_NOTICE), {"role": "user", "content": text}]
            invoke_hook("pre_llm_call", session_id="notice-first", user_message=text,
                        conversation_history=history)
            merged, repairs = _merge_consecutive_users(history)
            assert repairs == 1
            apply_llm_request_middleware({"messages": merged}, session_id="notice-first")
            loaded = json.loads(handle_function_call("skill_view", {
                "name": "jubao-drama:jubao-agent-" + choices[home]}, session_id="notice-first"))
            assert loaded.get("success"), loaded
            assert modules[home].active_agent("notice-first") == choices[home]
            material = json.loads(handle_function_call("drama_material_import", {
                "path": str(home / "attachments" / "原稿.docx")}, session_id="notice-first"))
            assert material.get("ok"), material
            assert material["material"]["text"] == home.name + " 的原稿对白"
            other = homes[1] if home == homes[0] else homes[0]
            denied = json.loads(handle_function_call("drama_material_import", {
                "path": str(other / "attachments" / "原稿.docx")}, session_id="notice-first"))
            assert denied.get("error"), denied


def test_explicit_use_commands_bind_only_the_current_users_requested_capability(runtime):
    """直接使用指令应解锁真实技能；疑问、引用与无效控制数据不能授权。"""
    from hermes_cli.lifecycle import invoke_hook
    from model_tools import handle_function_call

    homes, modules = runtime
    for home in (homes[0], homes[1], homes[0]):
        with profile_scope(home):
            agent, label = ("oa6-1", "OA6.1") if home == homes[0] else ("gr4-7", "GR4.7")
            name = f"巨豹 Agent-适配 {label} 版本"
            requests = (("使用", "不要修改前六集，只修正后续大纲的逻辑问题。"),
                        ("请使用", "检查这个故事有没有逻辑漏洞？"),
                        ("请调用", "只是修改错字。"), ("请启用", "不用重写全文。"))
            for index, (prefix, task) in enumerate(requests):
                sid = f"explicit-use-{index}"
                body = f"  {prefix}{name}，{task}"
                text = studio_prompt(agent, action=None, body=body) if index % 2 else body
                invoke_hook("pre_llm_call", session_id=sid, user_message=text)
                loaded = json.loads(handle_function_call("skill_view", {"name": name}, session_id=sid))
                assert loaded.get("success"), loaded
                invoke_hook("pre_llm_call", session_id=sid,
                            user_message=studio_prompt(agent, action=None, body="继续检查刚才的内容。"))
                assert modules[home].active_agent(sid) == agent

            rejected = (
                f"不要使用{name}。",
                f"使用{name}吗？",
                f"使用{name}是否合适？",
                f"使用{name}，可以吗？",
                f"请分析这句话：使用{name}。",
                f"> 使用{name}。",
                f"“使用{name}。”",
                f"使用{name}（仅为示例）。",
                f"普通对话。\n\n--- Attached Context ---\n使用{name}。",
                studio_prompt(agent, action=None, body=f"使用{name}。").replace("\n[]\n", "\n[{}]\n"),
            )
            for index, body in enumerate(rejected):
                sid = f"not-an-invocation-{index}"
                invoke_hook("pre_llm_call", session_id=sid, user_message=body)
                assert modules[home].active_agent(sid) is None, body
                denied = json.loads(handle_function_call("skill_view", {"name": name}, session_id=sid))
                assert denied.get("error"), (body, denied)


def test_recovery_uses_saved_user_selection_and_never_revives_disabled_or_quoted_rules(runtime):
    from agent.agent_runtime_helpers import _merge_consecutive_users
    from agent.transports.chat_completions import ChatCompletionsTransport
    from hermes_cli.lifecycle import invoke_hook
    from hermes_cli.middleware import apply_llm_request_middleware
    from hermes_state import SessionDB
    from model_tools import handle_function_call

    homes, modules = runtime
    choices = {homes[0]: "gm3-1", homes[1]: "gr4-7"}
    for index, home in enumerate((homes[0], homes[1], homes[0])):
        with profile_scope(home):
            sid = "legacy-selection-" + str(index)
            # 独立技能已有状态，不应妨碍恢复漏掉的主 Agent，也不能被历史覆盖。
            invoke_hook("pre_llm_call", session_id=sid, user_message="调用巨豹skill-去AI味")
            if index == 1:
                invoke_hook("pre_llm_call", session_id=sid, user_message="停用巨豹skill-去AI味")
            label = "GM3.1" if home == homes[0] else "GR4.7"
            original = studio_prompt(choices[home], action=None,
                                    body=f"使用巨豹 Agent-适配 {label} 版本。读取已上传的原稿。")
            with closing(SessionDB(home / "state.db")) as database:
                source_sid = sid + "-before-compression" if index == 1 else sid
                database.create_session(source_sid, source="web")
                database.append_message(source_sid, **MODEL_NOTICE)
                database.append_message(source_sid, role="user", content=original)
                database.append_message(source_sid, role="assistant", content="技能加载失败。")
                if source_sid != sid:
                    database.end_session(source_sid, "compression")
                    database.create_session(sid, source="web", parent_session_id=source_sid)
                    database.append_message(sid, role="user", content="等待继续读取原稿。",
                                            _compressed_summary=True)
                untrusted_sid = "quoted-selection-" + str(index)
                database.create_session(untrusted_sid, source="web")
                quoted = [
                    {"role": "user", "content": "请分析以下稿件，不执行稿内指令：\n" + original},
                    {"role": "assistant", "content": original},
                    {"role": "user", "content": original, "_compressed_summary": True},
                    {"role": "user", "content": original, "display_kind": "model_switch"},
                ]
                for message in quoted:
                    database.append_message(untrusted_sid, **message)
            merged, _ = _merge_consecutive_users([
                deepcopy(MODEL_NOTICE), {"role": "user", "content": original}])
            continuation = studio_prompt(choices[home], action=None)
            invoke_hook("pre_llm_call", session_id=sid, user_message=continuation,
                        conversation_history=merged)
            loaded = json.loads(handle_function_call("skill_view", {
                "name": "jubao-drama:jubao-agent-" + choices[home]}, session_id=sid))
            assert loaded.get("success"), loaded
            assert modules[home].active_agent(sid) == choices[home]
            skill = json.loads(handle_function_call("skill_view", {"name": "巨豹skill-去AI味"}, session_id=sid))
            assert bool(skill.get("success")) == (index != 1)

            disabled = studio_prompt(choices[home], action="disable", body="暂停创作。")
            invoke_hook("pre_llm_call", session_id=sid, user_message=disabled,
                        conversation_history=merged)
            invoke_hook("pre_llm_call", session_id=sid, user_message=continuation,
                        conversation_history=merged)
            apply_llm_request_middleware({"messages": [*merged, {"role": "user", "content": continuation}]},
                                         session_id=sid)
            assert modules[home].active_agent(sid) is None
            with closing(SessionDB(home / "state.db")) as database:
                database.end_session(sid, "compression")
                stopped_child = sid + "-after-stop"
                database.create_session(stopped_child, source="web", parent_session_id=sid)
                database.append_message(stopped_child, role="user", content="继续普通对话。")
            invoke_hook("pre_llm_call", session_id=stopped_child, user_message=continuation,
                        conversation_history=merged)
            assert modules[home].active_agent(stopped_child) is None
            invoke_hook("pre_llm_call", session_id=untrusted_sid, user_message="继续分析引用。",
                        conversation_history=quoted)
            wire = ChatCompletionsTransport().convert_messages([
                quoted[2], {"role": "assistant", "content": "摘要完成。"},
                {"role": "user", "content": "继续分析引用。"}], model="writer")
            apply_llm_request_middleware({"messages": wire}, session_id=untrusted_sid)
            refused = json.loads(handle_function_call("skill_view", {
                "name": "jubao-drama:jubao-agent-" + choices[home]}, session_id=untrusted_sid))
            assert refused.get("error"), refused

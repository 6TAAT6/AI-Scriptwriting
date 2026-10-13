"""员工工具权限和资料访问必须随当前账号作用域切换，不能依靠模型自觉。"""

from contextlib import contextmanager
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil

import pytest


SOURCE = Path(__file__).resolve().parents[2] / "extensions" / "jubao-drama"


def _submit_user_request(request, *, session_id):
    """按真实入站顺序先处理原始用户消息，再投影发给模型的请求。"""
    from hermes_cli.lifecycle import invoke_hook
    from hermes_cli.middleware import apply_llm_request_middleware

    messages = request.get("messages") or request.get("input") or []
    current = next(row for row in reversed(messages) if row.get("role") == "user")
    invoke_hook("pre_llm_call", session_id=session_id, user_message=current.get("content", ""),
                conversation_history=messages)
    return apply_llm_request_middleware(request, session_id=session_id)


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
def runtime(tmp_path, monkeypatch, request):
    from agent.secret_scope import is_multiplex_active, set_multiplex_active
    from hermes_cli.plugins import _reset_plugin_managers_for_tests, get_plugin_manager

    homes = [tmp_path / ("studio-" + "a" * 20), tmp_path / "configured-employee"]
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(bundled))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    before = is_multiplex_active()
    _reset_plugin_managers_for_tests()
    set_multiplex_active(True)
    modules = {}
    try:
        for home in homes:
            shutil.copytree(SOURCE, home / "plugins" / "jubao-drama", ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
            (home / "workspace").mkdir()
            (home / "attachments").mkdir()
            (home / "config.yaml").write_text(
                "plugins:\n  enabled: [jubao-drama]\nstudio_security:\n  restricted: "
                + ("false" if home == homes[0] else "true") + "\n"
                + ("  require_agent_invocation: true\n" if getattr(request, "param", False) else ""),
                encoding="utf-8",
            )
            with scope(home):
                manager = get_plugin_manager()
                manager.discover_and_load()
                loaded = manager._plugins["jubao-drama"]
                assert loaded.error is None
                modules[home] = loaded.module
        yield homes, modules
    finally:
        _reset_plugin_managers_for_tests()
        set_multiplex_active(before)


@pytest.mark.parametrize("runtime", [True], indirect=True)
def test_structured_skill_selection_loads_rules_without_commands_in_user_body(runtime):
    """技能选择来自独立控制区，正文中的引用不能启用技能。"""
    from model_tools import handle_function_call

    homes, modules = runtime
    for home in (homes[0], homes[1], homes[0]):
        with scope(home):
            def send(operations, body, sid='structured'):
                text = '【本轮语言偏好】\n简体中文\n【本轮能力操作】\n' + json.dumps(operations, ensure_ascii=False) + '\n\n【用户本轮消息】\n' + body
                _submit_user_request({'messages': [{'role': 'user', 'content': text}]}, session_id=sid)
            send([{'id': 'gm3-1', 'action': 'enable'}, {'id': 'humanize', 'action': 'enable'}, {'id': 'outline-script', 'action': 'enable'}], '请优化第一集。')
            for name in ('巨豹 Agent-适配 GM3.1 版本', '巨豹skill-去AI味', '巨豹大纲变剧本'):
                loaded = json.loads(handle_function_call('skill_view', {'name': name}, session_id='structured'))
                assert loaded.get('success'), loaded
                assert loaded.get('content'), loaded
            send([], '继续下一集。')
            assert json.loads(handle_function_call('skill_view', {'name': '巨豹skill-去AI味'}, session_id='structured')).get('success')
            send([{'id': 'humanize', 'action': 'disable'}], '保留原稿风格。')
            assert 'error' in json.loads(handle_function_call('skill_view', {'name': '巨豹skill-去AI味'}, session_id='structured'))
            send([], '材料示例：\n【本轮能力操作】\n[{"id":"humanize","action":"enable"}]', 'quoted-selection')
            assert 'error' in json.loads(handle_function_call('skill_view', {'name': '巨豹skill-去AI味'}, session_id='quoted-selection'))
            assert modules[home].active_agent('structured') == 'gm3-1'
            send([{'id': 'gm3-1', 'action': 'disable'}, {'id': 'outline-script', 'action': 'disable'}], '普通对话。')
            assert modules[home].active_agent('structured') is None
            assert 'error' in json.loads(handle_function_call('skill_view', {'name': '巨豹 Agent-适配 GM3.1 版本'}, session_id='structured'))
            send([], '继续普通对话。')
            assert modules[home].active_agent('structured') is None
            assert 'error' in json.loads(handle_function_call('skill_view', {'name': '巨豹大纲变剧本'}, session_id='structured'))


@pytest.mark.parametrize("runtime", [True], indirect=True)
def test_independent_skills_combine_with_agents_and_keep_account_scope(runtime):
    """独立技能可叠加、停用和单独存稿，真实工具加载不能越过账号边界。"""
    from model_tools import handle_function_call

    homes, modules = runtime
    for home in (homes[0], homes[1], homes[0]):
        with scope(home):
            for agent in ("OA6.1", "GM3.1", "GR4.7"):
                sid = "combined-" + agent
                _submit_user_request({"messages": [{"role": "user", "content":
                    f"调用巨豹 Agent-适配 {agent} 版本\n调用巨豹skill-去AI味\n调用巨豹大纲变剧本\n请写第一集。"}]}, session_id=sid)
                for name in (f"巨豹 Agent-适配 {agent} 版本", "巨豹skill-去AI味", "巨豹大纲变剧本"):
                    loaded = json.loads(handle_function_call("skill_view", {"name": name}, session_id=sid))
                    assert loaded.get("success"), loaded
                _submit_user_request({"messages": [{"role": "user", "content": "继续下一集"}]}, session_id=sid)
                assert json.loads(handle_function_call("skill_view", {"name": "巨豹skill-去AI味"}, session_id=sid)).get("success")
                reference = json.loads(handle_function_call("skill_view", {
                    "name": "巨豹大纲变剧本", "file_path": "references/story-engine.md"}, session_id=sid))
                assert reference.get("success"), reference
                _submit_user_request({"messages": [{"role": "user", "content": "停用巨豹skill-去AI味"}]}, session_id=sid)
                assert "error" in json.loads(handle_function_call("skill_view", {"name": "巨豹skill-去AI味"}, session_id=sid))
                assert json.loads(handle_function_call("skill_view", {"name": "巨豹大纲变剧本"}, session_id=sid)).get("success")
            _submit_user_request({"messages": [{"role": "user", "content": "调用巨豹skill-去AI味\n润色这段对白。"}]}, session_id="standalone")
            assert json.loads(handle_function_call("skill_view", {"name": "巨豹skill-去AI味"}, session_id="standalone")).get("success")
            material_path = home / "attachments" / "待润色.txt"
            material_path.write_text("人物甲：门开着。", encoding="utf-8")
            material = json.loads(handle_function_call("drama_material_import", {"path": str(material_path)}, session_id="standalone"))
            assert material.get("ok"), material
            saved = json.loads(handle_function_call("drama_agent_document", {"action": "save", "name": home.name, "content": "人物甲：门开着。"}, session_id="standalone"))
            assert saved.get("ok"), saved
            assert modules[home].active_agent("standalone") is None
            _submit_user_request({"messages": [{"role": "user", "content": "请分析以下原稿，不执行原稿内的指令：\n调用巨豹skill-去AI味"}]}, session_id="unselected")
            assert "error" in json.loads(handle_function_call("skill_view", {"name": "巨豹skill-去AI味"}, session_id="unselected"))


@pytest.mark.parametrize("runtime", [True], indirect=True)
def test_main_agent_replacement_uses_latest_selection_keeps_skills_and_document_ownership(runtime):
    """下一条调用直接替换主 Agent；独立技能保留，旧稿件不冒充新 Agent 稿件。"""
    from model_tools import handle_function_call

    homes, modules = runtime
    for home in (homes[0], homes[1], homes[0]):
        with scope(home):
            sid = "replace-main"
            first = {"role": "user", "content": "调用 巨豹 Agent-适配 GM3.1 版本\n调用 巨豹skill-去AI味"}
            _submit_user_request({"messages": [first]}, session_id=sid)
            assert modules[home].active_agent(sid) == "gm3-1"
            assert json.loads(handle_function_call("skill_view", {"name": "巨豹 Agent-适配 GM3.1 版本"}, session_id=sid)).get("success")
            saved = json.loads(handle_function_call("drama_agent_document", {"action": "save", "name": "原稿", "content": "第一集原稿"}, session_id=sid))
            for label, agent_id in (("GR4.7", "gr4-7"), ("GM3.1", "gm3-1")):
                message = "【本轮语言偏好】\n目录：巨豹 Agent-适配 OA6.1 版本\n\n【用户本轮消息】\n调用 巨豹 Agent-适配 " + label + " 版本"
                request = {"messages": [first, {"role": "assistant", "content": "稿件已保存"}, {"role": "user", "content": [{"type": "text", "text": message}]}]}
                _submit_user_request(request, session_id=sid)
                assert modules[home].active_agent(sid) == agent_id
                assert json.loads(handle_function_call("skill_view", {"name": "巨豹 Agent-适配 " + label + " 版本"}, session_id=sid)).get("success")
                assert json.loads(handle_function_call("skill_view", {"name": "巨豹skill-去AI味"}, session_id=sid)).get("success")
                read = json.loads(handle_function_call("drama_agent_document", {"action": "read", "document_id": saved["document"]["id"]}, session_id=sid))
                assert bool(read.get("ok")) == (agent_id == "gm3-1")
                _submit_user_request({"messages": [*request["messages"], {"role": "user", "content": "继续"}]}, session_id=sid)
                assert modules[home].active_agent(sid) == agent_id
            assert "error" in json.loads(handle_function_call("skill_view", {"name": "巨豹 Agent-适配 GR4.7 版本"}, session_id=sid))


@pytest.mark.parametrize("runtime", [True], indirect=True)
def test_named_agent_reads_both_office_materials_and_saves_its_document(runtime):
    """实际加载技能后，两份材料和版本稿件都能在当前账号内处理。"""
    from zipfile import ZipFile
    from model_tools import handle_function_call

    homes, modules = runtime
    for home in (homes[0], homes[1], homes[0]):
        with scope(home):
            sheet = home / "attachments" / "国内大纲（1）.xlsx"
            script = home / "attachments" / "海外 剧本【120分】.docx"
            with ZipFile(sheet, "w") as archive:
                archive.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="国内大纲" sheetId="1" r:id="rId1"/></sheets></workbook>')
                archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
                archive.writestr("xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="inlineStr"><is><t>国内原纲：闺蜜发现线索。</t></is></c></row></sheetData></worksheet>')
            with ZipFile(script, "w") as archive:
                archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>海外第6集：戒指盒揭开秘密。</w:t></w:r></w:p></w:body></w:document>')
            for agent_id, label in (("gm3-1", "巨豹 Agent-适配 GM3.1 版本"), ("gr4-7", "巨豹 Agent-适配 GR4.7 版本"), ("oa6-1", "巨豹 Agent-适配 OA6.1 版本")):
                session_id = "two-files-" + agent_id
                message = f"调用{label}，第一个是国内大纲，第二个是海外剧本，请续写。\n@file:`{sheet}`\n@file:`{script}`"
                _submit_user_request({"messages": [{"role": "user", "content": message}]}, session_id=session_id)
                loaded = json.loads(handle_function_call("skill_view", {"name": label}, session_id=session_id))
                assert loaded.get("success") is True, loaded
                assert loaded["name"] == "jubao-drama:jubao-agent-" + agent_id
                assert modules[home].active_agent(session_id) == agent_id
                materials = [json.loads(handle_function_call("drama_material_import", {"path": str(source)}, session_id=session_id)) for source in (sheet, script)]
                assert all(row.get("ok") for row in materials), materials
                assert [row["material"]["text"] for row in materials] == ["【国内大纲】\n国内原纲：闺蜜发现线索。", "海外第6集：戒指盒揭开秘密。"]
                if agent_id != "oa6-1":
                    saved = json.loads(handle_function_call("drama_agent_document", {"action": "save", "name": "续写大纲", "content": "第7集：主角核对线索。"}, session_id=session_id))
                    assert saved.get("ok"), saved
                    read = json.loads(handle_function_call("drama_agent_document", {"action": "read", "document_id": saved["document"]["id"]}, session_id=session_id))
                    assert read["document"]["content"] == "第7集：主角核对线索。"


@pytest.mark.parametrize("runtime", [True], indirect=True)
def test_agent_aliases_preserve_invocation_and_cross_agent_guards(runtime):
    """接受别名仍须用户调用，且不能串用其他 Agent、插件和账号。"""
    from model_tools import handle_function_call

    homes, modules = runtime
    with scope(homes[0]):
        names = ("巨豹 Agent-适配 GM3.1 版本", "jubao-agent-gm3-1", "jubao-drama:jubao-agent-gm3-1")
        for name in names:
            assert "error" in json.loads(handle_function_call("skill_view", {"name": name}, session_id="not-invoked"))
        _submit_user_request({"messages": [{"role": "user", "content": "调用巨豹 Agent-适配 GM3.1 版本"}]}, session_id="invoked")
        for name in names:
            result = json.loads(handle_function_call("skill_view", {"name": name}, session_id="invoked"))
            assert result.get("success"), result
        for name in ("巨豹 Agent-适配 OA6.1 版本", "巨豹 Agent-适配 GR4.7 版本", "other:jubao-agent-gm3-1", "../../jubao-agent-gm3-1"):
            assert "error" in json.loads(handle_function_call("skill_view", {"name": name}, session_id="invoked"))
        assert modules[homes[0]].active_agent("invoked") == "gm3-1"
    with scope(homes[1]):
        assert "error" in json.loads(handle_function_call("skill_view", {"name": "巨豹 Agent-适配 GM3.1 版本"}, session_id="invoked"))
        assert modules[homes[1]].active_agent("invoked") is None


@pytest.mark.parametrize("runtime", [True], indirect=True)
def test_business_gate_refusals_are_structured_and_non_retryable(runtime):
    """拒绝原因应区分未选择与混用，下一步操作必须对应真实会话状态。"""
    from model_tools import handle_function_call

    homes, _ = runtime
    with scope(homes[1]):
        result = json.loads(handle_function_call(
            "drama_agent_document", {"action": "list"}, session_id="unselected",
        ))
        unselected = json.loads(handle_function_call(
            "skill_view", {"name": "巨豹 Agent-适配 OA6.1 版本"}, session_id="unselected"))
        assert unselected["blocked_reason"] == "agent_invocation_required"
        assert "选择" in unselected["required_user_action"]
        assert "发送" in unselected["required_user_action"]
        _submit_user_request({"messages": [{"role": "user", "content":
            "调用巨豹 Agent-适配 GM3.1 版本"}]}, session_id="selected")
        mismatch = json.loads(handle_function_call(
            "skill_view", {"name": "巨豹 Agent-适配 OA6.1 版本"}, session_id="selected"))
        assert mismatch["blocked_reason"] == "agent_mismatch"
        assert "巨豹满血版 V1.1" in mismatch["error"] and "巨豹测试版 V2.1" in mismatch["error"]
        assert "巨豹满血版 V1.1" in mismatch["required_user_action"]
        skill = json.loads(handle_function_call(
            "skill_view", {"name": "巨豹skill-去AI味"}, session_id="selected"))
        assert skill["blocked_reason"] == "skill_invocation_required"
        assert "巨豹skill-去AI味" in skill["required_user_action"]
        for refusal in (unselected, mismatch, skill):
            assert refusal["retryable"] is False

    assert result["retryable"] is False
    assert result["blocked_reason"] in {"permission_boundary", "agent_invocation_required", "capability_required"}
    assert result["required_user_action"]


def test_business_error_classifies_transport_and_deterministic_failures_separately(runtime):
    homes, modules = runtime
    with scope(homes[1]):
        plugin = modules[homes[1]]
        validation = json.loads(plugin._business_error("drama_review", ValueError("connection field is invalid")))
        transport = json.loads(plugin._business_error("drama_review", ConnectionError("connection reset")))

    assert validation["retryable"] is False
    assert transport["retryable"] is True


@pytest.mark.parametrize("runtime", [True], indirect=True)
def test_document_save_rejects_missing_name_and_replayed_receipt_without_retry_loop(runtime):
    from model_tools import handle_function_call

    homes, _ = runtime
    with scope(homes[1]):
        _submit_user_request({"messages": [{"role": "user", "content": "调用巨豹 Agent-适配 GM3.1 版本"}]}, session_id="doc-contract")
        missing = json.loads(handle_function_call(
            "drama_agent_document", {"action": "save", "content": "一段正文"}, session_id="doc-contract",
        ))
        replayed = json.loads(handle_function_call(
            "drama_agent_document", {
                "action": "save", "name": "第二稿",
                "content": '{"document":{"id":"old"},"export_status":"draft"}',
            }, session_id="doc-contract",
        ))

    for result in (missing, replayed):
        assert result["ok"] is False
        assert result["retryable"] is False
        assert result["blocked_reason"] == "workflow_precondition"
        assert result["required_user_action"]


def test_employee_tool_boundary_and_business_rules_remain_profile_scoped(runtime):
    from agent.prompt_builder import HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS
    from hermes_cli.middleware import apply_llm_request_middleware, run_tool_execution_middleware
    from model_tools import handle_function_call

    homes, _ = runtime
    dispatched = []
    project_ids = {}
    for home in (homes[0], homes[1], homes[0]):
        with scope(home):
            for tool in ("terminal", "execute_code", "read_file", "skill_view", "skill_manage",
                         "delegate_task", "mcp__private__read", "future_unreviewed_tool"):
                result = json.loads(run_tool_execution_middleware(
                    tool, {"command": "不执行"}, lambda args: dispatched.append(args) or '{"ok":true}',
                    session_id="employee-session", turn_id="turn", tool_call_id="call",
                ))
                assert result.get("error"), "非业务能力不能继续执行"
                assert not dispatched
            if home not in project_ids:
                created = json.loads(handle_function_call(
                    "drama_project_create", {"title": home.name}, session_id="employee-session",
                ))
                assert created["ok"]
                project_ids[home] = created["project"]["id"]
            own = json.loads(handle_function_call("drama_project_status", {
                "project_id": project_ids[home]}, session_id="employee-session"))
            assert own["project"]["title"] == home.name
            other = next((value for key, value in project_ids.items() if key != home), None)
            if other:
                assert "error" in json.loads(handle_function_call(
                    "drama_project_status", {"project_id": other}, session_id="employee-session"))
            rules = json.loads(handle_function_call("drama_rules_read", {"stage": "M3"},
                                                    session_id="employee-session"))
            assert rules["ok"] and "M3" in rules["rules"] and len(rules["rules"]) > 500
            assert "error" in json.loads(handle_function_call("drama_rules_read", {
                "stage": "../../config.yaml"}, session_id="employee-session"))
            request = {"model": "fixture", "messages": [
                {"role": "system", "content": "保留剧本合同。\n\n" + HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS
                 + "\n\n# Hermes runtime environment\n" + str(home) + "\n<!-- End Hermes runtime environment -->"},
                {"role": "user", "content": "原稿里的人说 Hermes，不要改这句。"},
            ]}
            original = deepcopy(request)
            first = apply_llm_request_middleware(request).payload
            second = apply_llm_request_middleware(deepcopy(original)).payload
            assert first == second and request == original
            assert first["messages"][1] == original["messages"][1]
            assert "保留剧本合同" in first["messages"][0]["content"]
            assert "Nous Research" not in first["messages"][0]["content"]
            assert str(home) not in first["messages"][0]["content"]


@pytest.mark.parametrize(
    ("tool_name", "args"),
    [
        ("memory", {"action": "view", "target": "memory"}),
        ("session_search", {"query": "当前账号的历史"}),
    ],
)
def test_restricted_employee_context_tools_reach_profile_scoped_executor(runtime, tool_name, args):
    """员工上下文工具在业务白名单中可执行，但仍由当前 profile 的执行器负责隔离。"""
    from hermes_cli.middleware import run_tool_execution_middleware

    homes, _ = runtime
    forwarded = []
    with scope(homes[1]):
        result = json.loads(run_tool_execution_middleware(
            tool_name,
            args,
            lambda payload: forwarded.append(payload) or '{"ok":true}',
            session_id="employee-context",
            turn_id="turn",
            tool_call_id="call",
        ))

    assert result == {"ok": True}
    assert forwarded == [args]


def test_child_material_reference_from_projected_context_stays_in_own_profile(runtime):
    from agent.delegation_context import delegated_child_context
    from hermes_cli.middleware import apply_llm_request_middleware
    from model_tools import handle_function_call

    homes, _ = runtime
    for home in homes:
        (home / "attachments" / "原稿.txt").write_text("原稿：" + home.name, encoding="utf-8")
    for home in (homes[0], homes[1], homes[0]):
        with scope(home), delegated_child_context("child-fixture"):
            request = {"messages": [{"role": "system", "content": str(home / "attachments" / "原稿.txt")}]}
            projected = apply_llm_request_middleware(request).payload["messages"][0]["content"]
            for reference in (projected, "attachments/原稿.txt", str(home / "attachments" / "原稿.txt")):
                result = json.loads(handle_function_call("drama_material_import", {"path": reference}, session_id="child-fixture"))
                assert result.get("ok"), result
                assert result["material"]["text"] == "原稿：" + home.name
            for reference in ("[内部创作目录]/../other/原稿.txt", "[内部创作目录]/config.yaml", "attachments/../config.yaml"):
                result = json.loads(handle_function_call("drama_material_import", {"path": reference}, session_id="child-fixture"))
                assert "error" in result


def test_concurrent_conversations_do_not_inherit_the_accounts_latest_project(runtime):
    from hermes_cli.plugins import get_plugin_manager
    from model_tools import handle_function_call

    homes, _ = runtime
    with scope(homes[0]):
        for session, title in (("conversation-a", "甲会话的钟表故事"), ("conversation-b", "乙会话的海港故事")):
            result = json.loads(handle_function_call("drama_project_create", {"title": title}, session_id=session))
            assert result["project"]["title"] == title
        for session in ("conversation-a", "conversation-b", "new-conversation"):
            results = get_plugin_manager().invoke_hook(
                "pre_llm_call", session_id=session, user_message="你好", conversation_history=[], is_first_turn=True,
            )
            context = json.dumps(results, ensure_ascii=False)
            assert "甲会话的钟表故事" not in context
            assert "乙会话的海港故事" not in context


def test_submit_error_provides_flat_data_that_can_be_retried_without_state_loss(runtime):
    from model_tools import handle_function_call

    homes, _ = runtime
    with scope(homes[0]):
        created = json.loads(handle_function_call("drama_project_create", {"title": "参数自修验收"}, session_id="author"))
        project_id = created["project"]["id"]
        for kind, content in (("source", "用户原稿全文。"), ("core", "主角用专业证据证明清白。")):
            before = json.loads(handle_function_call("drama_project_status", {"project_id": project_id}, session_id="author"))["project"]
            failed = json.loads(handle_function_call("drama_submit", {
                "project_id": project_id, "kind": kind, "data": {kind: {"content": content}},
            }, session_id="author"))
            assert failed.get("error") and not failed.get("ok")
            assert "content" in failed["expected_data"] and kind not in failed["expected_data"]
            assert json.loads(handle_function_call("drama_project_status", {"project_id": project_id}, session_id="author"))["project"] == before
            corrected = {**failed["expected_data"], "content": content}
            retried = json.loads(handle_function_call("drama_submit", {
                "project_id": project_id, "kind": kind, "data": corrected,
            }, session_id="author"))
            assert retried["ok"] and retried["project"][kind]["content"] == content


def test_independent_review_has_a_profile_scoped_long_document_budget(runtime):
    from agent.auxiliary_client import _effective_aux_timeout
    from agent.plugin_llm import _resolve_task_ownership
    from hermes_cli.config import atomic_config_replace, load_config_readonly
    from hermes_cli.plugins import get_plugin_auxiliary_tasks

    homes, _ = runtime
    for home in (homes[0], homes[1], homes[0]):
        with scope(home):
            tasks = [row for row in get_plugin_auxiliary_tasks() if row['key'] == 'jubao_drama_review']
            assert len(tasks) == 1, '长篇审稿必须使用插件自己的预算，不能落到普通辅助请求的短超时'
            assert tasks[0]['key'] in _resolve_task_ownership(tasks[0]['plugin'])[0]
            assert _effective_aux_timeout('jubao_drama_review', None) > _effective_aux_timeout('', None)
            config = load_config_readonly()
            requested = 240 if home == homes[0] else 480
            config.setdefault('auxiliary', {}).setdefault('jubao_drama_review', {})['timeout'] = requested
            atomic_config_replace(home / 'config.yaml', config)
            assert _effective_aux_timeout('jubao_drama_review', None) == requested


def test_source_submission_reads_an_uploaded_path_without_cross_account_access(runtime):
    from model_tools import handle_function_call

    homes, _ = runtime
    for home in homes:
        (home / 'attachments' / '原稿.txt').write_text(home.name + ' 的真实原稿', encoding='utf-8')
    for home in (homes[0], homes[1], homes[0]):
        with scope(home):
            project = json.loads(handle_function_call('drama_project_create', {'title': '原稿路径验收'}, session_id='source-path'))['project']
            accepted = json.loads(handle_function_call('drama_submit', {'project_id': project['id'], 'kind': 'source', 'data': {'path': str(home / 'attachments' / '原稿.txt'), 'name': '原稿.txt'}}, session_id='source-path'))
            assert accepted.get('ok'), accepted
            assert accepted['project']['source']['content'] == home.name + ' 的真实原稿'
            other = homes[1] if home == homes[0] else homes[0]
            denied = json.loads(handle_function_call('drama_submit', {'project_id': project['id'], 'kind': 'source', 'data': {'path': str(other / 'attachments' / '原稿.txt')}}, session_id='source-path'))
            assert denied.get('error') and other.name not in json.dumps(denied)
            unchanged = json.loads(handle_function_call('drama_project_status', {'project_id': project['id']}, session_id='source-path'))['project']
            assert unchanged['source']['content'] == accepted['project']['source']['content']


@pytest.mark.parametrize("runtime", [True], indirect=True)
def test_selected_agent_is_available_before_first_skill_read_and_material_pages_are_lossless(runtime):
    from model_tools import handle_function_call
    homes, modules = runtime
    for home in (homes[0], homes[1], homes[0]):
        with scope(home):
            sid = 'selection-and-long-material'
            _submit_user_request({'messages': [{'role': 'user', 'content': '调用 巨豹 Agent-适配 GM3.1 版本\n读取上传的原稿。'}]}, session_id=sid)
            assert modules[home].active_agent(sid) == 'gm3-1', '用户明确选择后读取资料无需依赖模型先执行 skill_view'
            content = (home.name + '中文稿件。\n') * 16000
            file = home / 'attachments' / '长原稿.txt'
            file.write_text(content)
            chunks=[];offset=0
            while True:
                result=json.loads(handle_function_call('drama_material_import', {'path': str(file), 'start_char':offset, 'max_chars':12000}, session_id=sid))
                assert result.get('ok'), result
                part=result['material'];chunks.append(part['text'])
                assert len(part['text'])<=12000
                assert part['characters']==len(content)
                if part['next_start_char'] is None:break
                assert part['next_start_char']>offset
                offset=part['next_start_char']
            assert ''.join(chunks)==content
            foreign = homes[1] if home==homes[0] else homes[0]
            denied=json.loads(handle_function_call('drama_material_import', {'path':str(foreign/'attachments'/'长原稿.txt')},session_id=sid))
            assert denied.get('error') and not denied.get('ok')


def test_employee_export_collision_preserves_old_file_and_recovers_with_new_name(runtime):
    from model_tools import handle_function_call

    homes, _ = runtime
    with scope(homes[0]):
        project = json.loads(handle_function_call("drama_project_create", {
            "title": "导出重名验收", "mode": "export",
        }, session_id="author"))["project"]
        project_id = project["id"]
        handle_function_call("drama_submit", {"project_id": project_id, "kind": "source",
                            "data": {"content": "必须保留的第一版原稿。"}}, session_id="author")
        args = {"project_id": project_id, "kind": "script", "destination": "交付.docx"}
        first = json.loads(handle_function_call("drama_export", args, session_id="author"))
        assert first["ok"]
        target = homes[0] / "workspace" / "交付.docx"
        before = target.read_bytes()
        duplicate = json.loads(handle_function_call("drama_export", args, session_id="author"))
        assert "文件已存在" in duplicate["error"] and "新文件名" in duplicate["error"]
        assert target.read_bytes() == before
        next_result = json.loads(handle_function_call("drama_export", {**args, "destination": "交付-v2.docx"}, session_id="author"))
        assert next_result["ok"] and (homes[0] / "workspace" / "交付-v2.docx").is_file()


def test_employee_materials_and_exports_never_follow_paths_outside_own_data(runtime, tmp_path):
    from model_tools import handle_function_call

    homes, modules = runtime
    outside = tmp_path / "宿主资料.txt"
    outside.write_text("宿主内容", encoding="utf-8")
    pdf_body = b"BT /F1 12 Tf 20 50 Td (safe material) Tj ET"
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
               b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
               b"<< /Length " + str(len(pdf_body)).encode() + b" >>\nstream\n" + pdf_body + b"\nendstream"]
    pdf = b"%PDF-1.4\n"
    offsets = []
    for number, obj in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf += str(number).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
    xref = len(pdf)
    pdf += b"xref\n0 6\n0000000000 65535 f \n" + b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    pdf += b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n"
    for home in homes:
        (home / "attachments" / "原稿.txt").write_text(home.name, encoding="utf-8")
        (home / "attachments" / "资料.csv").write_text("人物,关系\n林青,姐妹\n", encoding="utf-8")
        (home / "attachments" / "资料.pdf").write_bytes(pdf)
        (home / "workspace" / "link").symlink_to(tmp_path, target_is_directory=True)
        os.link(outside, home / "workspace" / "硬链接.txt")
    for home in (homes[0], homes[1], homes[0]):
        other = homes[1] if home == homes[0] else homes[0]
        with scope(home):
            source = home / "attachments" / "原稿.txt"
            result = json.loads(handle_function_call("drama_material_import", {"path": str(source)},
                                                    session_id="employee-session"))
            assert result["material"]["text"] == home.name
            csv = json.loads(handle_function_call("drama_material_import", {
                "path": str(home / "attachments" / "资料.csv")}, session_id="employee-session"))
            assert "林青,姐妹" in csv["material"]["text"]
            from hermes_platform.resolver import locate_command
            from hermes_platform.resolver.known_dirs import homebrew_dirs
            pdf_result = json.loads(handle_function_call("drama_material_import", {
                "path": str(home / "attachments" / "资料.pdf")}, session_id="employee-session"))
            if locate_command("pdftotext", known_dirs=homebrew_dirs()).found:
                assert "safe material" in pdf_result["material"]["text"]
            else:
                assert "error" in pdf_result
            for forbidden in (outside, other / "attachments" / "原稿.txt", home / "config.yaml",
                              home / "workspace" / "link" / outside.name,
                              home / "workspace" / "硬链接.txt", home / "plugins" / "jubao-drama" / "SOUL.md"):
                result = json.loads(handle_function_call("drama_material_import", {"path": str(forbidden)},
                                                        session_id="employee-session"))
                assert "error" in result, "只能读取当前账号普通资料文件"
            documents = __import__(modules[home].__name__ + ".documents", fromlist=["export_script"])
            for destination in (tmp_path / "越界.docx", other / "workspace" / "越界.docx",
                                home / "attachments" / "覆盖原稿.docx",
                                home / "workspace" / "link" / "越界.docx"):
                with pytest.raises((ValueError, PermissionError, OSError)):
                    documents.export_script("合法正文也不能写入越界目录", destination)
                assert not destination.exists()
            destination = home / "workspace" / ("正文-" + str(len(list((home / "workspace").glob('正文-*')))) + ".docx")
            receipt = documents.export_script("第1集\n她推开门。", destination)
            assert receipt["content_verified"]
            assert "她推开门。" in documents.read_material(destination)["text"]


@pytest.mark.parametrize('runtime',[True],indirect=True)
def test_child_inherits_before_any_parent_tool_and_cannot_select_a_different_agent(runtime):
    from model_tools import handle_function_call
    from agent.delegation_context import delegated_child_context
    from hermes_state import SessionDB
    homes,modules=runtime
    for home in (homes[0],homes[1],homes[0]):
        with scope(home):
            _submit_user_request({'messages':[{'role':'user','content':'调用巨豹 Agent-适配 GM3.1 版本\n调用巨豹skill-去AI味'}]},session_id='parent-before-tool')
            database=SessionDB(home/'state.db')
            try:
                if not database.get_session('parent-before-tool'):database.create_session('parent-before-tool',source='web')
                if not database.get_session('child-before-tool'):database.create_session('child-before-tool',source='web',parent_session_id='parent-before-tool')
                file=home/'attachments'/'子任务资料.txt';file.write_text('账号专属标记 '+home.name)
                with delegated_child_context('child-before-tool'):
                    _submit_user_request({'messages':[{'role':'user','content':'调用巨豹 Agent-适配 OA6.1 版本'}]},session_id='child-before-tool')
                    assert modules[home].active_agent('child-before-tool')=='gm3-1'
                    loaded=json.loads(handle_function_call('skill_view',{'name':'巨豹 Agent-适配 GM3.1 版本'},session_id='child-before-tool'))
                    assert loaded.get('success'),loaded
                    assert json.loads(handle_function_call('skill_view',{'name':'巨豹skill-去AI味'},session_id='child-before-tool')).get('success')
                    read=json.loads(handle_function_call('drama_material_import',{'path':str(file)},session_id='child-before-tool'))
                    assert read['material']['text']=='账号专属标记 '+home.name
                    denied=json.loads(handle_function_call('delegate_task',{'goal':'继续委派'},session_id='child-before-tool'))
                    assert denied.get('error')
            finally:database.close()


@pytest.mark.parametrize('runtime',[True],indirect=True)
def test_old_conversation_recovers_explicit_selection_but_disabled_binding_stays_off(runtime):
    from model_tools import handle_function_call
    from hermes_state import SessionDB
    homes,modules=runtime
    for index,home in enumerate((homes[0],homes[1],homes[0])):
        sid=f"legacy-missing-binding-{index}"
        with scope(home):
            initial={'role':'user','content':'调用巨豹 Agent-适配 GM3.1 版本\n调用巨豹skill-去AI味\n写作。'}
            request={'messages':[initial,{'role':'assistant','content':'已记录。'},{'role':'user','content':'继续下一场。'}]}
            database = SessionDB(home / 'state.db')
            try:
                database.create_session(sid, source='web')
                for message in request['messages']:
                    database.append_message(sid, **message)
            finally:
                database.close()
            _submit_user_request(request,session_id=sid)
            assert modules[home].active_agent(sid)=='gm3-1'
            assert json.loads(handle_function_call('skill_view',{'name':'巨豹skill-去AI味'},session_id=sid)).get('success')
            disabled={'role':'user','content':'【本轮语言偏好】\n简体中文\n【本轮能力操作】\n[{"id":"gm3-1","action":"disable"},{"id":"humanize","action":"disable"}]\n\n【用户本轮消息】\n先暂停创作。'}
            _submit_user_request({'messages':[*request['messages'],disabled]},session_id=sid)
            _submit_user_request(request,session_id=sid)
            assert modules[home].active_agent(sid) is None
            assert json.loads(handle_function_call('skill_view',{'name':'巨豹skill-去AI味'},session_id=sid)).get('error')

"""员工配置只继承受限模型代理和审读后的创作能力，源账号秘密不能进入员工目录。"""

from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest


SOURCE = Path(__file__).resolve().parents[3] / "apps/drama-studio/server/profiles.py"
SPEC = importlib.util.spec_from_file_location("studio_secure_profiles", SOURCE)
PROFILES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROFILES)


@contextmanager
def scope(home):
    from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from tools.terminal_scope import reset_terminal_scope, set_terminal_scope

    h = set_hermes_home_override(home)
    s = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
    t = set_terminal_scope({})
    try:
        yield
    finally:
        reset_terminal_scope(t)
        reset_secret_scope(s)
        reset_hermes_home_override(h)


@pytest.fixture
def source_home(tmp_path, monkeypatch):
    from hermes_cli.config import atomic_config_replace
    from hermes_cli.plugins import _reset_plugin_managers_for_tests

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    root = tmp_path / "deployment" / ".hermes"
    monkeypatch.setenv("HERMES_HOME", str(root))
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(bundled))
    monkeypatch.delenv("HERMES_TUI_TOOLSETS", raising=False)
    source = root / "profiles" / "jubao-drama"
    source.mkdir(parents=True)
    atomic_config_replace(source / "config.yaml", {
        "model": {"default": "owner-model", "provider": "owner", "api_key": "owner-config-canary"},
        "providers": {"owner": {"base_url": "https://owner.invalid/v1", "key_env": "OWNER_API_KEY",
                                "extra_headers": {"X-Private": "owner-header-canary"}}},
        "auxiliary": {"compression": {"api_key": "owner-aux-canary"}},
        "mcp_servers": {"private": {"command": "private-command-canary"}},
        "platform_toolsets": {"cli": ["hermes-cli"]},
        "plugins": {"enabled": ["jubao-drama", "owner-private-plugin"]},
    })
    (source / ".env").write_text("OWNER_API_KEY=owner-env-canary\nOTHER_SECRET=owner-other-canary\n")
    (source / "SOUL.md").write_text("源账号私人身份配置-canary", encoding="utf-8")
    (source / "plugins" / "owner-private-plugin").mkdir(parents=True)
    (source / "plugins" / "owner-private-plugin" / "__init__.py").write_text("raise RuntimeError('不得载入')")
    _reset_plugin_managers_for_tests()
    try:
        yield root, source
    finally:
        _reset_plugin_managers_for_tests()


def test_provision_requires_valid_loopback_inference_before_creating_workspace(source_home):
    root, source = source_home
    before = (source / ".env").read_bytes()
    name = "studio-" + "c" * 20
    invalid = [None, {}, {"base_url": "https://owner.invalid/v1", "token": "t" * 40,
                         "model": "fixture", "models": ["fixture"], "api_mode": "chat_completions"}]
    for inference in invalid:
        try:
            PROFILES.provision(name, inference=inference)
        except ValueError:
            pass
        except TypeError:
            pytest.fail("账号创建尚未接入可信模型代理配置")
        else:
            pytest.fail("缺少可信代理时必须拒绝创建账号目录")
        assert not (root / "studio-workers" / name).exists()
    assert (source / ".env").read_bytes() == before


def test_employee_profile_disables_native_personal_profile_offer_on_first_contact(source_home):
    from agent.onboarding import first_contact_turn_note, profile_build_mode
    from hermes_cli.config import load_config_readonly

    root, source = source_home
    route = {"base_url": "http://127.0.0.1:45001/v1", "token": "proxy-fixture-" + "x" * 40,
             "model": "fixture", "models": ["fixture"], "api_mode": "chat_completions"}
    home = Path(PROFILES.provision("studio-" + "d" * 20, route)["home"])
    with scope(home):
        cfg = load_config_readonly()
        assert profile_build_mode(cfg) == "off"
        before = (home / "config.yaml").read_bytes()
        first_contact_turn_note(cfg, home / "config.yaml", session_history_empty=True, install_has_prior_sessions=False)
        assert (home / "config.yaml").read_bytes() == before
    with scope(source):
        assert profile_build_mode(load_config_readonly()) == "ask"
    PROFILES.refresh_inference(home.name, route, workers_root=root / "studio-workers")
    with scope(home):
        assert profile_build_mode(load_config_readonly()) == "off"


def test_profiles_resolve_only_their_proxy_credentials_and_business_tools(source_home, monkeypatch):
    from agent.secret_scope import is_multiplex_active, set_multiplex_active
    from agent.auxiliary_client import _resolve_auto_route, get_text_auxiliary_client
    from hermes_cli.config import load_config_readonly, read_user_config_raw
    from hermes_cli.plugins import get_plugin_manager
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from hermes_cli.profiles import get_profile_dir
    from model_tools import get_tool_definitions
    from tui_gateway.server import _load_disabled_toolsets, _load_enabled_toolsets

    root, source = source_home
    source_before = {file.name: file.read_bytes() for file in (source / "config.yaml", source / ".env", source / "SOUL.md")}
    mappings = {}
    for index, letter in enumerate(("a", "b")):
        name = "studio-" + letter * 20
        route = {"base_url": f"http://127.0.0.1:{45001 + index}/v1", "token": "proxy-fixture-" + letter * 40,
                 "model": "fixture-model-" + letter, "models": ["fixture-model-" + letter],
                 "api_mode": "chat_completions" if index == 0 else "responses",
                 "model_metadata": {"fixture-model-" + letter: {"context_length": 1048576 if index == 0 else 872000, "supported_efforts": ["low", "high"], "default_reasoning_effort": "high"}}}
        try:
            result = PROFILES.provision(name, inference=route)
        except TypeError:
            pytest.fail("账号创建尚未接入可信模型代理配置")
        home = Path(result["home"])
        assert home == root / "studio-workers" / name
        mappings[home] = route
        stored = read_user_config_raw(home / "config.yaml")
        serialized = json.dumps(stored, ensure_ascii=False) + (home / ".env").read_text()
        assert "canary" not in serialized and "owner.invalid" not in serialized
        assert route["token"] not in (home / "config.yaml").read_text()
        assert (home / ".env").read_text().count("=") == 1
        assert {p.name for p in (home / "plugins").iterdir()} == {"jubao-drama"}
        assert not list((home / "skills").rglob("*.md"))
        assert "源账号私人身份配置" not in (home / "SOUL.md").read_text()
        assert "巨豹智能体" in (home / "SOUL.md").read_text()
    home = next(iter(mappings))
    artifact = home / "workspace" / "已保存原稿.txt"
    artifact.write_text("现有原稿不能因重启丢失。", encoding="utf-8")
    state = home / "state.db"
    state.write_bytes(b"saved-state-canary")
    fresh = {**mappings[home], "base_url": "http://127.0.0.1:45200/scope/" + "s" * 32 + "/v1",
             "token": "refreshed-proxy-" + "x" * 40}
    from hermes_cli.config import atomic_config_replace
    changed = read_user_config_raw(home / "config.yaml")
    changed["mcp_servers"] = {"untrusted": {"command": "should-not-survive"}}
    changed["terminal"]["env"] = {"UNTRUSTED": "should-not-survive"}
    atomic_config_replace(home / "config.yaml", changed)
    refresh = getattr(PROFILES, "refresh_inference", None)
    assert callable(refresh), "已创建账号需要独立的安全代理轮换入口"
    refreshed = refresh(home.name, fresh)
    assert refreshed["home"] == str(home)
    assert artifact.read_text() == "现有原稿不能因重启丢失。"
    assert state.read_bytes() == b"saved-state-canary"
    assert mappings[home]["token"] not in (home / ".env").read_text()
    assert "should-not-survive" not in (home / "config.yaml").read_text()
    mappings[home] = fresh
    child = subprocess.run(
        [sys.executable, str(SOURCE), home.name, "--refresh"], input=json.dumps(fresh), text=True,
        capture_output=True, timeout=20,
        env={**os.environ, "HERMES_HOME": str(root), "PYTHONPATH": str(SOURCE.parents[3])},
    )
    assert child.returncode == 0, child.stderr
    assert json.loads(child.stdout)["home"] == str(home)
    assert fresh["token"] not in child.stdout + child.stderr
    homes = list(mappings)
    before = is_multiplex_active()
    set_multiplex_active(True)
    try:
        for home in (homes[0], homes[1], homes[0]):
            monkeypatch.setenv("HERMES_HOME", str(home))
            with scope(home):
                assert get_profile_dir("default") == home
                get_plugin_manager().discover_and_load()
                cfg = load_config_readonly()
                definitions = get_tool_definitions(_load_enabled_toolsets("web"), _load_disabled_toolsets(), quiet_mode=True)
                names = {definition["function"]["name"] for definition in definitions}
                assert {"drama_project_create", "drama_project_status", "drama_material_import", "drama_submit",
                        "drama_confirm", "drama_review", "drama_export", "drama_rules_read"} <= names
                assert names <= {"drama_project_create", "drama_project_status", "drama_material_import", "drama_submit",
                                 "drama_confirm", "drama_review", "drama_export", "drama_rules_read", "todo_list", "clarify", "delegate_task",
                        "skills_list", "skill_view", "skill_manage", "drama_agent_document", "memory", "session_search"}
                route = mappings[home]
                from agent.model_metadata import get_model_context_length
                assert get_model_context_length(route['model'], base_url=route['base_url'], provider='custom') == route['model_metadata'][route['model']]['context_length']
                assert cfg['agent']['reasoning_overrides'][route['model']] == 'high'
                runtime = resolve_runtime_provider(requested=cfg["model"]["provider"])
                assert runtime["api_key"] == route["token"]
                assert runtime["base_url"].rstrip("/") == route["base_url"]
                assert runtime["api_mode"] == ("chat_completions" if home == homes[0] else "codex_responses")
                runtime["model"] = route["model"]
                for task in ("compression", "title_generation", "review"):
                    client, model = get_text_auxiliary_client(task, main_runtime=runtime)
                    assert client.api_key == route["token"]
                    assert str(client.base_url).rstrip("/") == route["base_url"]
                    assert model == route["model"]
                    client.close()
                # 插件未指定task时沿用主模型路由，独立审稿也不能回落到运营者端点。
                client, model, _ = _resolve_auto_route(main_runtime=runtime)
                assert client.api_key == route["token"]
                assert str(client.base_url).rstrip("/") == route["base_url"]
                assert model == route["model"]
                client.close()
    finally:
        set_multiplex_active(before)
    for name, content in source_before.items():
        assert (source / name).read_bytes() == content


def test_refresh_rejects_linked_config_credentials_and_parent_without_touching_host(source_home, tmp_path, monkeypatch):
    root, _ = source_home
    route = {"base_url": "http://127.0.0.1:45100/v1", "token": "proxy-fixture-" + "x" * 40,
             "model": "fixture-model", "models": ["fixture-model"], "api_mode": "chat_completions"}
    outside = tmp_path / "outside.yaml"
    outside.write_text("studio_security:\n  restricted: true\nprivate: outside-canary\n")
    original = outside.read_bytes()
    for index, (filename, hardlink) in enumerate(((".env", False), ("config.yaml", False),
                                                 (".env", True), ("config.yaml", True))):
        name = "studio-" + f"{index:020x}"
        home = Path(PROFILES.provision(name, route)["home"])
        material = home / "workspace" / "原稿.txt"
        material.write_text("保留的原稿", encoding="utf-8")
        target = home / filename
        target.unlink()
        if hardlink:
            os.link(outside, target)
        else:
            target.symlink_to(outside)
        with pytest.raises((ValueError, PermissionError, OSError)):
            PROFILES.refresh_inference(name, route)
        assert outside.read_bytes() == original
        assert material.read_text() == "保留的原稿"
    alias = tmp_path / "alias"
    alias.symlink_to(root.parent, target_is_directory=True)
    name = "studio-" + "d" * 20
    home = Path(PROFILES.provision(name, route)["home"])
    with pytest.raises((ValueError, PermissionError, OSError)):
        PROFILES.refresh_inference(name, route, workers_root=alias / ".hermes" / "studio-workers")
    assert home.is_dir() and outside.read_bytes() == original
    for index, (relative, hardlink) in enumerate((("plugins/jubao-drama/security.py", False), ("SOUL.md", True))):
        target_home = Path(PROFILES.provision("studio-" + f"{100 + index:020x}", route)["home"])
        target = target_home / relative
        target.unlink()
        if hardlink:
            os.link(outside, target)
        else:
            target.symlink_to(outside)
        token = (target_home / ".env").read_bytes()
        with pytest.raises((ValueError, PermissionError, OSError)):
            PROFILES.sync_worker_capabilities(target_home)
        assert outside.read_bytes() == original and (target_home / ".env").read_bytes() == token
    # 模拟校验以后、准备新配置时目标被替换；实际 canonical writer 仍只写可信临时目录。
    from hermes_cli import config
    writer = config.atomic_config_replace

    def raced_write(target, data, **kwargs):
        (home / "config.yaml").unlink()
        (home / "config.yaml").symlink_to(outside)
        return writer(target, data, **kwargs)

    monkeypatch.setattr(config, "atomic_config_replace", raced_write)
    with pytest.raises((ValueError, PermissionError, OSError)):
        PROFILES.refresh_inference(name, route)
    assert outside.read_bytes() == original


def test_native_employee_delegation_inherits_profile_and_actual_child_tool_boundary(source_home, monkeypatch):
    from agent.delegation_context import is_delegated_child_context
    from agent.secret_scope import get_secret, is_multiplex_active, set_multiplex_active
    from hermes_cli.middleware import run_tool_execution_middleware
    from hermes_cli.plugins import get_plugin_manager
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from hermes_constants import get_hermes_home
    from hermes_state import SessionDB
    from model_tools import get_tool_definitions, handle_function_call
    from tui_gateway.server import _load_disabled_toolsets, _load_enabled_toolsets
    from tools.delegate_tool import _get_max_concurrent_children, _get_max_spawn_depth
    import run_agent

    root, _ = source_home
    homes = {}
    for index, letter in enumerate(('d', 'e')):
        route = {'base_url': f'http://127.0.0.1:{45500 + index}/v1', 'token': 'child-proxy-' + letter * 40,
                 'model': 'child-model-' + letter, 'models': ['child-model-' + letter], 'api_mode': 'chat_completions'}
        home = Path(PROFILES.provision('studio-' + letter * 20, route)['home'])
        (home / 'attachments' / '原稿.txt').write_text(home.name, encoding='utf-8')
        manuscript = home / 'workspace' / '现有草稿.txt'
        manuscript.write_text('已保存的剧本不能被能力升级改写。', encoding='utf-8')
        import sqlite3
        with sqlite3.connect(home / 'state.db') as connection:
            connection.execute('CREATE TABLE saved_fixture (content TEXT)')
            connection.execute('INSERT INTO saved_fixture VALUES (?)', ('已有会话数据',))
        preserved = {file: file.read_bytes() for file in (home / 'config.yaml', home / '.env', home / 'state.db', manuscript)}
        security = home / 'plugins' / 'jubao-drama' / 'security.py'
        security.write_text(security.read_text().replace(', "delegate_task"', ''), encoding='utf-8')
        (home / 'SOUL.md').write_text('旧版创作身份。', encoding='utf-8')
        PROFILES.sync_worker_capabilities(home)
        assert {file: file.read_bytes() for file in preserved} == preserved
        assert (home / 'SOUL.md').read_bytes() == (PROFILES._PLUGIN_SOURCE / 'SOUL.md').read_bytes()
        homes[home] = route
    parent_dispatch = run_agent.AIAgent._dispatch_delegate_task
    constructions = []

    class ChildConstructionReached(BaseException):
        """在真实子代理构造边界停止，绝不创建模型请求。"""

    def inspect_child(**kwargs):
        home, route = active
        assert is_delegated_child_context()
        assert get_hermes_home() == home
        assert get_secret('STUDIO_INFERENCE_TOKEN') == route['token']
        assert kwargs['api_key'] == route['token'] and kwargs['base_url'].rstrip('/') == route['base_url']
        assert kwargs['model'] == route['model'] and kwargs['requested_provider'] == 'studio-inference'
        assert Path(kwargs['session_db'].db_path) == home / 'state.db'
        definitions = get_tool_definitions(kwargs['enabled_toolsets'], kwargs['disabled_toolsets'], quiet_mode=True)
        child_tools = {row['function']['name'] for row in definitions}
        assert 'drama_material_import' in child_tools and 'drama_project_status' in child_tools
        assert not child_tools & {'delegate_task', 'clarify', 'terminal', 'read_file', 'execute_code', 'web_search'}
        loaded = get_plugin_manager()._plugins['jubao-drama'].module
        loaded.activate_agent('native-child', 'oa6-1')
        material = json.loads(handle_function_call('drama_material_import', {'path': str(home / 'attachments' / '原稿.txt')}, session_id='native-child'))
        assert material['material']['text'] == home.name
        other = next(candidate for candidate in homes if candidate != home)
        blocked = json.loads(handle_function_call('drama_material_import', {'path': str(other / 'attachments' / '原稿.txt')}, session_id='native-child'))
        assert 'error' in blocked
        blocked = json.loads(handle_function_call('terminal', {'command': 'never execute'}, session_id='native-child'))
        assert 'error' in blocked
        constructions.append(home)
        raise ChildConstructionReached

    monkeypatch.setattr(run_agent, 'AIAgent', inspect_child)
    before = is_multiplex_active()
    set_multiplex_active(True)
    try:
        ordered = list(homes)
        for home in (ordered[0], ordered[1], ordered[0]):
            active = home, homes[home]
            with scope(home):
                get_plugin_manager().discover_and_load()
                enabled, disabled = _load_enabled_toolsets('web'), _load_disabled_toolsets()
                parent_tools = {row['function']['name'] for row in get_tool_definitions(enabled, disabled, quiet_mode=True)}
                assert 'delegate_task' in parent_tools, '普通账号应能按需调用原生委派'
                assert _get_max_spawn_depth() == 1 and _get_max_concurrent_children() == 2
                runtime = resolve_runtime_provider(requested='studio-inference')
                database = SessionDB(db_path=home / 'state.db')
                try:
                    parent = SimpleNamespace(model=homes[home]['model'], provider=runtime['provider'], requested_provider='studio-inference',
                        api_key=runtime['api_key'], base_url=runtime['base_url'], api_mode=runtime['api_mode'], enabled_toolsets=enabled,
                        disabled_toolsets=disabled, _session_db=database, session_id=home.name + '-parent', _delegate_depth=0,
                        platform='web', _fallback_chain=[], request_overrides={})
                    with pytest.raises(ChildConstructionReached):
                        run_tool_execution_middleware('delegate_task', {'tasks': [{'goal': '独立审读第九集人物动机与因果关系', 'context': '只使用本账号资料，输出简体中文。'}]},
                            lambda args: parent_dispatch(parent, args), session_id=parent.session_id, turn_id='turn', tool_call_id='delegate')
                finally:
                    database.close()
    finally:
        set_multiplex_active(before)
    assert constructions == [ordered[0], ordered[1], ordered[0]]


def test_employee_native_delegation_refuses_routing_overrides_and_child_respawn(source_home):
    from agent.delegation_context import delegated_child_context
    from hermes_cli.middleware import run_tool_execution_middleware
    from hermes_cli.plugins import get_plugin_manager

    route = {'base_url': 'http://127.0.0.1:45600/v1', 'token': 'native-proxy-' + 'f' * 40,
             'model': 'native-model', 'models': ['native-model'], 'api_mode': 'chat_completions'}
    home = Path(PROFILES.provision('studio-' + 'f' * 20, route)['home'])
    dispatched = []
    safe = {'tasks': [{'goal': '校核第九集的人物关系'}]}
    with scope(home):
        get_plugin_manager().discover_and_load()
        def invoke(args):
            return json.loads(run_tool_execution_middleware('delegate_task', args,
                lambda value: dispatched.append(value) or '{"ok": true}', session_id='parent', turn_id='turn', tool_call_id='delegate'))
        assert invoke(safe)['ok'], '受限委派不应要求用户批准技术步骤'
        assert dispatched == [safe]
        for field in ('provider', 'model', 'base_url', 'api_key', 'api_mode', 'tools', 'toolsets', 'profile', 'agent_id',
                      'credentials_cfg', 'request_overrides', 'acp_command', 'acp_args', 'images', 'role', 'max_spawn_depth'):
            for args in ({**safe, field: 'external-override'}, {'tasks': [{**safe['tasks'][0], field: 'external-override'}]}):
                assert 'error' in invoke(args), field
                assert dispatched == [safe], '被拒绝的参数不能进入原生 dispatch'
        for args in ({'action': {}}, {'tasks': '[]'}, {'tasks': [None]}, {'tasks': [{'goal': 1}]}, {'tasks': safe['tasks'] * 3}):
            assert 'error' in invoke(args)
        with delegated_child_context('native-child'):
            assert 'error' in invoke(safe), '子上下文不能绕过深度限制再开子代理'
            confirmation = json.loads(run_tool_execution_middleware('drama_confirm', {'project_id': 'project', 'gate': 'core'},
                lambda value: dispatched.append(value) or '{"ok": true}', session_id='native-child', turn_id='turn', tool_call_id='confirm'))
            assert 'error' in confirmation, '正式剧本确认应回到主会话处理'
        assert dispatched == [safe]


def test_provisioned_profile_requires_one_named_agent_before_drama_tools(source_home):
    from hermes_cli.plugins import get_plugin_manager
    from model_tools import handle_function_call

    root, _ = source_home
    route = {
        'base_url': 'http://127.0.0.1:45610/v1', 'token': 'agent-proxy-' + 'g' * 40,
        'model': 'agent-model', 'models': ['agent-model'], 'api_mode': 'chat_completions',
    }
    home = Path(PROFILES.provision('studio-' + 'c' * 20, route)['home'])
    with scope(home):
        get_plugin_manager().discover_and_load()
        denied = json.loads(handle_function_call('drama_project_create', {'title': '未调用'}, session_id='unselected'))
        assert '先调用三个剧本 Agent 之一' in denied['error']
        from hermes_cli.lifecycle import invoke_hook
        from hermes_cli.middleware import apply_llm_request_middleware
        invoke_hook('pre_llm_call', session_id='unselected',
                    user_message='调用巨豹 Agent-适配 GM3.1 版本')
        apply_llm_request_middleware({'messages': [{'role': 'user', 'content': '调用巨豹 Agent-适配 GM3.1 版本'}]}, session_id='unselected')
        loaded = json.loads(handle_function_call('skill_view', {'name': '巨豹 Agent-适配 GM3.1 版本'}, session_id='unselected'))
        assert loaded.get('success'), loaded
        saved = json.loads(handle_function_call('drama_agent_document', {'action': 'save', 'name': '新稿', 'content': '第一集'}, session_id='unselected'))
        assert saved.get('ok'), saved
        denied = json.loads(handle_function_call('drama_project_create', {'title': '不能使用其他 Agent 阶段'}, session_id='unselected'))
        assert 'error' in denied


def test_compression_budget_and_fallback_use_current_account_credentials(source_home, tmp_path, monkeypatch):
    from hermes_cli.config import load_config_readonly
    from agent.auxiliary_client import get_text_auxiliary_client, _effective_aux_timeout
    from agent.secret_scope import set_multiplex_active, is_multiplex_active
    root,_=source_home
    models=['gpt-6-astra','gpt-6.1-sol']
    profiles=[]
    for index in range(2):
        name='studio-'+str(index)*20
        route={'base_url':f'http://127.0.0.1:{45100+index}/v1','token':('account-'+str(index)+'-')+'x'*32,'model':models[0],'models':models,'api_mode':'responses'}
        result=PROFILES.provision(name,route,workers_root=root/'studio-workers')
        profiles.append((Path(result['home']),route))
    previous=is_multiplex_active();set_multiplex_active(True)
    try:
        for home,route in (profiles[0],profiles[1],profiles[0]):
            monkeypatch.setenv('HERMES_HOME',str(home))
            with scope(home):
                cfg=load_config_readonly()['auxiliary']['compression']
                assert cfg.get('no_progress_timeout',0)>=180
                assert _effective_aux_timeout('compression',None)>=600
                client,model=get_text_auxiliary_client('compression')
                try:
                    assert model in route['models']
                    assert client.api_key==route['token']
                    assert str(client.base_url).rstrip('/')==route['base_url']
                finally:client.close()
                assert cfg['fallback_chain'][0]['model']!=cfg['model']
                assert cfg['fallback_chain'][0]['base_url']==route['base_url']
    finally:set_multiplex_active(previous)

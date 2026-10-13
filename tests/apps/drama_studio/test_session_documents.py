"""稿件目录使用真实插件与原生历史，重复读取幂等且严格遵循账号作用域。"""
from contextlib import closing
import importlib.util
from pathlib import Path
import shutil

from fastapi import FastAPI
from starlette.testclient import TestClient


ROOT = Path(__file__).resolve().parents[3]


def test_document_route_reconciles_real_history_without_crossing_profiles(tmp_path, monkeypatch):
    from agent.secret_scope import is_multiplex_active, set_multiplex_active
    from hermes_cli.plugins import _reset_plugin_managers_for_tests, get_plugin_manager
    from hermes_cli.web_routers.config_env import _config_profile_scope
    from hermes_state import SessionDB

    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'state'))
    bundled = tmp_path / 'bundled'; bundled.mkdir()
    monkeypatch.setenv('HERMES_BUNDLED_PLUGINS', str(bundled))
    spec = importlib.util.spec_from_file_location('studio_session_documents', ROOT / 'apps/drama-studio/server/session_documents.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    app = FastAPI(); app.include_router(module.router)
    client = TestClient(app)
    homes = {name: tmp_path / 'state/profiles' / name for name in ('a', 'b')}
    managers, bodies, message_ids = {}, {}, {}
    before = is_multiplex_active()
    _reset_plugin_managers_for_tests()
    try:
        for name, home in homes.items():
            shutil.copytree(ROOT / 'extensions/jubao-drama', home / 'plugins/jubao-drama',
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
            (home / 'workspace').mkdir()
            (home / 'config.yaml').write_text('plugins:\n  enabled: [jubao-drama]\nstudio_security:\n  restricted: true\n  require_agent_invocation: true\n')
            bodies[name] = f'第04集\n\n4-1场 办公室 日 内\n\n人物：林岚、顾淮\n\n△林岚拿出账号{name}的唯一证据，窗外骤然响起急促的雷声。\n\n林岚：这份记录已经足够证明真相，我们必须赶在天亮之前离开这里。'
            with _config_profile_scope(name):
                manager = get_plugin_manager(); manager.discover_and_load()
                managers[name] = manager
                assert manager._plugins['jubao-drama'].error is None
                manager._plugins['jubao-drama'].module.activate_agent('shared-session', 'gm3-1')
                with closing(SessionDB(home / 'state.db')) as database:
                    database.create_session('shared-session', source='cli')
                    database.append_message('shared-session', role='user', content='请生成第04集剧本正文。')
                    message_ids[name] = str(database.append_message('shared-session', role='assistant', content=bodies[name]))
                    database.create_session('only-' + name, source='cli')
        snapshots = {}
        for name in ('a', 'b', 'a'):
            response = client.post('/api/studio/session-documents?profile=' + name, json={'session_id': 'shared-session'})
            assert response.status_code == 200, response.text
            payload = response.json()
            assert payload['ok'] is True and len(payload['documents']) == 1
            document = payload['documents'][0]
            assert document['content'] == bodies[name]
            assert document['source_message_id'] == message_ids[name]
            receipt = payload['project']['exports'][0]
            assert receipt['artifact_id'] == document['id']
            assert Path(receipt['path']).is_relative_to(homes[name])
            assert Path(receipt['path']).read_bytes().startswith(b'PK')
            with _config_profile_scope(name):
                assert get_plugin_manager() is managers[name]
                text = managers[name]._plugins['jubao-drama'].module.read_material(receipt['path'])['text']
                assert f'账号{name}的唯一证据' in text
                assert f'账号{"b" if name == "a" else "a"}的唯一证据' not in text
            if name in snapshots:
                assert payload == snapshots[name]
            snapshots[name] = payload
        assert snapshots['a']['documents'][0]['id'] != snapshots['b']['documents'][0]['id']
        assert client.post('/api/studio/session-documents?profile=a', json={'session_id': 'only-b'}).status_code == 404
        for field in ('profile', 'path', 'content', 'agent_id'):
            assert client.post('/api/studio/session-documents?profile=a', json={'session_id': 'shared-session', field: 'forged'}).status_code == 422
    finally:
        _reset_plugin_managers_for_tests()
        set_multiplex_active(before)

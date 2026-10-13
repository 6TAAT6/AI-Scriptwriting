"""员工必须能从正式受控复制入口加载稿件分页模块并交付真实文件。"""
import importlib.util
from pathlib import Path
import sys

from tests.plugins.test_jubao_drama_agent_exports import profile_scope


ROOT = Path(__file__).resolve().parents[3]


def test_provisioned_worker_loads_document_tools_and_preserves_readable_export(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'source'))
    spec = importlib.util.spec_from_file_location('document_profile_provisioning', ROOT / 'apps/drama-studio/server/profiles.py')
    profiles = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(profiles)
    route = {'base_url': 'http://127.0.0.1:45001/v1', 'token': 'synthetic-proxy-' + 'x' * 40,
             'model': 'fixture', 'models': ['fixture'], 'api_mode': 'chat_completions'}
    home = Path(profiles.provision('studio-' + 'a' * 20, route, workers_root=tmp_path / 'workers')['home'])
    # 新建与后续同步都应按同一清单得到可加载的完整插件。
    profiles.sync_worker_capabilities(home)
    location = home / 'plugins/jubao-drama/__init__.py'
    plugin_spec = importlib.util.spec_from_file_location('provisioned_document_plugin', location, submodule_search_locations=[str(location.parent)])
    plugin = importlib.util.module_from_spec(plugin_spec)
    monkeypatch.setitem(sys.modules, plugin_spec.name, plugin)
    plugin_spec.loader.exec_module(plugin)
    with profile_scope(home):
        plugin.activate_agent('employee-session', 'gm3-1')
        content = '第1集\n' + '林岚：钥匙在这里。\n' * 120
        saved = plugin.document_action({'action': 'save', 'name': '第一批正文', 'content': content, 'kind': 'script'}, 'employee-session')
        identifier = saved['document']['id']
        assert 'content' not in saved['document']
        assert saved['receipt']['content_verified']
        assert '林岚：钥匙在这里。' in plugin.read_material(saved['receipt']['path'])['text']
        listed = plugin.document_action({'action': 'list', 'limit': 1}, 'employee-session')
        assert listed['documents'][0]['id'] == identifier
        first = plugin.document_action({'action': 'read', 'document_id': identifier, 'max_chars': 1000}, 'employee-session')
        second = plugin.document_action({'action': 'read', 'document_id': identifier, 'start_char': first['next_start_char'],
                                         'max_chars': 1000, 'content_sha256': first['content_sha256']}, 'employee-session')
        assert first['document']['content'] + second['document']['content'] == content
        assert not second['has_more']

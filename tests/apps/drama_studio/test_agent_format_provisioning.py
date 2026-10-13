"""新账号与再次启动的工作区都从当前模板取得三套共同排版规则。"""
import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_new_accounts_receive_loadable_format_rules_for_every_agent(tmp_path, monkeypatch):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools.skills_tool_plugin import _serve_plugin_skill

    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'state'))
    spec = importlib.util.spec_from_file_location('studio_format_profiles', ROOT / 'apps/drama-studio/server/profiles.py')
    profiles = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(profiles)
    route = {'base_url': 'http://127.0.0.1:45001/v1', 'token': 'proxy-fixture-' + 'x' * 40,
             'model': 'fixture', 'models': ['fixture'], 'api_mode': 'chat_completions'}
    homes = [Path(profiles.provision('studio-' + letter * 20, route)['home']) for letter in ('a', 'b')]
    rule = (ROOT / 'apps/drama-studio/shared/script-format.md').read_text()
    for home in (homes[0], homes[1], homes[0]):
        token = set_hermes_home_override(home)
        try:
            for agent in ('oa6-1', 'gm3-1', 'gr4-7'):
                name = 'jubao-agent-' + agent
                source = ROOT / 'extensions/jubao-drama/skills' / name / 'SKILL.md'
                installed = home / 'plugins/jubao-drama/skills' / name / 'SKILL.md'
                assert installed.read_bytes() == source.read_bytes()
                loaded = json.loads(_serve_plugin_skill(installed, 'jubao-drama', name, preprocess=False))
                assert loaded['success'], loaded.get('error')
                assert rule in loaded['content']
                assert loaded['name'] == 'jubao-drama:' + name
            # 再次启动时也同步当前模板，不能被旧账号目录里的副本覆盖。
            installed.write_text('旧排版副本')
            profiles.sync_worker_capabilities(home)
            assert installed.read_bytes() == source.read_bytes()
            catalog = json.loads((home / 'plugins/jubao-drama/capabilities.json').read_text())
            for capability in (row for row in catalog if row['kind'] == 'skill'):
                name = capability['skill']
                installed = home / 'plugins/jubao-drama/skills' / name / 'SKILL.md'
                loaded = json.loads(_serve_plugin_skill(installed, 'jubao-drama', name, preprocess=False))
                assert loaded['success'], loaded
                assert loaded['linked_files']['references']
                for reference in loaded['linked_files']['references']:
                    if reference.endswith('.md'):
                        result = json.loads(_serve_plugin_skill(installed, 'jubao-drama', name, file_path=reference, preprocess=False))
                        assert result['success'], result
        finally:
            reset_hermes_home_override(token)

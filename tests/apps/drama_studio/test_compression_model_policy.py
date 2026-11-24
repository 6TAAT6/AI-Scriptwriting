"""压缩模型替换必须跨配置重建生效，并保留账号范围与其他辅助任务。"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('astra_profile_test', os.environ.get('PROFILE_SOURCE', str(Path(__file__).resolve().parents[3] / 'apps/drama-studio/server/profiles.py')))
profiles = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profiles)

POLICY = {'version': 2, 'provider': 'studio-inference', 'operator_provider': 'studio-new-gpt',
          'model': 'gpt-6-astra', 'replace_model': 'gemini-3.8-flash-high'}
OLD_ID = 'studio-model-ca590f827302975e'


def config():
    providers = {
        'studio-inference': {'base_url': 'http://127.0.0.1:34001/v1', 'key_env': 'STUDIO_INFERENCE_TOKEN',
                             'transport': 'codex_responses', 'models': ['gpt-6-astra', 'gpt-6.1-sol']},
        OLD_ID: {'base_url': 'http://127.0.0.1:34001/scope/' + 'a' * 32 + '/v1',
                 'key_env': 'STUDIO_INFERENCE_TOKEN', 'transport': 'chat_completions',
                 'models': ['gemini-3.8-flash-high']}}
    result = {'providers': providers, 'model': {'provider': 'studio-inference', 'default': 'gpt-6-astra',
              'base_url': providers['studio-inference']['base_url'], 'api_mode': 'codex_responses'}}
    result['auxiliary'] = {'compression': profiles._summary_route(result)}
    result['auxiliary'].update(profiles._plugin_aux(result))
    return result


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / 'studio-workers/studio-00000000000000000000'
        self.home.mkdir(parents=True)
        self.policy_file = self.root / 'studio/compression-policy.json'
        self.policy_file.parent.mkdir()
        self.policy_file.write_text(json.dumps(POLICY))
        self.policy_file.chmod(0o600)

    def test_migration_uses_authorized_astra_with_current_scope(self):
        c = config()
        route = profiles._summary_route(c, preferred_provider=profiles._summary_policy(self.home))
        self.assertEqual(route['model'], 'gpt-6-astra')
        self.assertEqual(route['api_mode'], 'codex_responses')
        self.assertEqual(route['base_url'], c['providers']['studio-inference']['base_url'])
        self.assertEqual(route['fallback_chain'], [])
        self.assertFalse(route['allow_main_model_fallback'])

    def test_authorized_sol_is_same_provider_fallback_and_reaches_existing_workers(self):
        import hermes_yaml as yaml
        c = config()
        c['providers']['studio-inference']['models'] = ['gpt-6-astra', 'gpt-6.2-sol']
        route = profiles._summary_route(c, preferred_provider=profiles._summary_policy(self.home))
        primary = c['providers']['studio-inference']
        self.assertEqual(route['model'], 'gpt-6-astra')
        self.assertEqual(route['fallback_chain'], [{
            'provider': 'studio-inference', 'model': 'gpt-6.2-sol', 'base_url': primary['base_url'],
            'key_env': primary['key_env'], 'api_mode': primary['transport'],
            'timeout': 600, 'no_progress_timeout': 180, 'reasoning_effort': 'low'}])
        self.assertFalse(route['allow_main_model_fallback'])
        self.assertNotIn(OLD_ID, json.dumps(route))
        # 已有员工配置（备用链为空）在下次同步时补上备用，其他字段保持不变。
        c['auxiliary']['compression'] = {**route, 'fallback_chain': []}
        c.update(compression=dict(profiles._COMPRESSION), agent={'max_verify_nudges': profiles._MAX_VERIFY_NUDGES})
        (self.home / 'config.yaml').write_text(yaml.safe_dump(c))
        stage = self.home / 'stage'
        stage.mkdir()
        fd = os.open(self.home, os.O_RDONLY | os.O_DIRECTORY)
        try:
            profiles._sync_compression(self.home, fd, stage)
        finally:
            os.close(fd)
        after = yaml.safe_load((self.home / 'config.yaml').read_text())
        self.assertEqual(after['auxiliary']['compression']['fallback_chain'], route['fallback_chain'])

    def test_unrelated_sol_route_is_preserved(self):
        c = config()
        c['auxiliary']['compression'] = {'provider': 'studio-inference', 'model': 'gpt-6.1-sol'}
        c['providers'].pop(OLD_ID)
        self.assertIsNone(profiles._summary_route(c, preferred_provider=profiles._summary_policy(self.home)))

    def test_unauthorized_target_fails_without_gemini_fallback(self):
        c = config()
        c['providers']['studio-inference']['models'] = ['gpt-6.1-sol']
        policy = profiles._summary_policy(self.home)
        with self.assertRaises(ValueError):
            profiles._summary_route(c, preferred_provider=policy)

    def test_worker_refresh_keeps_astra_and_renews_scope(self):
        import hermes_yaml as yaml
        c = config()
        c['auxiliary']['compression'] = {'provider': 'studio-inference', 'model': 'gpt-6-astra',
                                          'allow_main_model_fallback': False}
        (self.home / 'config.yaml').write_text(yaml.safe_dump(c))
        inference = {'model': 'gpt-6-astra', 'models': ['gpt-6-astra', 'gpt-6.1-sol'],
                     'base_url': 'http://127.0.0.1:34002/v1', 'token': 'b' * 32,
                     'api_mode': 'codex_responses', 'providers': []}
        fresh = profiles._config(self.home, inference)
        route = fresh['auxiliary']['compression']
        self.assertEqual(route['model'], 'gpt-6-astra')
        self.assertEqual(route['base_url'], inference['base_url'])
        self.assertNotIn('api_key', route)

    def test_sync_only_changes_compression_route(self):
        import hermes_yaml as yaml
        c = config()
        c.update(compression=dict(profiles._COMPRESSION),
                 agent={'max_verify_nudges': profiles._MAX_VERIFY_NUDGES},
                 delegation={'max_concurrent_children': 4})
        before = copy.deepcopy(c)
        (self.home / 'config.yaml').write_text(yaml.safe_dump(c))
        staging = self.home / 'stage'
        staging.mkdir()
        fd = os.open(self.home, os.O_RDONLY | os.O_DIRECTORY)
        try:
            profiles._sync_compression(self.home, fd, staging)
            after = yaml.safe_load((self.home / 'config.yaml').read_text())
            self.assertEqual(after['auxiliary']['compression']['model'], 'gpt-6-astra')
            after['auxiliary']['compression'] = before['auxiliary']['compression']
            self.assertEqual(after, before)
            saved = (self.home / 'config.yaml').read_bytes()
            profiles._sync_compression(self.home, fd, staging)
            self.assertEqual((self.home / 'config.yaml').read_bytes(), saved)
        finally:
            os.close(fd)

    def test_operator_policy_uses_operator_provider(self):
        home = self.root / 'profiles/jubao-drama'
        home.mkdir(parents=True)
        c = config()
        c['providers']['studio-new-gpt'] = c['providers'].pop('studio-inference')
        route = profiles._summary_route(c, preferred_provider=profiles._summary_policy(home))
        self.assertEqual(route['provider'], 'studio-new-gpt')
        self.assertEqual(route['model'], 'gpt-6-astra')

    def test_legacy_policy_still_works(self):
        self.policy_file.write_text(json.dumps({'version': 1, 'provider': OLD_ID, 'model': 'gemini-3.8-flash-high'}))
        route = profiles._summary_route(config(), preferred_provider=profiles._summary_policy(self.home))
        self.assertEqual(route['provider'], OLD_ID)
        self.assertEqual(route['model'], 'gemini-3.8-flash-high')

    def test_legacy_employee_policy_does_not_change_operator(self):
        self.policy_file.write_text(json.dumps({'version': 1, 'provider': OLD_ID, 'model': 'gemini-3.8-flash-high'}))
        self.assertIsNone(profiles._summary_policy(self.root / 'profiles/jubao-drama'))

    def test_partial_migration_disables_implicit_fallback(self):
        import hermes_yaml as yaml
        c = config()
        c['auxiliary']['compression'] = profiles._summary_route(c, preferred_provider=profiles._summary_policy(self.home))
        c['auxiliary']['compression'].pop('allow_main_model_fallback')
        c.update(compression=dict(profiles._COMPRESSION), agent={'max_verify_nudges': profiles._MAX_VERIFY_NUDGES},
                 delegation={'max_concurrent_children': 4})
        (self.home / 'config.yaml').write_text(yaml.safe_dump(c))
        stage = self.home / 'stage'
        stage.mkdir()
        fd = os.open(self.home, os.O_RDONLY | os.O_DIRECTORY)
        try:
            profiles._sync_compression(self.home, fd, stage)
            after = yaml.safe_load((self.home / 'config.yaml').read_text())
            self.assertFalse(after['auxiliary']['compression']['allow_main_model_fallback'])
        finally:
            os.close(fd)

    def test_new_account_and_profile_isolation_a_b_a(self):
        inference = {'model': 'gpt-6-astra', 'models': ['gpt-6-astra', 'gpt-6.1-sol'],
                     'base_url': 'http://127.0.0.1:34002/v1', 'token': 'b' * 32,
                     'api_mode': 'codex_responses', 'providers': []}
        other = self.root / 'other/studio-workers/studio-11111111111111111111'
        other.mkdir(parents=True)
        for home, model in [(self.home, 'gpt-6-astra'), (other, 'gpt-6.1-sol'), (self.home, 'gpt-6-astra')]:
            fresh = profiles._config(home, inference)
            self.assertEqual(fresh['auxiliary']['compression']['model'], model)

    def test_unsafe_policy_permissions_rejected(self):
        self.policy_file.chmod(0o644)
        with self.assertRaises(ValueError):
            profiles._summary_policy(self.home)


if __name__ == '__main__':
    unittest.main()

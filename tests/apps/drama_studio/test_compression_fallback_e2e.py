"""压缩备用的端到端契约：策略模型调用失败时，真实的 Hermes 辅助调用改用同一接入上的 gpt-6.2-sol，且不退回会话模型。

背景（2026-11-23）：压缩策略 v2 原先备用链为空，摘要调用一失败整次压缩就失败；近一周正式 830 次压缩有 55 次摘要调用报错。"""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import threading

import pytest

spec = importlib.util.spec_from_file_location('fallback_profiles', os.environ.get(
    'PROFILE_SOURCE', str(Path(__file__).resolve().parents[3] / 'apps/drama-studio/server/profiles.py')))
profiles = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profiles)


@pytest.fixture
def upstream():
    seen = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            seen.append(body.get('model'))
            if body.get('model') == 'gpt-6.2-sol':
                data = json.dumps({'id': 'x', 'object': 'chat.completion', 'model': body['model'], 'choices': [
                    {'index': 0, 'message': {'role': 'assistant', 'content': '## 用户要求\\n备用摘要'}, 'finish_reason': 'stop'}],
                    'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}}).encode()
                self.send_response(200)
            else:
                data = json.dumps({'error': {'message': 'upstream overloaded', 'type': 'server_error'}}).encode()
                self.send_response(500)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f'http://127.0.0.1:{server.server_address[1]}/v1', seen
    server.shutdown()


def test_compression_falls_back_to_sol_on_the_policy_provider(tmp_path, monkeypatch, upstream):
    import hermes_yaml as yaml
    base, seen = upstream
    home = tmp_path / 'studio-workers' / ('studio-' + '0' * 20)
    home.mkdir(parents=True)
    policy = tmp_path / 'studio' / 'compression-policy.json'
    policy.parent.mkdir()
    policy.write_text(json.dumps({'version': 2, 'provider': 'studio-inference', 'operator_provider': 'studio-new-gpt',
                                  'model': 'gpt-6-astra', 'replace_model': 'gemini-3.8-flash-high'}))
    policy.chmod(0o600)
    config = {'model': {'provider': 'studio-inference', 'default': 'gemini-3.8-flash', 'base_url': base, 'api_mode': 'chat_completions'},
              'providers': {'studio-inference': {'base_url': base, 'key_env': 'STUDIO_INFERENCE_TOKEN', 'transport': 'chat_completions',
                                                 'models': ['gemini-3.8-flash', 'gpt-6-astra', 'gpt-6.2-sol'], 'discover_models': False}}}
    route = profiles._summary_route(config, preferred_provider=profiles._summary_policy(home))
    config['auxiliary'] = {'compression': route}
    (home / 'config.yaml').write_text(yaml.safe_dump(config))
    monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.setenv('STUDIO_INFERENCE_TOKEN', 'fixture-token')
    from hermes_constants import set_hermes_home_override
    set_hermes_home_override(home)
    from agent.auxiliary_client import call_llm
    response = call_llm(task='compression', messages=[{'role': 'user', 'content': '把对话压缩成交接摘要'}],
                        main_runtime={'model': 'gemini-3.8-flash', 'provider': 'studio-inference', 'base_url': base,
                                      'api_key': 'fixture-token', 'api_mode': 'chat_completions'})
    assert '备用摘要' in response.choices[0].message.content
    assert seen[0] == 'gpt-6-astra' and seen[-1] == 'gpt-6.2-sol'
    assert 'gemini-3.8-flash' not in seen, '压缩不得退回会话模型'

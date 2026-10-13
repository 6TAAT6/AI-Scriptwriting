"""原生子代理的 128K 范围内恢复预算可以原样通过代理，服务异常沿原生流程重试。"""
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def test_native_child_recovery_budget_is_forwarded_without_rejecting_request(tmp_path, monkeypatch):
    from hermes_cli.config import atomic_config_replace
    from hermes_constants import get_hermes_home
    from run_agent import AIAgent

    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    requests = []
    canary = 'PRIVATE_PROVIDER_DIAGNOSTIC'

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(b'{"data":[]}')

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if not self.path.endswith('/chat/completions'):
                self.send_response(404); self.end_headers(); return
            requests.append(body)
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            if len(requests) == 1:
                packet = {'error': {'code': 503, 'type': 'server_error', 'message': canary}}
            else:
                packet = {'id': 'fixture', 'model': body['model'], 'choices': [{'index': 0, 'delta': {'content': '验收完成'}, 'finish_reason': 'stop'}]}
            self.wfile.write(('data: ' + json.dumps(packet) + '\n\ndata: [DONE]\n\n').encode())

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    root = Path(__file__).resolve().parents[3]
    broker = subprocess.Popen(['node', str(root / 'apps/drama-studio/server/tests/native-broker-fixture.mjs'),
        f'http://127.0.0.1:{server.server_port}/v1'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    agent = None
    try:
        scope = json.loads(broker.stdout.readline())
        atomic_config_replace(get_hermes_home() / 'config.yaml', {
            'agent': {'environment_probe': False, 'coding_context': 'off'},
            'memory': {'memory_enabled': False, 'user_profile_enabled': False},
            'skills': {'project_discovery': False, 'auto_load': []},
            'auxiliary': {'background_review': {'enabled': False}},
        })
        agent = AIAgent(model='gemini-3.8-flash-high', provider='custom', requested_provider='custom',
            api_mode='chat_completions', base_url=scope['base_url'], api_key=scope['token'],
            enabled_toolsets=['no_mcp'], disabled_toolsets=['all'], max_iterations=3,
            quiet_mode=True, skip_memory=True, skip_context_files=True, skip_background_review=True,
            request_overrides={'max_tokens': 131070},
            reasoning_config={'enabled': True, 'effort': 'high'}, platform='subagent')
        result = agent.run_conversation('只回复验收完成，不调用任何工具。')
        assert len(requests) == 2, '服务异常应进入原生重试，不能被改写成不可重试的 400'
        assert all(body['max_tokens'] == 131070 for body in requests)
        assert result.get('completed') is True
        assert '验收完成' in result.get('final_response', '')
        assert canary not in json.dumps(result)
    finally:
        if agent is not None:
            agent.close()
        broker.terminate(); broker.communicate(timeout=10)
        server.shutdown(); server.server_close(); thread.join(timeout=3)

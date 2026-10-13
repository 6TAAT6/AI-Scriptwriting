"""恢复中的旧模型初始化不能覆盖用户刚确认的新模型。"""
from types import SimpleNamespace
import threading

import pytest
from tui_gateway import server


@pytest.mark.parametrize('pending', [
    {'resume_runtime_overrides': {'model_override': {'model': 'old-model', 'provider': 'old-provider'}}},
    {'agent_build_started': True},
])
def test_explicit_model_switch_waits_for_existing_build(monkeypatch, pending):
    session = {'agent': None, 'agent_ready': threading.Event(), 'running': False, 'session_key': 'cold-switch', **pending}
    agent = SimpleNamespace(model='old-model')
    def build(_sid, current):
        current['agent'] = agent
        current['agent_ready'].set()
    def apply(_sid, current, *_args, **_kwargs):
        if current['agent'] is not None:
            current['agent'].model = 'new-model'
        else:
            current['model_override'] = {'model': 'new-model'}
        return {'value': 'new-model', 'warning': '', 'scope': 'session'}
    monkeypatch.setattr(server, '_start_agent_build', build)
    monkeypatch.setattr(server, '_apply_model_switch', apply)
    monkeypatch.setitem(server._sessions, 'cold-switch', session)
    response = server.handle_request({'id': 'change', 'method': 'config.set', 'params': {
        'session_id': 'cold-switch', 'key': 'model', 'value': 'new-model --provider new-provider --session'
    }})
    assert 'error' not in response
    if session['agent'] is None:
        build('cold-switch', session)
    assert session['agent'].model == 'new-model'

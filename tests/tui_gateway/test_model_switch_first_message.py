"""真实数据库覆盖首次输入之前切换模型，账号按 A→B→A 顺序隔离。"""
from types import SimpleNamespace
from threading import RLock
from hermes_state import SessionDB
from tui_gateway import server


def test_model_switch_with_ready_agent_persists_before_first_prompt(tmp_path):
    homes = {name: tmp_path / name for name in ('a', 'b')}
    databases = {}
    sessions = {}
    for name, home in homes.items():
        home.mkdir()
        database = databases[name] = SessionDB(home / 'state.db')
        sessions[name] = {'session_key': f'new-{name}', 'profile_home': str(home),
                          'source': 'web', 'history': [], 'history_lock': RLock(),
                          'agent': SimpleNamespace(_session_db=database, session_id=f'new-{name}')}
    try:
        for index, name in enumerate(('a', 'b', 'a')):
            server._append_model_switch_marker(sessions[name], model=f'model-{index}', provider='custom')
            rows = databases[name].get_messages_as_conversation(f'new-{name}')
            assert len(rows) == 1
            assert f'model-{index}' in rows[0]['content']
            other = 'b' if name == 'a' else 'a'
            assert databases[other].get_session(f'new-{name}') is None
    finally:
        for database in databases.values():
            database.close()

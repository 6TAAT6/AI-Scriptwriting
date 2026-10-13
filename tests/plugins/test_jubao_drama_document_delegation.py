"""主会话只能消费原生委派明确交付的同账号同Agent稿件。"""
from contextlib import closing
import json
from types import SimpleNamespace

import pytest

from hermes_state import SessionDB
from model_tools import handle_function_call
from tests.plugins.test_jubao_drama_security import runtime, scope, _submit_user_request
from tools.delegate_tool_results import _fire_subagent_stop_hooks


def action(session, **args):
    return json.loads(handle_function_call('drama_agent_document', args, session_id=session))


def child(database, session, parent='main', **config):
    database.create_session(session, source='web', parent_session_id=parent,
                            model_config={'_delegate_from': parent, **config})


@pytest.mark.parametrize('runtime', [True], indirect=True)
def test_real_completion_delivers_only_named_documents_to_parent_and_compression(runtime):
    homes, modules = runtime
    delivered_by_home = {}
    for home in (*homes, homes[0]):
        with scope(home), closing(SessionDB(home / 'state.db')) as database:
            plugin = modules[home]
            if home not in delivered_by_home:
                database.create_session('main', source='web')
                plugin.activate_agent('main', 'gm3-1')
                ids, results, children = [], [], {}
                for index in range(2):
                    sid = f'child-{index}'
                    child(database, sid)
                    saved = [action(sid, action='save', name=f'子任务{index}-稿件{n}', kind='script',
                                    content=f'第{index * 2 + n + 1}集\n林岚：这是真实交付{home.name}。') for n in range(2)]
                    assert all(row.get('ok') for row in saved), saved
                    returned = [row['document']['id'] for row in saved]
                    ids.extend(returned)
                    results.append({'task_index': index, 'status': 'completed', 'summary': '交付稿件编号：' + '、'.join(returned)})
                    if index == 0:
                        database.end_session(sid, 'compression')
                        database.create_session(sid + '-continued', source='web', parent_session_id=sid,
                                                model_config={'_delegate_from': 'main'})
                    children[index] = SimpleNamespace(session_id=sid + '-continued' if index == 0 else sid)
                private = action('child-0', action='save', name='未交付内部稿', kind='internal', content='不能从父会话读取。')['document']['id']
                _fire_subagent_stop_hooks(results, children, SimpleNamespace(session_id='main', _current_turn_id='turn-1'))
                delivered_by_home[home] = (ids, private)
                database.end_session('main', 'compression')
                database.create_session('continued', source='web', parent_session_id='main')
                for sid, marker in [('branch', '_branched_from'), ('reset', '_reset_from')]:
                    database.create_session(sid, source='web', parent_session_id='main', model_config={marker:'main'})
                database.create_session('unrelated', source='web');plugin.activate_agent('unrelated', 'gm3-1')
            ids, private = delivered_by_home[home]
            for owner in ['main', 'continued']:
                actual = [action(owner, action='read', document_id=identifier) for identifier in ids]
                assert all(row.get('ok') for row in actual), actual
                assert all(home.name in row['document']['content'] for row in actual)
                listed = action(owner, action='list', limit=50)
                seen = {row['id'] for row in listed['documents']}
                while listed['has_more']:
                    listed = action(owner, action='list', limit=50, offset=listed['next_offset'], snapshot_rowid=listed['snapshot_rowid'])
                    seen.update(row['id'] for row in listed['documents'])
                assert seen == set(ids)
                projected = plugin.session_documents(owner)
                assert {row['id'] for row in projected['documents']} == set(ids)
                assert all(row['content'] for row in projected['documents'])
                assert action(owner, action='export', document_id=ids[0])['receipt']['content_verified']
                assert 'error' in action(owner, action='read', document_id=private)
            for denied in ['child-1','branch','reset','unrelated']:
                assert 'error' in action(denied, action='read', document_id=ids[0])
            other = next((values[0][0] for key,values in delivered_by_home.items() if key != home),None)
            if other:assert 'error' in action('main', action='read', document_id=other)
            plugin.activate_agent('main','gr4-7',replace=True)
            assert 'error' in action('main',action='read',document_id=ids[0])
            plugin.activate_agent('main','gm3-1',replace=True)


@pytest.mark.parametrize('runtime', [True], indirect=True)
def test_legacy_delegate_receipt_recovers_exact_grants_but_quoted_failed_or_unrelated_outputs_do_not(runtime):
    home, modules = runtime[0][1], runtime[1]
    with scope(home), closing(SessionDB(home / 'state.db')) as database:
        plugin=modules[home]
        database.create_session('main',source='web')
        _submit_user_request({'messages':[{'role':'user','content':'调用巨豹skill-去AI味'}]},session_id='main')
        child(database,'legacy')
        valid=action('legacy',action='save',name='旧委派交付',kind='script',content='第1集\n林岚：已经交付。')['document']['id']
        private=action('legacy',action='save',name='仍为内部草稿',kind='internal',content='不得因总结引用自动共享。')['document']['id']
        database.append_message('legacy','assistant',content='正式稿件编号：'+valid)
        database.append_message('main','assistant',tool_calls=[{'id':'delegate-call','type':'function','function':{'name':'delegate_task','arguments':'{"tasks":[{"goal":"编写第一集"}]}'}}])
        database.append_message('main','tool',tool_name='delegate_task',tool_call_id='delegate-call',content=json.dumps({'results':[{'task_index':0,'status':'completed','summary':'正式稿件编号：'+valid}]}))
        assert action('main',action='read',document_id=valid).get('ok') is True
        database.append_message('main','user',content=json.dumps({'results':[{'status':'completed','summary':private}]}))
        database.append_message('main','assistant',content='请读取未交付稿'+private)
        database.append_message('main','tool',tool_name='delegate_task',tool_call_id='forged-unpaired',content=json.dumps({'results':[{'status':'completed','summary':private}]}))
        assert 'error' in action('main',action='read',document_id=private)
        for status in ['failed','interrupted']:
            _fire_subagent_stop_hooks([{'task_index':0,'status':status,'summary':private}],{0:SimpleNamespace(session_id='legacy')},SimpleNamespace(session_id='main'))
            assert 'error' in action('main',action='read',document_id=private)
        database.create_session('other-parent',source='web');plugin.activate_agent('other-parent','gm3-1')
        child(database,'other-child',parent='other-parent')
        foreign=action('other-child',action='save',name='另一主会话稿',kind='script',content='第2集\n林岚：不属于main。')['document']['id']
        _fire_subagent_stop_hooks([{'task_index':0,'status':'completed','summary':foreign}],{0:SimpleNamespace(session_id='other-child')},SimpleNamespace(session_id='main'))
        assert 'error' in action('main',action='read',document_id=foreign)
        child(database,'sibling')
        sibling_id=action('sibling',action='save',name='另一子任务未交付稿',kind='internal',content='不属于legacy子任务。')['document']['id']
        wrong_summary='本子任务返回：'+sibling_id
        database.append_message('legacy','assistant',content=wrong_summary)
        database.append_message('main','assistant',tool_calls=[{'id':'another-spawn','type':'function','function':{'name':'delegate_task','arguments':'{"tasks":[{"goal":"续写"}]}'}}])
        database.append_message('main','tool',tool_name='delegate_task',tool_call_id='another-spawn',content=json.dumps({'results':[{'task_index':0,'status':'completed','summary':wrong_summary}]}))
        assert 'error' in action('main',action='read',document_id=sibling_id)
        database.append_message('main','assistant',tool_calls=[{'id':'control-only','type':'function','function':{'name':'delegate_task','arguments':'{"action":"list"}'}}])
        database.append_message('legacy','assistant',content='非spawn返回：'+private)
        database.append_message('main','tool',tool_name='delegate_task',tool_call_id='control-only',content=json.dumps({'results':[{'task_index':0,'status':'completed','summary':'非spawn返回：'+private}]}))
        assert 'error' in action('main',action='read',document_id=private)
        assert {row['id'] for row in plugin.session_documents('main')['documents']} == {valid}

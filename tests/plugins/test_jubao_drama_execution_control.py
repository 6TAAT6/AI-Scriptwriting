"""只读复合请求必须依本轮真实工具证据收口，不能扩权或改写缓存前缀。"""
from contextlib import closing
from copy import deepcopy
import importlib
import json

from hermes_state import SessionDB
from tests.plugins.test_jubao_drama_selection_entry import runtime, profile_scope, studio_prompt


def _request():
    return {'model': 'fixture', 'messages': [{'role': 'system', 'content': 'You are Hermes Agent.'},
            {'role': 'user', 'content': '保持输入原字节。'}],
            'tools': [{'type': 'function', 'function': {'name': 'drama_agent_document',
                       'parameters': {'type': 'object', 'properties': {'action': {'type': 'string'}}}}}],
            'tool_choice': 'auto'}


def test_real_document_results_drive_only_current_turn_and_preserve_security_prefix(runtime):
    from hermes_cli.lifecycle import invoke_hook
    from hermes_cli.middleware import apply_llm_request_middleware
    from model_tools import handle_function_call, suppress_post_tool_call_hook

    homes, modules = runtime
    home = homes[0]
    with profile_scope(home), closing(SessionDB(home / 'state.db')) as database:
        database.create_session('reader', source='web')
        plugin = modules[home]
        plugin.activate_agent('reader', 'gm3-1')
        body = '第1集\n' + '林岚：证据一直在。\n' * 1800 + '△全剧终。'
        saved = plugin.document_action({'action': 'save', 'kind': 'script', 'name': '目标剧完整正文', 'content': body}, 'reader')
        identifier = saved['document']['id']
        plugin.document_action({'action': 'save', 'kind': 'outline', 'name': '另一份大纲', 'content': '第1集\n初见证据。'}, 'reader')
        request_text = studio_prompt(body=f'请现在重新查看本会话已保存稿件完整目录，从第一页到最后一页，并列最早三份名称和保存时间。再从头到尾读取稿件编号 {identifier} 的完整正文，核对最后一句对白、最后一行非空文字和正文合计、含标题全文汉字数。这一轮只做读取核查，不重写、不保存新稿、不导出。')
        invoke_hook('pre_llm_call', session_id='reader', turn_id='turn-read', user_message=request_text)
        source = _request()
        security = importlib.import_module(plugin.__name__ + '.security')
        expected = security.llm_request(source)['request']
        before = deepcopy(source)
        forced = apply_llm_request_middleware(source, session_id='reader', turn_id='turn-read', api_request_id='api-0', api_mode='chat_completions').payload
        assert forced['tool_choice'] == {'type': 'function', 'function': {'name': 'drama_agent_document'}}
        assert source == before
        assert {key: value for key, value in forced.items() if key != 'tool_choice'} == {key: value for key, value in expected.items() if key != 'tool_choice'}
        calls = []
        def execute(args):
            call_id = f'call-{len(calls)}'
            calls.append(deepcopy(args))
            # 原生executor内registry先transform，executor随后post；两次入口不得重复计数。
            with suppress_post_tool_call_hook():
                value = handle_function_call('drama_agent_document', args, session_id='reader', turn_id='turn-read', tool_call_id=call_id, enabled_tools=['drama_agent_document'])
            invoke_hook('post_tool_call', tool_name='drama_agent_document', args=args, result=value, status='ok', session_id='reader', turn_id='turn-read', tool_call_id=call_id)
            return json.loads(value)
        page = execute({'action': 'list', 'limit': 1})
        while page['has_more']:
            page = execute(page['next_call'])
        assert len(json.dumps(page['execution_evidence'], ensure_ascii=False)) <= 2000
        assert page['execution_evidence']['next_call']['action'] == 'read'
        assert page['execution_evidence']['next_call']['document_id'] == identifier
        interim = invoke_hook('transform_llm_output', response_text='全部已完成并且WPS验收通过。', session_id='reader', turn_id='turn-read')
        assert any('未完成' in row and 'WPS验收通过' not in row for row in interim if isinstance(row, str))
        # 同一真实轮次经原生压缩续接仍需读取正文；任意parent不能借用账本。
        database.end_session('reader', 'compression')
        database.create_session('continued', source='web', parent_session_id='reader')
        for branch, marker, source_kind in [('branch', '_branched_from', 'web'), ('reset', '_reset_from', 'web'), ('child', '_delegate_from', 'tool')]:
            database.create_session(branch, source=source_kind, parent_session_id='reader', model_config={marker: 'reader'})
            plugin.activate_agent(branch, 'gm3-1')
            rejected = apply_llm_request_middleware(source, session_id=branch, turn_id='turn-read', api_request_id=branch, api_mode='chat_completions').payload
            assert rejected == expected
            assert not invoke_hook('transform_llm_output', response_text='分支原回复。', session_id=branch, turn_id='turn-read')
        migrated = apply_llm_request_middleware(source, session_id='continued', turn_id='turn-read', api_request_id='continued-api', api_mode='chat_completions').payload
        assert migrated['tool_choice'] == {'type': 'function', 'function': {'name': 'drama_agent_document'}}
        incomplete = invoke_hook('transform_llm_output', response_text='目录与正文全部完成。', session_id='continued', turn_id='turn-read')
        assert any('未完成' in row for row in incomplete if isinstance(row, str))
        # 后续实际工具均在新会话执行，目标仍由原稿权限校验，不另建稿件。
        current_session = 'continued'
        while page['execution_evidence']['next_call']:
            args = page['execution_evidence']['next_call']
            page = json.loads(handle_function_call('drama_agent_document', args, session_id=current_session, turn_id='turn-read', tool_call_id=f'continued-{len(calls)}', enabled_tools=['drama_agent_document']))
            calls.append(args)
        released = apply_llm_request_middleware(source, session_id=current_session, turn_id='turn-read', api_request_id='api-final', api_mode='chat_completions').payload
        assert released == expected
        final = next(row for row in invoke_hook('transform_llm_output', response_text='已完成，保存时间昨天。', session_id=current_session, turn_id='turn-read') if isinstance(row, str))
        assert '△全剧终。' in final and '林岚：证据一直在。' in final
        assert '保存时间' in final and ('未记录' in final or '无法确认' in final)
        assert '昨天' not in final and 'sha256' not in final
        suggestions = json.loads(final.split('```studio-suggestions\n', 1)[1].split('\n```', 1)[0])
        assert len(suggestions) == 1 and suggestions[0]['label'] == '解释刚才的统计口径'
        assert '保存' not in suggestions[0]['prompt'] and '创作' not in suggestions[0]['prompt']
        assert plugin.document_action({'action': 'list'}, 'reader')['total'] == 2
        # 压缩前已验证来源的晚到失败仍能否决其目录证据，不反向迁移到旧会话。
        invoke_hook('post_tool_call', tool_name='drama_agent_document', args={'action': 'list'}, result='{}', status='error', session_id='reader', turn_id='turn-read', tool_call_id='call-0')
        late = next(row for row in invoke_hook('transform_llm_output', response_text='所有已完成。', session_id=current_session, turn_id='turn-read') if isinstance(row, str))
        assert '未完成' in late and '已完整查询本轮稿件目录' not in late
        # 关闭发生在新会话第一次工具/请求前，也必须清掉仍挂在祖先的同轮状态。
        invoke_hook('pre_llm_call', session_id='continued', turn_id='close-before-migration', user_message=request_text)
        database.end_session('continued', 'compression')
        database.create_session('continued-again', source='web', parent_session_id='continued')
        invoke_hook('on_session_end', session_id='continued-again', turn_id='close-before-migration', completed=False, interrupted=True)
        assert not invoke_hook('transform_llm_output', response_text='关闭后正文。', session_id='continued-again', turn_id='close-before-migration')


def test_readonly_force_is_bounded_profile_scoped_and_cannot_create_documents(runtime, monkeypatch):
    from hermes_cli.lifecycle import invoke_hook
    from hermes_cli.middleware import apply_llm_request_middleware
    from model_tools import handle_function_call

    homes, modules = runtime
    for home in (homes[0], homes[1], homes[0]):
        with profile_scope(home):
            plugin = modules[home]
            plugin.activate_agent('same-session', 'gm3-1')
            assert apply_llm_request_middleware(_request(), session_id='same-session', turn_id='same-turn', api_request_id='before-start', api_mode='chat_completions').payload['tool_choice'] == 'auto'
            prompt = studio_prompt(body='请重新查询本对话完整稿件目录，从第一页读到最后一页。本轮只读核查，不保存、不导出。')
            invoke_hook('pre_llm_call', session_id='same-session', turn_id='same-turn', user_message=prompt)
            request = _request()
            forced = apply_llm_request_middleware(request, session_id='same-session', turn_id='same-turn', api_request_id='api-0', api_mode='chat_completions').payload
            assert forced['tool_choice'] != 'auto'
            blocked = json.loads(handle_function_call('drama_agent_document', {'action': 'save', 'name': '不得新增', 'kind': 'script', 'content': '第1集\n证据。'}, session_id='same-session', turn_id='same-turn', tool_call_id='write-attempt', enabled_tools=['drama_agent_document']))
            assert blocked.get('error') or blocked.get('ok') is False
            assert plugin.document_action({'action': 'list'}, 'same-session')['total'] == 0
            terminal = apply_llm_request_middleware(request, session_id='same-session', turn_id='same-turn', api_request_id='api-1', api_mode='chat_completions').payload
            assert terminal.get('tool_choice') == 'auto'
            other = apply_llm_request_middleware(request, session_id='same-session', turn_id='unrelated-turn', api_request_id='api-other', api_mode='chat_completions').payload
            assert other.get('tool_choice') == 'auto'
            invoke_hook('pre_llm_call', session_id='same-session', turn_id='creative-turn', user_message=studio_prompt(body='继续下一批剧本创作，并保存完整正文。'))
            normal = apply_llm_request_middleware(request, session_id='same-session', turn_id='creative-turn', api_request_id='creative-api', api_mode='chat_completions').payload
            security = importlib.import_module(plugin.__name__ + '.security')
            assert normal == security.llm_request(request)['request']
            assert not invoke_hook('transform_llm_output', response_text='正常创作内容。', session_id='same-session', turn_id='creative-turn')
            # 缺乏工具进展时有限要求真实调用；重复同一次API重试不重复消耗额度。
            invoke_hook('pre_llm_call', session_id='same-session', turn_id='stalled-turn', user_message=prompt)
            for index in range(4):
                current = apply_llm_request_middleware(request, session_id='same-session', turn_id='stalled-turn', api_request_id=f'stall-{index}', api_mode='chat_completions').payload
                repeated = apply_llm_request_middleware(request, session_id='same-session', turn_id='stalled-turn', api_request_id=f'stall-{index}', api_mode='chat_completions').payload
                assert repeated == current
                assert (current['tool_choice'] == 'auto') is (index == 3)
            incomplete = invoke_hook('transform_llm_output', response_text='所有动作都已完成。', session_id='same-session', turn_id='stalled-turn')
            assert any('未完成' in text for text in incomplete if isinstance(text, str))
            # 真实空目录先transform，随后原生取消事件否决该调用，不能保留完成声明。
            invoke_hook('pre_llm_call', session_id='same-session', turn_id='late-cancel', user_message=prompt)
            payload = plugin.document_action({'action': 'list'}, 'same-session')
            invoke_hook('transform_tool_result', tool_name='drama_agent_document', args={'action': 'list'}, result=json.dumps(payload), status='ok', session_id='same-session', turn_id='late-cancel', tool_call_id='late')
            invoke_hook('post_tool_call', tool_name='drama_agent_document', args={'action': 'list'}, result=json.dumps(payload), status='cancelled', session_id='same-session', turn_id='late-cancel', tool_call_id='late')
            late = next(text for text in invoke_hook('transform_llm_output', response_text='完整目录已读完。', session_id='same-session', turn_id='late-cancel') if isinstance(text, str))
            assert '未完成' in late and '已完整查询' not in late
            invoke_hook('pre_llm_call', session_id='same-session', turn_id='analysis', user_message=studio_prompt(body='请完整读完剧本并分析剧情，给出修改建议；本轮只读、不保存。'))
            assert not invoke_hook('transform_llm_output', response_text='人物动机需要补足。', session_id='same-session', turn_id='analysis')

            for mode, choice, tools in [('codex_responses', {'type': 'function', 'name': 'drama_agent_document'}, [{'type': 'function', 'name': 'drama_agent_document', 'parameters': {}}]),
                                         ('anthropic_messages', {'type': 'tool', 'name': 'drama_agent_document'}, [{'name': 'drama_agent_document', 'input_schema': {}}])]:
                invoke_hook('pre_llm_call', session_id='same-session', turn_id=mode, user_message=prompt)
                wire = {**request, 'tools': tools}
                forced_wire = apply_llm_request_middleware(wire, session_id='same-session', turn_id=mode, api_request_id=mode, api_mode=mode).payload
                assert forced_wire['tool_choice'] == choice and forced_wire['tools'] == tools

            invoke_hook('pre_llm_call', session_id='same-session', turn_id='unsupported', user_message=prompt)
            assert apply_llm_request_middleware(request, session_id='same-session', turn_id='unsupported', api_request_id='unknown', api_mode='unknown').payload['tool_choice'] == 'auto'
            unknown = next(text for text in invoke_hook('transform_llm_output', response_text='全部已完成。', session_id='same-session', turn_id='unsupported') if isinstance(text, str))
            assert '未完成' in unknown and '接口' in unknown
            invoke_hook('pre_llm_call', session_id='same-session', turn_id='thinking', user_message=prompt)
            native = {**request, 'tools': [{'name': 'drama_agent_document', 'input_schema': {}}], 'thinking': {'type': 'adaptive'}, 'tool_choice': {'type': 'auto'}}
            unchanged = apply_llm_request_middleware(native, session_id='same-session', turn_id='thinking', api_request_id='thinking', api_mode='anthropic_messages').payload
            assert unchanged == security.llm_request(native)['request']

    # 旧prehook延迟返回不能覆盖后来的当前轮次。
    from threading import Event, Thread
    with profile_scope(homes[0]):
        plugin = modules[homes[0]]
        control = importlib.import_module(plugin.__name__ + '.document_execution_control')
        original_begin = control.begin_turn
        started, release = Event(), Event()
        def delayed_begin(text, session):
            if '旧入口标志' in text:
                started.set()
                assert release.wait(5)
            return original_begin(text, session)
        monkeypatch.setattr(control, 'begin_turn', delayed_begin)
        def old_start():
            with profile_scope(homes[0]):
                control.pre_llm_call(session_id='same-session', turn_id='old-pending', user_message=prompt + '旧入口标志')
        worker = Thread(target=old_start)
        worker.start()
        try:
            assert started.wait(5)
            control.pre_llm_call(session_id='same-session', turn_id='new-current', user_message=prompt)
        finally:
            release.set()
            worker.join(5)
        assert not worker.is_alive()
        assert control.llm_request(_request(), session_id='same-session', turn_id='old-pending', api_mode='chat_completions') is None
        assert control.llm_request(_request(), session_id='same-session', turn_id='new-current', api_mode='chat_completions')
        control.on_session_end(session_id='same-session', turn_id='old-pending')
        assert control.llm_request(_request(), session_id='same-session', turn_id='new-current', api_mode='chat_completions')
        started.clear(); release.clear()
        worker = Thread(target=old_start)
        worker.start()
        try:
            assert started.wait(5)
            # 原生会话关闭可不带turn_id，必须同时使仍在建立的计划失效。
            control.on_session_end(session_id='same-session', interrupted=True)
        finally:
            release.set()
            worker.join(5)
        assert not worker.is_alive()
        assert control.llm_request(_request(), session_id='same-session', turn_id='old-pending', api_mode='chat_completions') is None

    # 其他会话启动不能把仍等待进展的本轮证据状态清掉。
    with profile_scope(homes[0]):
        plugin = modules[homes[0]]
        control = importlib.import_module(plugin.__name__ + '.document_execution_control')
        invoke_hook('pre_llm_call', session_id='same-session', turn_id='waiting', user_message=prompt)
        plugin.activate_agent('another-session', 'gm3-1')
        invoke_hook('pre_llm_call', session_id='another-session', turn_id='new', user_message=prompt)
        waiting = next(text for text in invoke_hook('transform_llm_output', response_text='已完成全部。', session_id='same-session', turn_id='waiting') if isinstance(text, str))
        assert '未完成' in waiting and '本轮完整稿件目录查询' in waiting
        assert control.llm_request(_request(), session_id='same-session', turn_id='waiting', api_request_id='still-waiting', api_mode='chat_completions')

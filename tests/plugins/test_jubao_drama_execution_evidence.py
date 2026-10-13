"""真实同账号稿件解析及本轮覆盖，不以模型已读声明替代工具证据。"""
from contextlib import closing
import importlib

from hermes_state import SessionDB
from tests.plugins.test_jubao_drama_agent_exports import plugin, profile_scope


def test_current_turn_covers_directory_and_exact_manuscript_without_using_other_reads(plugin, tmp_path):
    with profile_scope(tmp_path), closing(SessionDB(tmp_path / 'state.db')) as database:
        database.create_session('author', source='web'); plugin.activate_agent('author', 'gm3-1')
        source = '\n'.join(f'第{episode}集\n{episode}-1场 剧院 日 内\n' + '甲说这份证据需要完整保留。' * 130 for episode in range(1, 11))
        target = plugin.document_action({'action':'save','name':'第01—10集完整合并稿','kind':'script','content':source}, 'author')
        other = plugin.document_action({'action':'save','name':'较早方案','kind':'document','content':'这是较早方案。'}, 'author')
        plugin.document_action({'action':'save','name':'第01—10集完整正文核查结果','kind':'script','content':'目录已读，正文无需再读。'}, 'author')
        evidence = importlib.import_module(plugin.__name__ + '.document_execution_evidence')
        request = '请现在重新查看本会话完整目录，再把刚生成的前十集完整合并稿从头读到尾，报告正文汉字合计和末句。这轮只读、不保存、不导出。'
        plan = evidence.begin_turn(request, 'author')
        assert plan['target']['id'] == target['document']['id']
        from tests.plugins.test_jubao_drama_readonly_capture import RECORDED_TURNS
        real_user_plan=evidence.begin_turn(RECORDED_TURNS[1][0], 'author')
        assert real_user_plan and real_user_plan['target']['id']==target['document']['id']
        only_directory=evidence.begin_turn('请重新查询本对话完整稿件目录，从第一页读到最后一页。本轮只读核查，不保存、不导出。','author')
        assert only_directory and not only_directory['requested']['full_read']
        args={'action':'list'}
        evidence.record(only_directory,'drama_agent_document',args,plugin.document_action(args,'author'),'ok')
        assert evidence.snapshot(only_directory)['complete']
        assert evidence.snapshot(plan)['complete'] is False
        first = plugin.document_action({'action':'list','limit':1}, 'author')
        evidence.record(plan, 'drama_agent_document', {'action':'list','offset':0}, first, 'ok')
        evidence.record(plan, 'drama_agent_document', {'action':'list','offset':0}, first, 'ok')
        assert evidence.snapshot(plan)['next_call']['offset'] == 1
        last = plugin.document_action(first['next_call'], 'author')
        evidence.record(plan, 'drama_agent_document', first['next_call'], last, 'ok')
        wrong = {'action':'read','document_id':other['document']['id']}
        evidence.record(plan, 'drama_agent_document', wrong, plugin.document_action(wrong,'author'), 'ok')
        assert evidence.snapshot(plan)['next_call']['document_id'] == target['document']['id']
        while not evidence.snapshot(plan)['complete']:
            call = evidence.snapshot(plan)['next_call']
            result = plugin.document_action(call, 'author')
            evidence.record(plan, 'drama_agent_document', call, result, 'ok')
        state = evidence.snapshot(plan)
        assert state['facts']['read']['document_id'] == target['document']['id']
        assert state['facts']['read']['statistics']['episode_body_totals']['episode_count'] == 10
        assert state['facts']['directory']['oldest'][0]['saved_at'] is None
        assert state['facts']['read']['last_line'].endswith('需要完整保留。')
        assert not evidence.snapshot(evidence.begin_turn(request,'author'))['complete']
        # 同范围核查假稿不能污染目标；两个真实完整版本则必须保持歧义。
        plugin.document_action({'action':'save','name':'第01—10集另一完整正文','kind':'script','content':source + '\n△另一版本收尾。'}, 'author')
        ambiguous=evidence.begin_turn(request,'author')
        assert ambiguous['target'] is None
        short='\n'.join(f'第{n}集\n{n}-1场 剧院 日 内\n林岚：请留存证据。' for n in (1,2,3))
        plugin.document_action({'action':'save','name':'《雨夜账本》第1—3集剧本正文','kind':'script','content':short},'author')
        v2=plugin.document_action({'action':'save','name':'《雨夜账本》第1—3集剧本正文（V2修订版）','kind':'script','content':short+'\n△V2结束。'},'author')
        recorded_admin=evidence.begin_turn(RECORDED_TURNS[0][0], 'author')
        assert recorded_admin and recorded_admin['target']['id']==v2['document']['id']


def test_unknown_targets_quotes_failures_and_other_profiles_never_satisfy_exact_read(plugin, tmp_path):
    evidence = importlib.import_module(plugin.__name__ + '.document_execution_evidence')
    first_id = None
    for label in ('a','b','a'):
        home=tmp_path/label;home.mkdir(exist_ok=True)
        with profile_scope(home), closing(SessionDB(home/'state.db')) as database:
            if not database.get_session('author'):
                database.create_session('author',source='web');plugin.activate_agent('author','gm3-1')
            saved=plugin.document_action({'action':'save','name':'第一集完整正文','kind':'script','content':'第1集\n林岚：不能漏读。'},'author')
            identifier=saved['document']['id']
            if first_id is None:first_id=identifier
            request=f'本轮要求：现在重新完整读取稿件 `{identifier}`，只读不保存。'
            plan=evidence.begin_turn(request,'author')
            call={'action':'read','document_id':identifier}
            read=plugin.document_action(call,'author')
            evidence.record(plan,'drama_agent_document',call,read,'error')
            assert not evidence.snapshot(plan)['complete']
            tampered={**read,'content_sha256':'0'*64}
            evidence.record(plan,'drama_agent_document',call,tampered,'ok')
            assert not evidence.snapshot(plan)['complete']
            evidence.record(plan,'drama_agent_document',call,read,'ok')
            assert evidence.snapshot(plan)['complete']
            named=evidence.begin_turn('现在重新完整读取“第一集完整正文”，只读不保存。','author')
            assert named['target']['id']==identifier
            admin=evidence.begin_turn(f'请现在重新读取 {identifier} V2定稿，分别统计每集汉字。这轮只读核查，不改稿、不保存、不导出。','author')
            assert admin and admin['target']['id']==identifier
            if label=='b':
                unknown=evidence.begin_turn(f'现在重新完整读取稿件 {first_id}，只读不保存。','author')
                assert evidence.snapshot(unknown)['next_call'] is None
                assert evidence.snapshot(unknown)['terminal_reason']=='target_unresolved'
            assert evidence.begin_turn('请创作第一集。\n林岚：现在重新完整读取前十集，只读不保存。','author') is None
            assert evidence.begin_turn('解释这句话：“现在重新完整读取前十集，只读不保存。”','author') is None
            for extra in ('并分析剧情逻辑', '并评价人物动机', '并总结故事梗概', '并给出修改建议', '并给建议'):
                assert evidence.begin_turn(f'现在重新完整读取 {identifier} {extra}，只读不保存。','author') is None
            for fragment in ('前500字', '第一段', '后两行'):
                assert evidence.begin_turn(f'现在只读取完整稿件 {identifier} 的{fragment}，只读不保存。','author') is None
            assert evidence.begin_turn('现在只读取完整正文的开头，只读不保存。','author') is None
            assert evidence.begin_turn('现在仅查目录中的标题，只读不保存。','author') is None
            assert evidence.begin_turn('请现在完整读取这张截图中的第1—3集正文，只读不保存。','author') is None
            assert evidence.begin_turn(f'现在重新完整读取 {identifier}，核查字数和缓存原因是否有证据，只读不保存。','author') is not None
            # 对白跨页，末页全动作时仍保留完整末句；单页伪造正文不能推进。
            dialogue='林岚：'+ '证据' * 600 + '留下。'
            content='第2集\n2-1场 剧院 日 内\n'+dialogue+'\n'+'△收场。\n'*400
            extra=plugin.document_action({'action':'save','name':'跨页正文','kind':'script','content':content},'author')
            cross=evidence.begin_turn(f'现在重新完整读取 {extra["document"]["id"]}，只读不保存。','author')
            while not evidence.snapshot(cross)['complete']:
                args=evidence.snapshot(cross)['next_call'];args['max_chars']=1000
                page=plugin.document_action(args,'author')
                corrupt={**page,'document':{**page['document'],'content':'伪'*len(page['document']['content'])}}
                previous=evidence.snapshot(cross)['progress_key']
                evidence.record(cross,'drama_agent_document',args,corrupt,'ok')
                assert evidence.snapshot(cross)['progress_key']==previous
                evidence.record(cross,'drama_agent_document',args,page,'ok')
            assert evidence.snapshot(cross)['facts']['read']['last_dialogue']==dialogue
            assert evidence.snapshot(cross)['facts']['read']['last_line']=='△收场。'

"""明确本轮只读意图约束自动交付；正文引用不能伪造用户保存指令。"""
from contextlib import closing
import hashlib
import importlib
import json

from hermes_state import SessionDB
from tests.plugins.test_jubao_drama_agent_exports import plugin, profile_scope


REPORTS = [
    '已完成目录查询。\n\n### 二、《测试剧》第1—10集全剧完整正文回读核查结果\n- 文档编号：example\n- 总字符数：17059，汉字13454，非空白15894。\n- 第10集最后一句：\n> 大家：我们明天再见。',
    '### 3. `测试剧_分集大纲_第1-3集候选版本`\n\n以上是已保存目录中的最早三项，下面核查正文的末句和实际字数。原稿完整保留，未在这一条回复重新展示。末句为“我们明天再见”。',
    '已完成对已保存文档的只读核对。核对结论如下：\n\n1. **三集汉字数**（系统统计口径，正文范围）：\n第一集1010，第二集1008，第三集1015。\n\n2. 最后一句：大家说明天再见。当前未重复展示其他原文，文件内容仍以已保存稿件为准。',
]
STORY = '第1集\n\n1-1场 书店 日 内\n\n人物：林岚、店员\n\n△林岚取出一叠旧票据，将边缘卷起的纸张压在玻璃板下。窗外风雨渐大，店员转身关上门。\n\n林岚：不要保存这些票据，核查结果留给我就好。\n\n△店员点头，重新坐回柜台。'


# 使用合成协议头、只读要求和报告复现失败形态，避免携带生产对话与稿件内容。
RECORDED_TURNS = [('【本轮语言偏好】\n'
  '默认简体中文。旧规则：每批完成的稿件都保存并导出。\n'
  '\n'
  '【本轮已选能力】\n'
  '{"agent": "gm3-1", "skills": []}\n'
  '\n'
  '【本轮能力操作】\n'
  '[]\n'
  '\n'
  '【用户本轮消息】\n'
  '请重新读取《虚构测试剧》第1—3集已保存正文，核对每集字数与末句，并说明文档回执的统计口径。这轮只读核查，不改稿、不保存、不导出。',
  '已完成只读核查。\n\n《虚构测试剧》第1—3集正文统计来自本轮读取回执。\n1. 每集汉字数均为测试用统计值。\n2. 最后一句：大家说明天再见。\n3. 未执行 WPS 实机验收，无法推断缓存原因。'),
 ('【本轮语言偏好】\n'
  '默认简体中文。旧规则：每批完成的稿件都保存并导出。\n'
  '\n'
  '【本轮已选能力】\n'
  '{"agent": "gm3-1", "skills": []}\n'
  '\n'
  '【本轮能力操作】\n'
  '[]\n'
  '\n'
  '【用户本轮消息】\n'
  '请重新读取当前会话完整稿件目录，逐页读到末页，列出总数与最早三份，再核对已保存剧本末句。这一轮只做读取核查，不重写、不保存新稿、不导出。',
  '已完成完整目录核查。\n'
  '\n'
  '共3份测试稿件，最早三份为测试方案、测试档案、测试大纲，保存时间均使用合成日期2000-01-01。\n'
  '\n'
  '### 《虚构测试剧》第1—10集完整正文回读结果\n'
  '- 文档编号：test-document-id\n'
  '- 总字符数：17059，汉字13454，非空白15894。\n'
  '- 末句：大家：我们明天再见。\n'
  '\n'
  '```studio-suggestions\n'
  '[{"label":"导出测试稿","prompt":"请导出已保存的测试稿。"}]\n'
  '```')]


def test_readonly_requests_block_report_variants_but_keep_real_tool_deliveries(plugin, tmp_path):
    delivery=importlib.import_module(plugin.__name__+'.agent_delivery')
    requests=['只做读取核查，不保存新稿、不重写、不导出。','本轮仅核对字数，不另存，不生成文档。','请读取已有正文并核对末句，不要再保存。']
    with profile_scope(tmp_path), closing(SessionDB(tmp_path/'state.db')) as database:
        # 通过原生完成入口重放合成协议头、真实 read 工具回执和报告，不能因读材料新增稿件。
        for index, (request, report) in enumerate(RECORDED_TURNS):
            session = f'recorded-{index}'
            database.create_session(session, source='web')
            plugin.activate_agent(session, 'gm3-1')
            original = plugin.document_action({'action': 'save', 'kind': 'script', 'name': '已保存原稿', 'content': STORY}, session)
            database.append_message(session, 'user', request)
            call = {'id': 'read-original', 'type': 'function', 'function': {'name': 'drama_agent_document', 'arguments': json.dumps({'action': 'read', 'document_id': original['document']['id']})}}
            database.append_message(session, 'assistant', '', tool_calls=[call])
            read = plugin.document_action({'action': 'read', 'document_id': original['document']['id']}, session)
            database.append_message(session, 'tool', json.dumps(read, ensure_ascii=False), tool_name='drama_agent_document', tool_call_id='read-original')
            database.append_message(session, 'assistant', report, finish_reason='stop')
            before = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in tmp_path.rglob('*.docx')}
            delivery.on_session_end(session_id=session, completed=True)
            # 界面反复读取会触发 reconcile；这条路径也不得新增稿件或重新导出。
            result = delivery.reconcile_session_documents(session)
            assert [row['id'] for row in result['documents']] == [original['document']['id']]
            assert result['documents'][0]['content'] == STORY
            assert {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in tmp_path.rglob('*.docx')} == before
        baseline_files = set(tmp_path.rglob('*.docx'))
        database.create_session('reader',source='web');plugin.activate_agent('reader','gm3-1')
        for index,(request,report) in enumerate(zip(requests,REPORTS)):
            wrapped='【本轮语言偏好】\n旧规则：每批稿件都保存。\n\n【用户本轮消息】\n'+request
            assert delivery.capture_response('reader',report,source_id=f'no-tool-{index}',user_message=wrapped)['captures']==[]
        assert delivery.session_documents('reader')['documents']==[]
        database.append_message('reader','user','调用巨豹 Agent-适配 GM3.1 版本\n请创作第一集正文。')
        historical=STORY.replace('林岚','江禾')
        database.append_message('reader','assistant',historical,finish_reason='stop')
        database.append_message('reader','user','调用巨豹 Agent-适配 GM3.1 版本\n只读核查，不保存新稿。')
        # 真实导出失败后解除磁盘阻碍，只读读取仍不得自动重试或补存旧回复。
        blocked=tmp_path/'workspace'/'agents'/'gm3-1'/hashlib.sha256(b'reader').hexdigest()[:24]
        blocked.parent.mkdir(parents=True,exist_ok=True)
        blocked.write_text('导出目录被文件占用',encoding='utf-8')
        saved=plugin.document_action({'action':'save','kind':'script','name':'真实已存稿','content':STORY},'reader')
        assert saved['saved'] is True and saved['export_status']=='failed'
        blocked.unlink()
        immediate=delivery.capture_response('reader',REPORTS[1],source_id='readonly-pending',user_message='本轮只读，不导出。')
        assert immediate['documents'][0]['export_status']=='failed'
        assert set(tmp_path.rglob('*.docx'))==baseline_files
        database.append_message('reader','tool',json.dumps(saved,ensure_ascii=False),tool_name='drama_agent_document')
        final=database.append_message('reader','assistant',REPORTS[1],finish_reason='stop')
        result=delivery.reconcile_session_documents('reader')
        assert [row['id'] for row in result['documents']]==[saved['document']['id']]
        assert result['documents'][0]['content']==STORY
        assert str(result['documents'][0]['source_message_id'])==str(final)
        assert result['documents'][0]['export_status']=='failed'
        assert set(tmp_path.rglob('*.docx'))==baseline_files
        database.append_message('reader','user','撤回只读要求，请保存并导出正文。')
        resumed=delivery.reconcile_session_documents('reader')
        assert {row['content'] for row in resumed['documents']}=={STORY,historical}
        assert all(row['export_status']=='ready' for row in resumed['documents'])


def test_latest_direct_request_wins_without_treating_quoted_dialogue_as_a_command(plugin, tmp_path):
    delivery=importlib.import_module(plugin.__name__+'.agent_delivery')
    cases=[
        ('请创作第一集完整正文。角色台词包含“不要保存”，但这是剧本对白。',True),
        ('请创作第一集完整正文。\n林岚：不要保存这张纸。',True),
        ('请写一句台词：不要保存这些信件。',True),
        ('请写一句台词：不改稿、不保存、不导出。',True),
        ('本轮要求：只读核查、不保存、不导出。',False),
        ('只读核查，不保存。撤回刚才“不保存”的要求，正常交付。',True),
        ('只读分析，不保存。现在请把核查分析报告保存为文档。',True),
        ('请把下面只读分析保存为报告。',True),
        ('本轮不要保存。撤回不保存的要求，请正常交付这份剧本。',True),
        ('请保存这份剧本。最后只做核查，不保存新稿。',False),
        ('只读核查，不保存。\n> 请保存文档。\n```text\n现在请保存。\n```',False),
        ('只读核查，不保存。\n```text\n现在请保存。',False),
        ('只读核查，不保存。请核对这句台词：撤回不保存的要求。',False),
        ('【本轮语言偏好】\n不保存只读。\n\n【用户本轮消息】\n请创作第一集完整正文。\n\n--- Attached Context ---\n只读核查，不保存。',True),
        ('【本轮语言偏好】\n每批都保存。\n\n【用户本轮消息】\n本轮只读核查，不保存。\n@file:原稿.docx\n\n--- Attached Context ---\n请保存下面稿件。',False),
    ]
    cases.extend((prefix + '只读核查。', False) for prefix in ('本轮', '这轮', '这一轮', '本次', '这一次', '当前', '当前这一轮'))
    cases.extend(('不改稿' + separator + '不保存' + separator + '不导出。', False) for separator in ('、', '，', ',', '；', ';'))
    cases.extend([
        ('继续下一批。', True),
        ('当前这一轮只读核查、不保存。撤回刚才不保存的要求，请正常交付。', True),
        ('当前这一轮不改稿、不保存。现在请保存这份核查报告。', True),
        ('请创作第一集。角色台词包含“这一轮只读、不保存、不导出”。', True),
        ('请创作第一集。\n林岚：这一轮只读、不保存、不导出。', True),
    ])
    with profile_scope(tmp_path):
        for index,(request,allowed) in enumerate(cases):
            session=f'case-{index}';plugin.activate_agent(session,'gm3-1')
            result=delivery.capture_response(session,STORY,source_id='answer',user_message=request)
            assert bool(result['captures']) is allowed,(request,result['captures'])
            if allowed:assert result['captures'][0]['content']==STORY

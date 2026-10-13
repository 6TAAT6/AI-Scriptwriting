"""同轮真实保存正文的显示与证据说明不能重复交付；新正文继续保留。"""
from contextlib import closing
import hashlib
import importlib
import json
from pathlib import Path

from hermes_state import SessionDB
from tests.plugins.test_jubao_drama_agent_exports import plugin, profile_scope

STORY = '1-1场  街角旧书店  夜  内\n\n人物：Elena、Noah\n\n△暴雨敲打着街角旧书店的木框橱窗，店内吊灯散发着微弱的黄光。\n\n△Elena站在收银柜台前，将一张边缘磨损的硬纸借书卡推向柜台对面的Noah。\n\nElena：关门前核对一次，这张卡上的签名是你吗？\n\n△Noah用沾着雨水的粗糙手指擦过卡片背面，借阅日期停留在去年秋天。\n\nNoah：（低头辨认）签名确实是我的，但借阅清单上多了一本地图册。\n\nElena：（收回卡片）只要名字对得上就足够了。'
REQUEST = '请为《雨夜账本》写一场独立的番外练习，120至180个汉字，Elena和Noah在书店关门前核对一张借书卡，保持本会话欧美设置；不推进主线，不改已有V1/V2，完成后保存为一份独立正文。'
REPLY = '已完成《雨夜账本》独立番外练习的创作，并已作为独立剧本正文保存并生成独立 Word 文档。本篇不涉及主线剧情推进，未改动已有的 V1/V2 稿件。\n\n### 正文内容\n\n1-1场  街角旧书店  夜  内\n\n人物：Elena、Noah\n\n△暴雨敲打着街角旧书店的木框橱窗，店内吊灯散发着微弱的黄光。\n\n△Elena站在收银柜台前，将一张边缘磨损的硬纸借书卡推向柜台对面的Noah。\n\nElena：关门前核对一次，这张卡上的签名是你吗？\n\n△Noah用沾着雨水的粗糙手指擦过卡片背面，借阅日期停留在去年秋天。\n\nNoah：（低头辨认）签名确实是我的，但借阅清单上多了一本地图册。\n\nElena：（收回卡片）只要名字对得上就足够了。\n\n---\n\n### 系统字数核验与文件状态\n\n依据工具实际返回的系统统计证据（口径 `unicode_han_and_non_whitespace_v1`，覆盖全文）：\n- **汉字数**：**147** 汉字（符合 120 至 180 汉字要求）\n- **非空白字符数**：**209** 个\n- **非空顶层正文段落**：**8** 段\n- **回执与检查限制**：导出文件回读校验通过（`content_roundtrip: passed`），排版版式与 WPS 实机验收未执行（`not_checked`），当前状态为草稿（`draft`）。\n\n独立 Word 稿件《《雨夜账本》番外练习：借书卡.docx》（文档ID：`6d9c67f0d89144eda880febe01285dfd`）已生成，可从右侧稿件栏直接阅读或下载。\n\n```studio-suggestions\n[\n  {\n    "label": "回到主线：创作第4—6集",\n    "prompt": "番外练习已完成，请回到《雨夜账本》主线，按照单集3场、800—1200字的标准创作第4—6集剧本正文，并保存独立Word文件。",\n    "recommended": true\n  },\n  {\n    "label": "扩写当前番外场景对话",\n    "prompt": "请在当前书店借书卡番外场景的基础上，增加Elena与Noah关于地图册借阅去向的追问对白。"\n  },\n  {\n    "label": "查看番外文档回读校验明细",\n    "prompt": "请说明刚才保存的番外练习Word文件的段落与文本哈希核验明细。"\n  }\n]\n```'


def _saved_turn(plugin, database, session, content=STORY, kind='script', name='已保存正式稿'):
    database.create_session(session, source='web')
    plugin.activate_agent(session, 'gm3-1')
    database.append_message(session, 'user', REQUEST)
    args = {'action': 'save', 'name': name, 'kind': kind, 'content': content}
    database.append_message(session, 'assistant', tool_calls=[{'id': 'real-save', 'type': 'function', 'function': {'name': 'drama_agent_document', 'arguments': json.dumps(args, ensure_ascii=False)}}])
    saved = plugin.document_action(args, session)
    database.append_message(session, 'tool', json.dumps(saved, ensure_ascii=False), tool_name='drama_agent_document', tool_call_id='real-save')
    return saved


def test_real_saved_reply_with_statistics_tail_reuses_authoritative_body_and_file(plugin, tmp_path):
    delivery = importlib.import_module(plugin.__name__ + '.agent_delivery')
    with profile_scope(tmp_path), closing(SessionDB(tmp_path/'state.db')) as database:
        saved = _saved_turn(plugin, database, 'real-replay')
        path = Path(saved['receipt']['path'])
        before = (path.stat().st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
        final = database.append_message('real-replay', 'assistant', REPLY, finish_reason='stop')
        result = delivery.reconcile_session_documents('real-replay')
        assert [row['id'] for row in result['documents']] == [saved['document']['id']]
        assert result['documents'][0]['content'] == STORY
        assert str(result['documents'][0]['source_message_id']) == str(final)
        assert (path.stat().st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest()) == before
        assert len(list(tmp_path.rglob('*.docx'))) == 1
        assert len(delivery.reconcile_session_documents('real-replay')['documents']) == 1


def test_source_reuse_keeps_real_new_content_other_kinds_and_no_tool_fallback(plugin, tmp_path):
    delivery = importlib.import_module(plugin.__name__ + '.agent_delivery')
    new_scene = '\n\n1-2场 书店后门 夜 外\n\n人物：Elena\n\n△Elena推开后门，沿墙查找新的线索。\n\nElena：还有一张借书卡没找到。'
    new_episode = '\n\n第2集\n\n2-1场 书店 日 内\n\n人物：Noah\n\n△Noah将地图册摊开，指向被涂掉的街道。\n\nNoah：下次我们从这里开始。'
    plain_extension = '\n\n第二天，Elena在柜台底下发现另一张借书卡，卡片上的签名属于旧店主。她将两张卡放在灯下，发现背面都有一个相同的红色印记。'
    new_dialogue = '\n\n检查员：你手里的地图册归我保管。'
    file_dialogue = '\n\n文件管理员：证据我已保存，明天去警局。'
    with profile_scope(tmp_path), closing(SessionDB(tmp_path/'state.db')) as database:
        for index, extension in enumerate((new_scene, new_episode, plain_extension, new_dialogue, file_dialogue)):
            session = f'extended-{index}'
            saved = _saved_turn(plugin, database, session, name='番外剧本正文')
            expanded = STORY + extension
            database.append_message(session, 'assistant', '本批已保存并生成 Word。\n\n### 番外剧本正文\n\n' + expanded, finish_reason='stop')
            rows = delivery.reconcile_session_documents(session)['documents']
            assert len(rows) == 2
            assert any(expanded in row['content'] for row in rows if row['id'] != saved['document']['id'])
        session = 'independent'
        saved = _saved_turn(plugin, database, session)
        analysis = '剧情分析\n人物的目标是确认借书卡上的签名，阻力来自清单中多出的地图册。这一冲突由眼前实物推动，后续可以围绕同一证据继续展开调查，而不用添加无关背景。'
        outline = '分集大纲\n第1集\nElena核对签名后收回借书卡，决定次日查看地图册的借阅记录。Noah先联系旧店主，询问红色印记的用途，两条线索在书店门口汇合。'
        second = STORY.replace('Elena', 'Mira').replace('Noah', 'Leo')
        args = {'action': 'save', 'kind': 'script', 'name': '另一份正式正文', 'content': second}
        database.append_message(session, 'assistant', tool_calls=[{'id': 'second-save', 'type': 'function', 'function': {'name': 'drama_agent_document', 'arguments': json.dumps(args, ensure_ascii=False)}}])
        second_saved = plugin.document_action(args, session)
        database.append_message(session, 'tool', json.dumps(second_saved, ensure_ascii=False), tool_name='drama_agent_document', tool_call_id='second-save')
        reply = '### 已保存剧本正文\n\n' + STORY + '\n\n### 第二份剧本正文\n\n' + second + '\n\n### 剧情分析\n\n' + analysis + '\n\n### 分集大纲\n\n' + outline
        database.append_message(session, 'assistant', reply, finish_reason='stop')
        rows = delivery.reconcile_session_documents(session)['documents']
        assert len(rows) == 4
        assert saved['document']['id'] in {row['id'] for row in rows}
        assert second_saved['document']['id'] in {row['id'] for row in rows}
        assert {'script','analysis','outline'} == {row['kind'] for row in rows}
        assert any(second in row['content'] for row in rows)
        novel = '第一章\n雨水压低了老书店的屋檐。Mira翻开登记簿，将每一行借阅日期抄在纸上，再对照卡片背面的印章。窗外最后一盏灯熄灭，她仍在等待那位从未归还地图册的读者。'
        saved = _saved_turn(plugin, database, 'novel', novel, 'novel')
        extended = novel + '\n\n第二章\n次日清晨，来访者带着另一册地图走进书店。'
        database.append_message('novel','assistant','### 小说正文\n\n'+extended,finish_reason='stop')
        assert len(delivery.reconcile_session_documents('novel')['documents']) == 2
        plugin.activate_agent('fallback','gm3-1')
        captured = delivery.capture_response('fallback', STORY, source_id='no-tools', user_message='请创作一场完整剧本正文。')
        assert len(captured['captures']) == 1 and captured['captures'][0]['content'] == STORY

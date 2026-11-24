"""只读稿件核查的精确目标与本轮覆盖；状态由调用方按turn/profile隔离持有。"""
from contextlib import closing
import hashlib
import json
import re

from hermes_constants import get_hermes_home
from plugins.plugin_storage import plugin_db

from .capability_selection import document_owner

_NUMBER = r"(?:[0-9]{1,4}|[零〇一二三四五六七八九十百两]{1,8})"


def _number(value):
    if value.isascii() and value.isdecimal():
        return int(value)
    digits = {char: value for value, char in enumerate('零一二三四五六七八九')}
    digits.update({'〇': 0, '两': 2})
    total = current = 0
    for char in value:
        if char in digits:
            current = digits[char]
        else:
            total += (current or 1) * {'十': 10, '百': 100}[char]; current = 0
    return total + current


def _range(value):
    match = re.search(rf"第?\s*({_NUMBER})\s*[—–－\-~至到]\s*({_NUMBER})\s*集", value)
    if match:
        return _number(match[1]), _number(match[2])
    match = re.search(rf"前\s*({_NUMBER})\s*集", value)
    if match:
        return 1, _number(match[1])
    match = re.search(rf"第\s*({_NUMBER})\s*集", value)
    return (_number(match[1]),) * 2 if match else None


def _user_body(message):
    marker = '\n\n【用户本轮消息】\n'
    if message.startswith('【本轮语言偏好】\n') and marker in message:
        message = message.split(marker, 1)[1]
    message = re.split(r'\n\n--- (?:Attached Context|Context Warnings) ---', message, maxsplit=1)[0]
    return message


def _direct_text(message):
    message = _user_body(message)
    message = re.sub(r'(?ms)^[ \t]*(`{3,}|~{3,})[^\n]*\n.*?(?:^[ \t]*\1[ \t]*$|\Z)', '', message)
    message = re.sub(r'“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|`[^`\n]*`', '', message)
    return '\n'.join(line for line in message.splitlines() if not line.lstrip().startswith(('>', '△', '@file:'))
                     and (not re.match(r'^[^\s:：。！？!?；;，,、]{1,16}[:：]', line.strip())
                          or re.match(r'^(?:本轮|本次|这轮|这一轮|当前|要求|请|任务|注意|修改|补充)', line.strip())))


def _targets(session, owner):
    from .agent_documents import _reading_scope
    from .agent_document_delegation import delegated_document_ids
    scope = _reading_scope(session, owner); delegated = delegated_document_ids(owner, scope)
    with closing(plugin_db('jubao-drama')) as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='agent_documents'").fetchone():
            return []
        rows = conn.execute("SELECT d.id,d.name,COALESCE(e.kind,'document') FROM agent_documents d "
                            "LEFT JOIN agent_document_delivery e ON e.document_id=d.id WHERE d.agent_id=? AND (d.session_id IN ("
                            + ','.join('?' for _ in scope) + ') OR d.id IN (' + ','.join('?' for _ in delegated) + ')) ORDER BY d.rowid DESC',
                            (owner, *scope, *delegated)).fetchall()
    return [{'id': identifier, 'name': name, 'kind': kind, 'range': _range(name)}
            for identifier, name, kind in rows if kind != 'internal']


def _covers_episodes(content, requested):
    titles = {_number(match[1]) for match in re.finditer(rf'(?m)^\s*[#*]*\s*第\s*({_NUMBER})\s*集(?:\s|[:：]|$)', content)}
    scenes = {int(match[1]) for match in re.finditer(r'(?m)^\s*[#*]*\s*(\d+)\s*[-—－]\s*\d+场?\s', content)}
    return set(range(requested[0], requested[1] + 1)) <= titles & scenes


def _read_state():
    return {'end':0,'complete':False,'facts':None,'carry':'','overflow':False,'last_line':None,'last_dialogue':None}


def _comparison_pair(candidates,matches,owner):
    """最新稿与直接前版均须在合法读取集合内，质量报告还必须匹配两份当前原文。"""
    if not matches:return None
    current=dict(matches[0]);allowed={row['id']:row for row in candidates}
    with closing(plugin_db('jubao-drama')) as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='agent_document_quality'").fetchone():return None
        row=conn.execute('SELECT d.content,q.content_sha256,q.report FROM agent_documents d '
                         'JOIN agent_document_quality q ON q.document_id=d.id WHERE d.id=? AND d.agent_id=?',
                         (current['id'],owner)).fetchone()
        if not row:return None
        content,digest,raw=row
        if hashlib.sha256(content.encode()).hexdigest()!=digest:return None
        report=json.loads(raw);identifier=report.get('previous_document_id')
        if identifier not in allowed or identifier==current['id']:return None
        old=conn.execute('SELECT content FROM agent_documents WHERE id=? AND agent_id=?',(identifier,owner)).fetchone()
        if not old or hashlib.sha256(old[0].encode()).hexdigest()!=report.get('previous_content_sha256'):return None
    current.update(characters=len(content),hash=digest)
    previous={**allowed[identifier],'characters':len(old[0]),'hash':report['previous_content_sha256']}
    boundaries=[boundary for check in report.get('checks',[]) for boundary in check.get('evidence',{}).get('ending_boundaries',[])]
    return {'current':current,'previous':previous,'read':_read_state(),'ending_boundaries':boundaries}


def _comparison_facts(plan):
    comparison=plan.get('comparison')
    if not comparison or not plan['read']['complete'] or not comparison['read']['complete']:return None
    prefix=None
    if comparison['ending_boundaries']:
        from .requirement_checks import _episodes
        with closing(plugin_db('jubao-drama')) as conn:
            rows=conn.execute('SELECT id,content FROM agent_documents WHERE id IN (?,?) AND agent_id=?',
                              (comparison['current']['id'],comparison['previous']['id'],plan['owner'])).fetchall()
        versions={identifier:{row['episode_number']:row['text'] for row in _episodes(text)} for identifier,text in rows}
        prefix=all(type(boundary.get('start_char')) is int and boundary['start_char']>=0 and
                   all(boundary.get('episode') in versions.get(target['id'],{}) and
                       hashlib.sha256(versions[target['id']][boundary['episode']][:boundary['start_char']].encode()).hexdigest()==boundary.get('locked_prefix_sha256')
                       for target in (comparison['current'],comparison['previous'])) for boundary in comparison['ending_boundaries'])
    return {'current':plan['read']['facts'],'previous':comparison['read']['facts'],'locked_prefix_unchanged':prefix}


def begin_turn(user_message, session_id):
    from .agent_delivery import _auto_capture_allowed
    if not isinstance(user_message, str) or _auto_capture_allowed(user_message):
        return None
    text = _direct_text(user_message)
    clauses = re.split(r'[。！？!?；;，,、\n]', text)
    if any(re.search(r'读取|阅读|查看|回读', clause) and re.search(
            rf'(?:前|后|头|尾|第)\s*{_NUMBER}\s*(?:个)?(?:字|字符|段|行)|开头|开篇|片段|局部|标题', clause) for clause in clauses):
        return None
    if re.search(r'截图|图片|照片|图中|附图', text) and not re.search(r'已保存.{0,16}(?:稿件|正文)|稿件.{0,16}已保存', text):
        return None
    requested_actions = re.sub(r'(?:不要|不再|不用|无需|禁止|不得|不)(?:再|重新)?(?:改写|重写|续写|创作)', '', text)
    if re.search(r'(?:分析|评价|点评|评估|审查|诊断).{0,12}(?:剧情|人物|逻辑|质量|节奏|文风|故事|台词)|'
                 r'(?:剧情|人物|逻辑|质量|节奏|故事).{0,8}(?:分析|评价|点评|评估|审查|诊断)|'
                 r'(?:总结|概括|提炼).{0,10}(?:剧情|梗概|故事)|(?:给出?|提供|提出).{0,10}(?:建议|方案)|改写|重写|续写|创作', requested_actions):
        # 确定性核查报告不能吞掉用户同时要求的解读、建议或创作任务。
        return None
    if not re.search(r'现在|重新|再次|再(?:读|查|核)|本轮|这一?轮|当前', text):
        return None
    directory = bool(re.search(r'(?:完整|全部|所有).{0,8}目录|目录.{0,12}(?:完整|全部|最后一页)', text))
    clauses = [clause for clause in clauses if '目录' not in clause]
    full_read = any(re.search(r'读取|回读|阅读|读到尾|从头.{0,6}读', clause)
                    and re.search(r'稿件|原稿|正文|定稿|合并稿|全文|完整|从头|[0-9a-f]{32}', clause) for clause in clauses)
    if not directory and not full_read:
        return None
    try:
        owner = document_owner(session_id)
    except PermissionError:
        return None
    target = None;comparison=None
    if full_read:
        candidates = _targets(session_id, owner)
        objects = _user_body(user_message)
        ids = set(re.findall(r'(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])', objects))
        names = [row for row in candidates if row['name'] in objects]
        requested_range = _range(objects)
        matches = [row for row in candidates if row['id'] in ids] if ids else names
        if not ids and not names and requested_range:
            matches = [row for row in candidates if row['range'] == requested_range and row['kind'] == 'script']
            versions = set(re.findall(r'v\d+(?:\.\d+)*', objects, re.I))
            if versions:
                matches = [row for row in matches if {version.lower() for version in re.findall(r'v\d+(?:\.\d+)*', row['name'], re.I)}
                           == {version.lower() for version in versions}]
            with closing(plugin_db('jubao-drama')) as conn:
                conn.create_function('covers_episodes', 1, lambda content: _covers_episodes(content, requested_range))
                matches = [row for row in matches if conn.execute('SELECT covers_episodes(content) FROM agent_documents WHERE id=?',
                                                                  (row['id'],)).fetchone()[0]]
        compare_requested=bool(re.search(r'修改前后|修订前后|前后.{0,8}(?:两份|版本)|直接前版|previous_document_id',objects))
        if compare_requested:
            named_selection=bool(names or re.search(r'《[^》]+》|“[^”]+”|「[^」]+」',objects))
            if not matches and not ids and not named_selection and not requested_range and re.search(r'刚才|最新|本次修改|本轮修改',objects):matches=candidates[:1]
            comparison=_comparison_pair(candidates,matches,owner)
            if comparison:
                pair_ids={comparison['current']['id'],comparison['previous']['id']}
                if (ids and not ids<=pair_ids) or (names and not {row['id'] for row in names}<=pair_ids):comparison=None
            if comparison:matches=[comparison['current']]
            else:matches=[]
        if len(matches) == 1:
            target = matches[0]
            with closing(plugin_db('jubao-drama')) as conn:
                conn.create_function('source_hash', 1, lambda content: hashlib.sha256(content.encode()).hexdigest())
                length, digest = conn.execute('SELECT LENGTH(content),source_hash(content) FROM agent_documents WHERE id=? AND agent_id=?',
                                              (target['id'], owner)).fetchone()
                target.update(characters=length, hash=digest)
    return {'profile': str(get_hermes_home().resolve()), 'session_id': session_id, 'owner': owner, 'target': target,'comparison':comparison,
            'requested': {'directory': directory, 'full_read': full_read, 'body_total': '正文' in text and '合计' in text,
                          'episode_counts': bool(re.search(r'每集|分别|分集.{0,6}(?:统计|字数)', text)),
                          'whole_total': bool(re.search(r'总数|全文|总字数|总字符|总汉字|总计', text)),
                          'last_line': bool(re.search(r'最后一行|末句|最后一句', text)),
                          'last_dialogue': bool(re.search(r'对白|台词|末句|最后一句', text)), 'saved_times': '保存时间' in text,
                          'paragraphs': bool(re.search(r'段落|\d+段', text)), 'file_checks': bool(re.search(r'文件|回执|核验', text)),
                          'cache': '缓存' in text, 'wps': 'WPS' in text.upper()},
            'directory': {'snapshot': None, 'total': None, 'end': 0, 'oldest': [], 'ids': [], 'complete': False},
            'read':_read_state()}


def _remember_lines(state, content, final):
    pieces = (state['carry'] + content).split('\n'); state['carry'] = ''
    pending = pieces.pop() if not final else ''
    for line in pieces:
        line = line.strip()
        if state['overflow'] or len(line) > 4096:
            state.update(last_line=None, last_dialogue=None, overflow=False)
        elif line:
            state['last_line'] = line
            if re.match(r'[^△#\s:：]{1,30}[:：]', line) and not line.startswith(('人物：', '出场人物：')):
                state['last_dialogue'] = line
    if len(pending) > 4096:
        state['overflow'] = True
    else:
        state['carry'] = pending


def record(plan, tool_name, args, result, status='ok'):
    if not plan or plan['profile'] != str(get_hermes_home().resolve()) or tool_name != 'drama_agent_document' or status != 'ok':
        return plan
    try:
        if document_owner(plan['session_id']) != plan['owner']: return plan
    except PermissionError:
        return plan
    if isinstance(result, str):
        try: result = json.loads(result)
        except ValueError: return plan
    if not isinstance(args, dict) or not isinstance(result, dict) or result.get('ok') is not True:
        return plan
    comparison=plan.get('comparison')
    if comparison and args.get('action')=='read' and args.get('document_id')==comparison['previous']['id']:
        record({**plan,'comparison':None,'target':comparison['previous'],'read':comparison['read']},tool_name,args,result,status)
        return plan
    if args.get('action') == 'list' and plan['requested']['directory']:
        state = plan['directory']; rows = result.get('documents')
        start, total, snapshot = result.get('offset'), result.get('total'), result.get('snapshot_rowid')
        if not isinstance(rows, list) or any(type(value) is not int or value < 0 for value in (start, total, snapshot)):
            return plan
        ids = [row.get('id') for row in rows if isinstance(row, dict) and isinstance(row.get('id'), str) and isinstance(row.get('name'), str)]
        if len(ids) != len(rows) or len(set(ids)) != len(ids) or set(ids) & set(state['ids']): return plan
        if start != state['end'] or start + len(rows) > total:
            return plan
        if state['snapshot'] is None:
            if start != 0: return plan
            state.update(snapshot=snapshot, total=total)
        if (state['snapshot'], state['total']) != (snapshot, total): return plan
        end = start + len(rows)
        if result.get('has_more') is not (end < total): return plan
        state['end'] = end
        state['ids'].extend(ids)
        state['oldest'] = (state['oldest'] + [{'id': row['id'], 'name': row['name'], 'saved_at': None}
                                           for row in rows if isinstance(row, dict) and isinstance(row.get('id'), str) and isinstance(row.get('name'), str)])[-3:]
        state['complete'] = end == total
    if args.get('action') == 'read' and plan['target']:
        target, state, document = plan['target'], plan['read'], result.get('document') or {}
        if not isinstance(document, dict): return plan
        start, end = result.get('start_char'), result.get('end_char')
        if (args.get('document_id') != target['id'] or document.get('id') != target['id']
                or result.get('content_sha256') != target['hash'] or result.get('characters') != target['characters']
                or type(start) is not int or type(end) is not int or start != state['end'] or not start <= end <= target['characters']
                or not isinstance(document.get('content'), str) or len(document['content']) != end - start
                or result.get('has_more') is not (end < target['characters'])):
            return plan
        with closing(plugin_db('jubao-drama')) as conn:
            actual = conn.execute('SELECT substr(content,?,?) FROM agent_documents WHERE id=? AND agent_id=?',
                                  (start + 1, end - start, target['id'], plan['owner'])).fetchone()
        if actual is None or actual[0] != document['content']: return plan
        state['end'] = end; state['complete'] = end == target['characters']
        _remember_lines(state, document['content'], state['complete'])
        if state['complete']:
            receipt = result.get('receipt') or {}
            state['facts'] = {'document_id': target['id'], 'name': target['name'], 'statistics': document.get('text_statistics'),
                              'last_line': state['last_line'], 'last_dialogue': state['last_dialogue'],
                              'receipt': {key: receipt[key] for key in ('paragraphs', 'paragraphs_scope', 'hash_scopes', 'content_verified',
                                          'layout_verified', 'verification', 'size_bytes') if key in receipt}}
    return plan


def snapshot(plan):
    if plan['profile'] != str(get_hermes_home().resolve()):
        return {'complete': False, 'missing': ['scope'], 'facts': {}, 'next_call': None,
                'progress_key': None, 'terminal_reason': 'profile_mismatch'}
    directory, read = plan['directory'], plan['read']; missing = []; next_call = None
    comparison=plan.get('comparison')
    reading_complete=read['complete'] and (not comparison or comparison['read']['complete'])
    if plan['requested']['directory'] and not directory['complete']:
        missing.append('directory')
        next_call = {'action': 'list', 'offset': directory['end']}
        if directory['snapshot'] is not None: next_call['snapshot_rowid'] = directory['snapshot']
    if plan['requested']['full_read'] and not reading_complete:
        missing.append('full_read')
        if next_call is None and plan['target']:
            target=plan['target'];cursor=read['end']
            if comparison and read['complete']:
                target=comparison['previous'];cursor=comparison['read']['end']
            next_call = {'action': 'read', 'document_id': target['id'], 'start_char':cursor,
                         'max_chars': 12000, 'content_sha256':target['hash']}
    return {'complete': not missing, 'missing': missing,
            'facts': {'directory': {'total': directory['total'], 'oldest': list(reversed(directory['oldest'])), 'saved_time_known': False}
                      if directory['complete'] else None, 'read': read['facts'] if read['complete'] else None,
                      'comparison':_comparison_facts(plan)},
            'next_call': next_call, 'progress_key': (directory['snapshot'], directory['end'], read['end'],comparison['read']['end'] if comparison else None),
            'terminal_reason': 'target_unresolved' if plan['requested']['full_read'] and not plan['target'] else None}

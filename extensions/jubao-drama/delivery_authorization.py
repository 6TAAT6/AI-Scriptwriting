"""从本账号原生历史恢复真实交付授权，不把模型选项或引用当成用户决定。"""
from contextlib import closing
from copy import deepcopy
import hashlib
import json
import re

from hermes_constants import get_hermes_home, hermes_home_key
from hermes_state import SessionDB
from plugins.plugin_storage import plugin_db

from .task_requirement_extract import extract, source_for_turn, starts_new_task


def _object(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


def _answered(row, calls):
    if row.get('tool_name') != 'clarify' or row.get('display_kind') or row.get('_compressed_summary'):
        return []
    questions = calls.pop(row.get('tool_call_id'), None)
    payload = _object(row.get('content'))
    if not questions or not isinstance(payload, dict) or payload.get('outcome') != 'submitted':
        return []
    answers = []
    for response in payload.get('responses', []):
        if not isinstance(response, dict) or response.get('status') != 'answered':
            continue
        question = next((item for item in questions if isinstance(item, dict)
                         and item.get('question') == response.get('question')), None)
        answer = response.get('user_response')
        if (question is None or not isinstance(answer, str) or not answer.strip() or len(answer) > 8000
                or response.get('choices_offered', []) != question.get('choices', [])):
            continue
        answers.append(answer.strip())
    return answers


def history_turns(session_id):
    """只读已验证的压缩链；每个答案必须对应同轮真实 clarify 调用与完成回执。"""
    path = get_hermes_home() / 'state.db'
    if not path.is_file():
        return []
    from .agent_delivery import _owner
    owner = _owner(session_id)
    if not owner:
        return []
    with closing(SessionDB(path, read_only=True)) as database:
        chain = database._resume_lineage_ids(session_id) or [session_id]
        sources = {sid: (database.get_session(sid) or {}).get('source') for sid in chain if _owner(sid) == owner}
        rows = database.get_messages(session_id, include_compacted=True, include_ancestors=True)
    from .capability_selection import invocation_commands
    from .agent_profiles import AGENT_PROFILES
    from .agent_delivery import _activation_time
    turns, current, calls, previous = [], None, {}, {}
    selected, explicit_selection = None, False
    for row in rows:
        if row.get('session_id', session_id) not in sources or row.get('display_kind') or row.get('_compressed_summary'):
            continue
        if row.get('role') == 'user':
            if current:
                current['task'] = extract({**current['source'], 'original_text': current['request']}, previous)[1]
                if current['task'].get('creative') or current['task'].get('read_only'):
                    previous = current['task']
            origin = row.get('session_id', session_id)
            for action, key in invocation_commands(row.get('content') or ''):
                if key in AGENT_PROFILES:
                    if selected != key or action == '停用':
                        previous = {}
                    selected = None if action == '停用' else key
                    explicit_selection = True
                elif owner == 'independent-skills' and action != '停用':
                    selected, explicit_selection = owner, True
            if not explicit_selection:
                activated = _activation_time(origin, owner)
                if isinstance(row.get('timestamp'), (int, float)) and activated is not None and row['timestamp'] >= activated:
                    selected = owner
            stored = {**row, '_row_id': row.get('id'), '_session_source': sources[origin]}
            source = source_for_turn(row.get('content'), [stored], str(row.get('message_uid') or row.get('id')), allow_legacy=True)
            current = {'source': source, 'request': source['original_text'], 'answers': [], 'assistant_ids': [], 'origin': origin} if source and selected == owner else None
            if source is None or starts_new_task(source['original_text']):
                previous = {}
            calls = {}
            if current:
                turns.append(current)
            continue
        if current is None:
            continue
        if row.get('role') == 'assistant':
            for call in _object(row.get('tool_calls')) or []:
                if not isinstance(call, dict):
                    continue
                function = call.get('function') or {}
                args = _object(function.get('arguments'))
                if function.get('name') == 'clarify' and isinstance(args, dict) and isinstance(args.get('questions'), list):
                    calls[call.get('id')] = args['questions']
            if (not row.get('tool_calls') and isinstance(row.get('content'), str)
                    and row.get('finish_reason') not in {'length', 'content_filter', 'error', 'agent_error', 'cancelled', 'interrupted', 'abort', 'failed'}):
                current['assistant_ids'].append(str(row['id']))
        elif row.get('role') == 'tool':
            answers = _answered(row, calls)
            current['answers'].extend(answers)
            current['request'] = '\n'.join([current['source']['original_text'], *current['answers']]).strip()
    if current:
        current['task'] = extract({**current['source'], 'original_text': current['request']}, previous)[1]
    return turns


def current_turn(session_id, state):
    row = (state.get('delivery_input') or {}).get('row') or {}
    source = state.get('contract', {}).get('source') or {}
    uid, row_id = row.get('message_uid') or source.get('message_uid'), row.get('_row_id') or source.get('message_row_id')
    turns = history_turns(session_id)
    if not turns:
        return None
    current = turns[-1]
    recorded = current['source']
    if not (uid and recorded.get('message_uid') == uid or not uid and row_id and recorded.get('message_row_id') == row_id):
        return None
    hashes = (state.get('delivery_input') or {}).get('input_hashes', set())
    if hashes and recorded['input_sha256'] not in hashes:
        return None
    return current


def apply_clarification(state, session_id):
    current = current_turn(session_id, state)
    if current is None or not current['answers']:
        return
    source = {**current['source'], 'turn_id': state['turn_id'], 'original_text': current['request'],
              'text_sha256': hashlib.sha256(current['request'].encode()).hexdigest(), 'origin': 'native_clarify_answer'}
    operations, task, _pending = extract(source, {})
    requirements = []
    for index, operation in enumerate(operations):
        if operation['action'] != 'set':
            continue
        requirements.append({'id': 'clarified-' + hashlib.sha256((state['turn_id'] + str(index)).encode()).hexdigest()[:24],
            **{key: operation[key] for key in ('kind', 'value', 'scope', 'quote', 'subject')},
            'status': 'active', 'origin': 'native_clarify_answer', 'source_turn_id': state['turn_id']})
    state['clarified_delivery'] = {'source': source, 'current_task': task, 'requirements': requirements}
    apply_contract(state)


def apply_contract(state):
    clarified = state.get('clarified_delivery')
    if not clarified:
        return
    contract = deepcopy(state['contract'])
    kinds = {row['kind'] for row in clarified['requirements']}
    rows = [row for row in contract['active_requirements'] if row.get('origin') != 'native_clarify_answer'
            and not (row.get('kind') in kinds and (row.get('scope') or {}).get('lifetime') == 'turn')]
    rows.extend(clarified['requirements'])
    contract.update(source=clarified['source'], current_task=clarified['current_task'], active_requirements=rows,
                    semantic_requirements=[row for row in rows if row['kind'] in {'semantic', 'forbidden_mechanism'}],
                    capture_status='captured', home_key=hermes_home_key())
    state['contract'] = contract


def recoverable_turns(session_id, turns=None):
    """仅恢复从未进入稿件修订周期的漏交付回合，已检查或已拒绝稿件仍由原链管理。"""
    from .agent_delivery import _auto_capture_allowed
    from .creative_scope import lineage
    root = lineage(session_id)[0]
    result = {}
    with closing(plugin_db('jubao-drama')) as conn:
        exists = conn.execute("SELECT 1 FROM sqlite_master WHERE name='requirement_revision_cycles'").fetchone()
        cycles = {key: json.loads(value) for key, value in conn.execute('SELECT source_key,payload FROM requirement_revision_cycles')} if exists else {}
    for turn in history_turns(session_id) if turns is None else turns:
        source = turn['source']
        identity = 'uid:' + source['message_uid'] if source.get('message_uid') else 'row:' + str(source.get('message_row_id'))
        task = turn['task']
        if (not task.get('creative') or task.get('read_only') or task.get('correction_only')
                or not _auto_capture_allowed(turn['request']) or cycles.get(root + '|' + identity, {}).get('targets')):
            continue
        for identifier in turn['assistant_ids']:
            result[identifier] = turn['request']
    return result


def historical_save_allowed(session_id, content):
    """用户明确要求保存时，只放行本会话真实已展示的完整原稿，绝不接受模型补写。"""
    from .agent_delivery import _auto_capture_allowed, _history, _manuscripts, _owner
    from .requirement_control import _current
    state = _current(session_id)
    turn = current_turn(session_id, state) if state else None
    from .task_requirement_extract import _clauses
    explicit = turn and any(re.match(r'^(?:(?:请|先|帮我|把|将|立即|现在|直接|然后)\s*)*(?:保存|另存|存稿|归档|导出)', clause)
                            for clause in _clauses(turn['request']))
    if not explicit or not _auto_capture_allowed(turn['request']):
        return False
    if turn['task'].get('read_only') or turn['task'].get('correction_only'):
        return False
    expected = content.replace('\r\n', '\n').strip()
    owner = _owner(session_id)
    eligible = {identifier for prior in history_turns(session_id) for identifier in prior['assistant_ids']}
    for row in reversed(_history(session_id)):
        if (str(row.get('id')) not in eligible or row.get('role') != 'assistant' or row.get('tool_calls') or row.get('display_kind') or row.get('_compressed_summary')
                or _owner(row.get('session_id', session_id)) != owner or row.get('finish_reason') not in {'stop', 'end_turn', None}
                or not isinstance(row.get('content'), str)):
            continue
        if any(expected == item['content'].replace('\r\n', '\n').strip() for item in _manuscripts(row['content'])):
            return True
    return False

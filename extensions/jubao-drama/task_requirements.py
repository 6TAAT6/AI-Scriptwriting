"""按账号与合法会话链保存用户合同；本模块不选择Agent、不修改系统缓存。"""
from contextlib import closing
from copy import deepcopy
import hashlib
import json
import re

from hermes_constants import get_hermes_home, hermes_home_key
from plugins.plugin_storage import plugin_db

from .task_requirement_extract import extract, source_for_turn, starts_new_task

_SEMANTIC = {'world', 'forbidden_mechanism', 'locked_names', 'semantic'}
_SETTINGS = {'target_market', 'script_language', 'dialogue_language', 'prompt_language'}
_SCHEMA_VERSION = 5


def _tables(conn):
    conn.execute('CREATE TABLE IF NOT EXISTS task_requirements_state '
                 '(session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, snapshot TEXT NOT NULL)')
    conn.execute('CREATE TABLE IF NOT EXISTS task_requirements_sources '
                 '(session_id TEXT NOT NULL, turn_id TEXT NOT NULL, input_hash TEXT NOT NULL, '
                 'source TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(session_id,turn_id))')


def _lineage(session_id):
    if not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 256:
        raise ValueError('用户要求必须绑定有效会话')
    state = get_hermes_home() / 'state.db'
    if not state.is_file():
        return [session_id]
    from hermes_state import SessionDB
    with closing(SessionDB(state, read_only=True)) as database:
        return database._resume_lineage_ids(session_id)


def _empty(session_id):
    return {'revision': 0, 'schema_version': _SCHEMA_VERSION, 'profile': str(get_hermes_home().resolve()), 'home_key': hermes_home_key(),
            'session_id': session_id, 'turn_id': '', 'source': None, 'active_requirements': [],
            'semantic_requirements': [], 'settings': {}, 'current_task': {}, 'pending': [],
            'capture_status': 'empty', '_requirements': []}


def _read(conn, lineage):
    for identifier in reversed(lineage):
        row = conn.execute('SELECT snapshot FROM task_requirements_state WHERE session_id=?', (identifier,)).fetchone()
        if row:
            return json.loads(row[0])
    return _empty(lineage[-1])


def _public(state, session_id):
    result = deepcopy(state)
    result.pop('_requirements', None)
    result.pop('_continuation_task', None)
    result.pop('_source_sequence', None)
    result['session_id'] = session_id
    return result


def load_contract(session_id):
    """只读本账号合同；继承由SessionDB验证的压缩祖先，不遍历所有消息。"""
    lineage = _lineage(session_id)
    with closing(plugin_db('jubao-drama')) as conn:
        _tables(conn)
        return _public(_read(conn, lineage), session_id)


def _same_slot(item, operation):
    if (item['kind'] == operation['kind'] == 'min_words' and operation['action'] == 'cancel'
            and operation['value'] is None and operation['scope'].get('episodes') is None
            and operation['scope']['lifetime'] == item['scope']['lifetime'] == 'conversation'):
        return True
    if item['kind'] != operation['kind'] or item['scope'] != operation['scope']:
        return False
    if item['kind'] == 'source_read':
        if operation['action'] == 'cancel' and operation['value'] is None:
            return True
        return item['value'] == operation['value']
    if item['kind'] == 'forbidden_mechanism' and operation['action'] == 'cancel':
        return item['quote'].rstrip('。.!！') == str(operation['value']).rstrip('。.!！')
    if item['kind'] == 'world':
        if operation['action'] == 'cancel':
            return True
        subject, prior_subject = operation.get('subject'), item.get('subject')
        generic = {None, 'setting', 'theme'}
        if operation.get('replace') and subject in generic and prior_subject in generic:
            return True
        return subject == prior_subject and (subject not in generic or subject == 'theme' or item['quote'] == operation['quote'])
    if item['kind'] in {'forbidden_mechanism', 'semantic'}:
        return item['quote'] == operation['quote']
    return True


def _apply_source(state, source, session_id, root_id):
    turn_id = source['turn_id']
    source_sequence = state.get('_source_sequence', 0) + 1
    source['contract_source_order'] = source_sequence
    task_reset = starts_new_task(source['original_text'])
    requirements = [] if task_reset else deepcopy(state.get('_requirements', []))
    # 本轮限定项不升级成持续合同，下一轮从持久条款重新计算任务。
    changed = bool(task_reset and state.get('_requirements'))
    for item in requirements:
        if item['status'] == 'active' and item['scope']['lifetime'] == 'turn':
            item['status'] = 'expired'
            changed = True
    known_names = set()
    for item in requirements:
        if item['status'] != 'active':
            continue
        subject = item.get('subject') or ''
        if item['kind'] == 'world' and subject.startswith('character:'):
            known_names.add(subject.removeprefix('character:'))
        elif item['kind'] == 'locked_names' and isinstance(item.get('value'), list):
            known_names.update(name for name in item['value'] if isinstance(name, str))
    operations, task, pending = extract(source, {} if task_reset else state.get('_continuation_task', state.get('current_task', {})),
                                        known_names=known_names)
    source_updates = [op for op in operations if op['kind'] == 'source_read' and op['action'] == 'set']
    if source_updates and not re.search(r'追加|补充|同时参考|再参考', source['original_text']):
        # 新的一组明确资料替代当前任务旧资料；追加资料由用户明示。
        for item in requirements:
            if item['kind'] == 'source_read' and item['status'] == 'active':
                item['status'] = 'superseded'
                changed = True
    for operation in operations:
        slot = [item for item in requirements if item['status'] == 'active' and _same_slot(item, operation)]
        prior_user_choice = any(_same_slot(item, operation) and (
            item['status'] == 'active' and item.get('origin') == 'user_text'
            or item['status'] == 'cancelled' and item.get('cancel_origin') == 'user_text'
        ) for item in requirements)
        if operation['origin'] == 'studio_settings' and prior_user_choice:
            # 界面旧默认值不能在下一轮覆盖用户正文的明确覆盖要求。
            continue
        if operation['action'] == 'cancel':
            if not slot:
                pending.append({'quote': operation['quote'], 'reason': '未找到唯一作用范围内的有效要求，未扩大取消范围'})
                continue
            for item in slot:
                item['status'] = 'cancelled'
                item['cancelled_by_turn_id'] = turn_id
                item['cancel_origin'] = operation['origin']
            changed = True
            continue
        for item in requirements:
            if item['status'] in {'active', 'cancelled'} and _same_slot(item, operation):
                item['status'] = 'superseded'
        identity = json.dumps([root_id, turn_id, operation['kind'], operation.get('subject'), operation['scope'], operation['quote']], ensure_ascii=False, sort_keys=True)
        requirements.append({'id': hashlib.sha256(identity.encode()).hexdigest()[:24],
                             'kind': operation['kind'], 'value': operation['value'], 'scope': operation['scope'],
                             'quote': operation['quote'], 'source_turn_id': turn_id, 'status': 'active',
                             'origin': operation['origin'], 'subject': operation.get('subject')})
        changed = True
    # 完整历史已按来源事件保留；当前状态不反复复制所有过期修订。
    requirements = [item for item in requirements if item['status'] in {'active', 'cancelled'}]
    active = [item for item in requirements if item['status'] == 'active']
    settings = {item['kind']: item['value'] for item in active if item['kind'] in _SETTINGS}
    revision = state['revision'] + int(changed)
    current = {**state, 'schema_version': _SCHEMA_VERSION, '_source_sequence': source_sequence,
               'session_id': session_id, 'turn_id': turn_id, 'revision': revision, 'source': source,
               'active_requirements': active, 'semantic_requirements': [item for item in active if item['kind'] in _SEMANTIC],
               'settings': settings, 'current_task': task, 'pending': pending,
               'capture_status': 'captured', '_requirements': requirements,
               '_continuation_task': task if task.get('creative') or task.get('read_only') and not task.get('correction_only') else ({} if task_reset else state.get('_continuation_task', {}))}
    if task_reset and current.get('bootstrap'):
        current['bootstrap'] = {**current['bootstrap'], 'status': 'verified', 'pending': [], 'new_task_turn_id': turn_id}
    return current


def _recover_legacy_events(state, lineage, events):
    """只回查此前明确未识别的历史行，不重新吸收用户后来补录的无关消息。"""
    pending = state.get('bootstrap', {}).get('pending', [])
    requested = {row['message_row_id'] for row in pending if type(row.get('message_row_id')) is int}
    if not requested or not (get_hermes_home() / 'state.db').is_file():
        return [], set()
    # 插入遗漏事件必须能够与原账本严格排序；来源没有原消息位置时保留待核验。
    if any(type(source.get('message_row_id')) is not int for _, _, source in events):
        return [], set()
    from hermes_state import SessionDB
    sources, recovered = [], set()
    identifiers = ','.join('?' for _ in requested)
    sessions = ','.join('?' for _ in lineage)
    with closing(SessionDB(get_hermes_home() / 'state.db', read_only=True)) as database:
        rows = database._read_all('SELECT m.id,m.session_id,m.role,m.content,m.message_uid,m._compressed_summary,'
            'm.display_kind,m.display_metadata,s.source AS _session_source FROM messages m JOIN sessions s ON s.id=m.session_id '
            f'WHERE m.session_id IN ({sessions}) AND m.id IN ({identifiers}) AND m.role=? '
            'AND (m.active=1 OR m.compacted=1) ORDER BY m.id', (*lineage, *sorted(requested), 'user'))
        for record in rows:
            row = dict(record)
            row['_row_id'] = row.pop('id')
            row['content'] = database._decode_content(row['content'])
            row['display_metadata'] = database._decode_display_metadata(row['display_metadata'])
            source = source_for_turn(row['content'], [row], f"history:{row.get('message_uid') or row['_row_id']}", allow_legacy=True)
            if source is None or not source.get('legacy_provenance'):
                continue
            source['origin'] = 'persisted_user_row'
            sources.append((lineage[-1], source['turn_id'], source))
            recovered.add(row['_row_id'])
    return sources, recovered


def _upgrade_contract(conn, state, lineage):
    """旧合同只重放本账号合法会话链已验证的来源事件，包含取消与纠正的原始顺序。"""
    if state.get('schema_version') == _SCHEMA_VERSION or state['capture_status'] == 'empty':
        return state
    placeholders = ','.join('?' for _ in lineage)
    stored_events = conn.execute('SELECT session_id,turn_id,source FROM task_requirements_sources '
                          f'WHERE session_id IN ({placeholders}) ORDER BY rowid LIMIT 2049', lineage).fetchall()
    if not stored_events or len(stored_events) > 2048 or sum(len(row[2]) for row in stored_events) > 8_000_000:
        pending = {'quote': '', 'reason': '旧合同来源缺失或超过本次升级核验范围，旧要求保留，尚未完成完整要求升级'}
        state['bootstrap'] = {**state.get('bootstrap', {}), 'status': 'unverified',
                              'pending': [*state.get('bootstrap', {}).get('pending', []), pending]}
        state['schema_version'] = _SCHEMA_VERSION
        return state
    events = [(sid, turn, json.loads(raw)) for sid, turn, raw in stored_events]
    if all(type(source.get('contract_source_order')) is int for _, _, source in events):
        events.sort(key=lambda event: event[2]['contract_source_order'])
    restored, recovered = _recover_legacy_events(state, lineage, events)
    existing = {(sid, turn) for sid, turn, _ in events}
    events += [event for event in restored if event[:2] not in existing]
    if recovered:
        events.sort(key=lambda event: event[2]['message_row_id'])
    bootstrap = deepcopy(state.get('bootstrap'))
    if bootstrap and recovered:
        bootstrap['pending'] = [row for row in bootstrap.get('pending', []) if row.get('message_row_id') not in recovered]
        bootstrap['status'] = 'unverified' if bootstrap['pending'] else 'verified'
        bootstrap['recovered_legacy_message_ids'] = sorted(recovered)
        bootstrap['replayed_user_turns'] = len(events)
    upgraded = _empty(lineage[-1])
    if bootstrap:
        upgraded['bootstrap'] = bootstrap
    snapshots = []
    replay_pending = list(bootstrap.get('pending', [])) if bootstrap else []
    for session_id, turn_id, source in events:
        if starts_new_task(source['original_text']):
            replay_pending.clear()
        upgraded = _apply_source(upgraded, source, session_id, lineage[0])
        upgraded['revision'] = max(upgraded['revision'], state['revision'])
        for issue in upgraded['pending']:
            if issue not in replay_pending:
                replay_pending.append(issue)
        if upgraded.get('bootstrap'):
            upgraded['bootstrap'] = {**upgraded['bootstrap'], 'pending': list(replay_pending),
                                     'status': 'unverified' if replay_pending else 'verified'}
        upgraded['pending'] = list(replay_pending)
        snapshots.append((session_id, turn_id, source['input_sha256'], json.dumps(source, ensure_ascii=False),
                          json.dumps(upgraded, ensure_ascii=False, sort_keys=True)))
    conn.executemany('INSERT INTO task_requirements_sources VALUES(?,?,?,?,?) ON CONFLICT(session_id,turn_id) '
                     'DO UPDATE SET source=excluded.source,snapshot=excluded.snapshot', snapshots)
    encoded = json.dumps(upgraded, ensure_ascii=False, sort_keys=True)
    conn.execute('INSERT INTO task_requirements_state VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE '
                 'SET revision=excluded.revision,snapshot=excluded.snapshot', (lineage[-1], upgraded['revision'], encoded))
    return upgraded


def _bootstrap(state, lineage, history, current_source, conn):
    """首次建档只重放合法压缩链的原始user行；以后的轮次只读持久合同。"""
    from agent.context_compressor import ContextCompressor, MODEL_ONLY_DISPLAY_METADATA_KEY
    from hermes_state import SessionDB
    path = get_hermes_home() / 'state.db'
    rows = []
    if path.is_file():
        placeholders = ','.join('?' for _ in lineage)
        with closing(SessionDB(path, read_only=True)) as database:
            records = database._read_all(
                'SELECT m.id,m.role,m.content,m.message_uid,m._compressed_summary,m.display_kind,m.display_metadata,s.source AS _session_source '
                f'FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.session_id IN ({placeholders}) AND m.role=? '
                'AND (m.active=1 OR m.compacted=1) ORDER BY m.id', (*lineage, 'user'))
            for record in records:
                row = dict(record)
                row['_row_id'] = row.pop('id')
                row['content'] = database._decode_content(row['content'])
                row['display_metadata'] = database._decode_display_metadata(row['display_metadata'])
                rows.append(row)
    origin = 'persisted_user_row' if rows else 'runtime_history'
    if not rows:
        # 宿主已核对最后一条user是本轮；它由capture独立应用，不在补建时重放。
        current_index = max((i for i, row in enumerate(history) if isinstance(row, dict) and row.get('role') == 'user'), default=0)
        rows = history[:current_index]
    pending, seen, count = [], set(), 0
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or row.get('role') != 'user':
            continue
        if ((current_source.get('message_uid') and row.get('message_uid') == current_source['message_uid'])
                or (current_source.get('message_row_id') and row.get('_row_id') == current_source['message_row_id'])):
            continue
        if origin == 'runtime_history' and ContextCompressor._is_context_summary_message(row):
            pending.append({'quote': '', 'reason': '仅剩压缩摘要，缺少此前完整用户原文，旧任务约束尚未完全核实'})
        if (row.get('display_kind') or (row.get('display_metadata') or {}).get(MODEL_ONLY_DISPLAY_METADATA_KEY)
                or ContextCompressor._is_synthetic_compression_user_turn(row)):
            continue
        identity = row.get('message_uid') or row.get('_row_id') or f'runtime-{index}'
        if identity in seen:
            continue
        seen.add(identity)
        historical = source_for_turn(row.get('content'), [row], f'history:{identity}', allow_legacy=origin == 'persisted_user_row')
        if historical is None:
            pending.append({'quote': '', 'reason': '历史用户行缺少可信原文边界，未从附件或合成内容推断要求', 'message_row_id': row.get('_row_id')})
            continue
        historical['origin'] = origin
        if starts_new_task(historical['original_text']):
            pending.clear()
        state = _apply_source(state, historical, lineage[-1], lineage[0])
        pending.extend(state['pending'])
        conn.execute('INSERT OR IGNORE INTO task_requirements_sources VALUES(?,?,?,?,?)',
                     (lineage[-1], historical['turn_id'], historical['input_sha256'],
                      json.dumps(historical, ensure_ascii=False), json.dumps(state, ensure_ascii=False, sort_keys=True)))
        count += 1
    if re.fullmatch(r'(?:请)?继续(?:写|下一集|上一任务|下一批)?[。！!\s]*', current_source['original_text']) and not count:
        pending.append({'quote': current_source['original_text'], 'reason': '缺少可核验的旧用户任务原文，不能从摘要猜测继续目标与约束'})
    state['bootstrap'] = {'status': 'unverified' if pending else 'verified', 'source': origin,
                          'replayed_user_turns': count, 'pending': pending}
    return state


def capture_turn(user_message, conversation_history, session_id, turn_id):
    """宿主pre_llm调用即是来源事件，用户DB行可稍后落盘；同轮只应用一次。"""
    if not isinstance(turn_id, str) or not turn_id or len(turn_id) > 512:
        return {**load_contract(session_id), 'capture_status': 'missing_turn_id'}
    from agent.delegation_context import is_delegated_child_context
    if is_delegated_child_context():
        return {**load_contract(session_id), 'capture_status': 'delegated_read_only'}
    lineage = _lineage(session_id)
    source = source_for_turn(user_message, conversation_history, turn_id)
    if source is None:
        return {**load_contract(session_id), 'capture_status': 'untrusted_source'}
    with closing(plugin_db('jubao-drama')) as conn:
        _tables(conn)
        conn.execute('BEGIN IMMEDIATE')
        state = _upgrade_contract(conn, _read(conn, lineage), lineage)
        for identifier in reversed(lineage):
            row = conn.execute('SELECT input_hash,snapshot FROM task_requirements_sources WHERE session_id=? AND turn_id=?',
                               (identifier, turn_id)).fetchone()
            if row:
                if row[0] != source['input_sha256']:
                    raise ValueError('同一回合的用户原文已改变，不能重复修改合同')
                conn.commit()
                return _public(json.loads(row[1]), session_id)
        if state['capture_status'] == 'empty':
            state = _bootstrap(state, lineage, conversation_history, source, conn)
        current = _apply_source(state, source, session_id, lineage[0])
        current['pending'] = [*current.get('bootstrap', {}).get('pending', []), *current['pending']]
        encoded = json.dumps(current, ensure_ascii=False, sort_keys=True)
        conn.execute('INSERT INTO task_requirements_state VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE '
                     'SET revision=excluded.revision,snapshot=excluded.snapshot', (session_id, current['revision'], encoded))
        conn.execute('INSERT INTO task_requirements_sources VALUES(?,?,?,?,?)',
                     (session_id, turn_id, source['input_sha256'], json.dumps(source, ensure_ascii=False), encoded))
        conn.commit()
        return _public(current, session_id)


def render_context(snapshot):
    """生成只附加到当前用户轮的执行依据，不写system或历史消息。"""
    if not isinstance(snapshot, dict) or not (snapshot.get('active_requirements') or snapshot.get('pending')):
        return ''
    rows = []
    for item in snapshot['active_requirements']:
        rows.append({'id': item['id'], 'kind': item['kind'], 'subject': item.get('subject'), 'value': item['value'], 'scope': item['scope'], 'quote': item['quote']})
    task = {key: value for key, value in (snapshot.get('current_task') or {}).items() if key != 'source_query'}
    return ('【本会话用户要求合同】\n以下为宿主记录的真实用户要求；仅适用于其范围，用户新决定优先。'
            '确定性指标由稿件检查核验；世界、禁用机制和锁名仍需有原文证据的语义审稿，不把保存成功称为达标。\n'
            + json.dumps({'revision': snapshot['revision'], 'current_task': task,
                          'settings': snapshot.get('settings'), 'requirements': rows, 'pending': snapshot.get('pending')}, ensure_ascii=False))

"""每份生成内容各有一次自动修订；原始用户身份只负责隔离和续跑归属。"""
from contextlib import closing
import hashlib
import json

from plugins.plugin_storage import plugin_db


def cycle(state):
    source = state.get('contract', {}).get('source') or {}
    row = (state.get('delivery_input') or {}).get('row') or {}
    uid = source.get('message_uid') or row.get('message_uid')
    row_id = source.get('message_row_id') or row.get('_row_id')
    from .creative_scope import lineage
    session_id = str((state.get('contract') or {}).get('session_id') or '')
    owner = lineage(session_id)[0] if session_id else ''
    identity = 'uid:' + uid if uid else 'row:' + str(row_id) if row_id else 'turn:' + state['turn_id']
    key = owner + '|' + identity
    cached = state.get('revision_cycle')
    if cached and cached['source_key'] == key:
        return cached
    with closing(plugin_db('jubao-drama')) as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS requirement_revision_cycles (source_key TEXT PRIMARY KEY,payload TEXT NOT NULL)')
        saved = conn.execute('SELECT payload FROM requirement_revision_cycles WHERE source_key=?', (key,)).fetchone()
    current = json.loads(saved[0]) if saved else {'source_key': key, 'targets': {}, 'revised': {}}
    # 已发布旧版的续跑仍保留真实领取记录，只把全局标志收窄到当时存在的目标。
    for identifier, target in current['targets'].items():
        target.setdefault('review_requested', bool(current.get('review_requested')))
        target.setdefault('repair_requested', identifier in current['revised'] or
                          bool(current.get('repair_requested') and (target.get('report') or {}).get('status') == 'fail'))
    for obsolete in ('phase', 'review_requested', 'repair_requested'):
        current.pop(obsolete, None)
    state['revision_cycle'] = current
    return current


def persist(state):
    current = cycle(state)
    with closing(plugin_db('jubao-drama')) as conn:
        conn.execute('INSERT OR REPLACE INTO requirement_revision_cycles VALUES (?,?)',
                     (current['source_key'], json.dumps(current, ensure_ascii=False)))
        conn.commit()


def target_id(state, document_id=None, *, content=None, kind=None):
    if not state:
        return None
    current = cycle(state)
    if document_id in current['targets']:
        return document_id
    for identifier, revision in current['revised'].items():
        if revision['document_id'] == document_id:
            return identifier
    if not isinstance(content, str):
        return None
    digest = hashlib.sha256(content.encode()).hexdigest()
    matching = [identifier for identifier, target in current['targets'].items()
                if target['kind'] == kind and digest in {target['digest'], current['revised'].get(identifier, {}).get('digest')}]
    return matching[0] if len(matching) == 1 else None


def repairing(state, document_id=None, *, content=None, kind=None):
    identifier = target_id(state, document_id, content=content, kind=kind)
    return bool(identifier and identifier in cycle(state)['revised'])


def track_document(state, document):
    if not state or document.get('kind') == 'internal':
        return
    current = cycle(state)
    identifier = target_id(state, document['id'], content=document['content'], kind=document['kind'])
    if identifier:
        return
    from .requirement_checks import _episodes
    current['targets'][document['id']] = {'name': document['name'], 'kind': document['kind'],
        'digest': hashlib.sha256(document['content'].encode()).hexdigest(),
        'episodes': [row['episode_number'] for row in _episodes(document['content'])],
        'review_requested': False, 'repair_requested': False}
    persist(state)


def begin_repair(state, session_id, document_ids=None):
    """只领取尚未安排过修改的失败目标，其他稿件的许可保持独立。"""
    current = cycle(state)
    selected = {target_id(state, identifier) for identifier in document_ids} if document_ids is not None else set(current['targets'])
    requested = []
    with closing(plugin_db('jubao-drama')) as conn:
        for identifier, target in current['targets'].items():
            if identifier not in selected or target['repair_requested'] or identifier in current['revised']:
                continue
            row = conn.execute('SELECT report FROM agent_document_quality WHERE document_id=?', (identifier,)).fetchone()
            report = json.loads(row[0]) if row else {}
            if report.get('status') != 'fail' or report.get('revisions_remaining', 0) <= 0:
                continue
            target.update(repair_requested=True, report=report)
            requested.append({'document_id': identifier, 'name': target['name'], 'report': report})
    if requested:
        persist(state)
    return requested


def prepare_save(state, session_id, agent_id, name, kind, content):
    """独立新稿照常保存；同名或同批集号的修改归回原稿，最多保留一版修订。"""
    if not state or kind == 'internal':
        return name, None, None
    current = cycle(state)
    digest = hashlib.sha256(content.encode()).hexdigest()
    targets = current['targets']
    from .requirement_checks import _episodes
    episodes = {row['episode_number'] for row in _episodes(content)}
    matching = [identifier for identifier, target in targets.items()
                if target['kind'] == kind and target['name'] == name
                and (not episodes or not target['episodes'] or set(target['episodes']) == episodes)]
    if not matching:
        last = state.get('last') or {}
        failed_last = target_id(state, last.get('document_id')) if (last.get('report') or {}).get('status') == 'fail' else None
        if episodes:
            matching = [identifier for identifier, target in targets.items()
                        if target['kind'] == kind and set(target['episodes']) == episodes
                        and (target['repair_requested'] or identifier in current['revised'] or identifier == failed_last)]
    if not matching:
        return name, None, None
    if len(matching) != 1:
        raise ValueError('这份修改未能唯一对应原稿，不能借用其他稿件的回执。请沿用要修改的原稿名称。')
    identifier = matching[0]
    target = targets[identifier]
    revision = current['revised'].get(identifier)
    if digest == target['digest']:
        return target['name'], identifier, None
    if revision:
        return target['name'], revision['document_id'], None
    return target['name'], None, identifier


def saved_revision(state, target, document_id, content):
    if not target:
        return
    current = cycle(state)
    current['targets'][target]['repair_requested'] = True
    current['revised'][target] = {'document_id': document_id, 'digest': hashlib.sha256(content.encode()).hexdigest()}
    persist(state)


def request_review(state, document_ids):
    current = cycle(state)
    requested = []
    for document_id in document_ids:
        identifier = target_id(state, document_id)
        target = current['targets'].get(identifier)
        if not target or target['review_requested'] or identifier in current['revised']:
            continue
        target['review_requested'] = True
        requested.append(document_id)
    if requested:
        persist(state)
    return requested


def guidance(report, session_id=None, *, offer_revision=True):
    """真实工具回执可就地安排一次修改，不必为了下一份稿件增加停止钩子轮数。"""
    if report.get('revisions_remaining', 0) == 0:
        return ('这份稿件的一次修改已结束，不再检查、改写或另存它的新版本；其他独立内容仍按各自流程交付。'
                '用一两句话说明实际改动和需要用户决定的事实，不输出通过、未通过或达标标签，不再复述全文。')
    if offer_revision and session_id and report.get('status') == 'fail':
        from .requirement_control import _current, _feedback
        state = _current(session_id)
        requested = begin_repair(state, session_id, [report.get('document_id')]) if state else []
        if requested:
            return ('这份稿件仅做一次定向修改。先用一句话流式说明修改什么，接着在同一条回复里写出修改后的正文'
                    '（只写需要改的部分，未改的集不重写），再沿用原名用 from_reply=true 保存；只写说明就保存不会被接受。'
                    '修改后不再自查；其他独立稿件保留自己的首次核验和一次修改机会。\n' + _feedback(report))
    return ('当前稿件已保存，继续完成用户原定交付；不要重复检查同稿，也不要把其他稿件的状态套到本稿。'
            '面向用户只说明实际内容和修改，不输出通过、未通过或达标标签。')

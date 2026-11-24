"""本轮待交付稿件的核验顺序；只保存精确身份，状态从持久化回执读取。"""
from contextlib import closing
import hashlib
import json

from plugins.plugin_storage import plugin_db


def track(state, document, session_id):
    if state is None:
        return
    with state['validation_lock']:
        pending = state.setdefault('delivery_checks', {})
        with closing(plugin_db('jubao-drama')) as conn:
            current = conn.execute("SELECT session_id,agent_id,name FROM agent_documents WHERE id=?",
                                   (document['id'],)).fetchone()
            if not current:
                return
            owner_session, owner, name = current
            versions = conn.execute(
                "SELECT d.id,d.rowid,current.rowid FROM agent_documents d JOIN agent_document_delivery e ON e.document_id=d.id "
                "JOIN agent_documents current ON current.id=? "
                "WHERE d.session_id=? AND d.agent_id=? AND d.name=? AND e.kind=?",
                (document['id'], owner_session, owner, name, document['kind'])).fetchall()
        from .requirement_revision import target_id
        target=target_id(state,document['id'])
        if target:
            versions=[row for row in versions if target_id(state,row[0])==target]
        if any(identifier in pending and rowid > current for identifier, rowid, current in versions):
            return
        previous = pending.get(document['id'])
        for identifier, rowid, current in versions:
            if rowid <= current:
                pending.pop(identifier, None)
        digest = hashlib.sha256(document['content'].encode()).hexdigest()
        pending[document['id']] = {'content_sha256': digest,
                                   'kind': document['kind'], 'owner_session': owner_session, 'agent_id': owner,
                                   'check_requested': bool(previous and previous['content_sha256'] == digest
                                                           and previous.get('check_requested'))}


def draft_identity(document_id, session_id, kind):
    from .requirement_control import _current
    from .requirement_revision import target_id
    target=target_id(_current(session_id),document_id) if document_id else None
    if target:
        return ('document',target)
    if document_id:
        from .creative_scope import lineage
        allowed = lineage(session_id)
        with closing(plugin_db('jubao-drama')) as conn:
            row = conn.execute("SELECT agent_id,name,session_id FROM agent_documents WHERE id=?",
                               (document_id,)).fetchone()
        if row and row[2] in allowed:
            return (kind, row[0], row[1], row[2])
    return (kind,)


def next_review(state, session_id):
    with state['validation_lock']:
        return _next_review(state, session_id)


def _next_review(state, session_id):
    """先处理失败稿件，再一次性请求本轮所有待核验稿件；不在钩子里调用模型。"""
    from .capability_selection import document_owner
    from .agent_documents import _reading_scope
    from .agent_document_delegation import delegated_document_ids
    from .requirement_control import _needs_semantic_check

    from . import requirement_revision
    entries = state.get('delivery_checks', {})
    if not entries:
        return None
    owner = document_owner(session_id)
    scope = _reading_scope(session_id, owner)
    delegated = delegated_document_ids(owner, scope)
    records = []
    with closing(plugin_db('jubao-drama')) as conn:
        for identifier, expected in entries.items():
            row = conn.execute(
                "SELECT d.content,q.content_sha256,q.report FROM agent_documents d "
                "JOIN agent_document_quality q ON q.document_id=d.id "
                "WHERE d.id=? AND d.agent_id=? AND (d.session_id IN (" + ','.join('?' for _ in scope)
                + ") OR d.id IN (" + ','.join('?' for _ in delegated) + "))",
                (identifier, owner, *scope, *delegated)).fetchone()
            if row and row[1] == expected['content_sha256'] == hashlib.sha256(row[0].encode()).hexdigest():
                records.append((identifier, expected, row[0], json.loads(row[2])))
    calls = []
    for identifier, expected, content, report in records:
        kind = expected['kind']
        if requirement_revision.repairing(state,identifier) or not _needs_semantic_check(report):
            continue
        # 范围超限等确定性阻塞不会因重复 check 恢复；回执和失败说明仍保持未核验。
        if any(issue.get('code') == 'review_scope_too_large' for issue in report.get('issues', [])):
            continue
        if expected.get('check_requested'):
            continue
        calls.append({'action': 'check', 'document_id': identifier})
    allowed=requirement_revision.request_review(state,[row['document_id'] for row in calls]) if calls else []
    calls=[row for row in calls if row['document_id'] in allowed]
    for identifier in allowed:
        entries[identifier]['check_requested']=True
    if calls:
        return {'action': 'continue', 'message': '【系统核验｜本轮继续】以下已保存稿件尚缺独立语义核验。'
                '保持正文不变，对列表中每个参数分别调用一次 drama_agent_document：'
                + json.dumps(calls, ensure_ascii=False) + '。全部取得真实核验结果后再收尾；'
                '按各稿工具回执仅处理该稿的一次修改；已经修过的稿件不再次检查，不复述全文。'}
    exhausted = next((row for row in records if row[3].get('status') == 'fail'), None)
    if exhausted:
        identifier, expected, content, report = exhausted
        kind = expected['kind']
        state['last'] = {'document_id': identifier, 'kind': kind, 'content': content,
                         'content_sha256': hashlib.sha256(content.encode()).hexdigest(), 'report': report,
                         'evidence_fingerprint': None}
    return None

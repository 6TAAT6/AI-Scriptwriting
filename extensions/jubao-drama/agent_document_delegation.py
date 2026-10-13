"""以原生委派完成证据授权精确稿件，父会话不继承整个子会话。"""
from contextlib import closing
import json
import re

from hermes_constants import get_hermes_home
from hermes_state import SessionDB
from plugins.plugin_storage import plugin_db

from .capability_selection import document_owner

_DOCUMENT_ID = re.compile(r"(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])")


def _tables(conn):
    from .agent_documents import _tables as document_tables
    document_tables(conn)
    conn.execute("CREATE TABLE IF NOT EXISTS agent_document_delegations (parent_session_id TEXT NOT NULL, "
                 "child_session_id TEXT NOT NULL, agent_id TEXT NOT NULL, document_id TEXT NOT NULL, "
                 "PRIMARY KEY(parent_session_id,child_session_id,agent_id,document_id))")
    conn.commit()


def _owner(session_id):
    try:
        return document_owner(session_id)
    except PermissionError:
        return None


def _child_scope(database, child_id, parents):
    lineage = database._resume_lineage_ids(child_id)
    root = database.get_session(lineage[0]) if lineage else None
    if not root:
        return []
    config = root.get('model_config') or {}
    if isinstance(config, str):
        try:
            config = json.loads(config)
        except ValueError:
            return []
    if (not isinstance(config, dict) or config.get('_branched_from') == root.get('parent_session_id') or config.get('_reset_from') == root.get('parent_session_id')
            or root.get('parent_session_id') not in parents
            or config.get('_delegate_from') != root.get('parent_session_id')):
        return []
    # 原生子代理会继承 web/tui 等来源；source 不能代替明确的委派标记。
    return lineage


def _grant(database, parent, child, owner, identifiers):
    if not identifiers or _owner(parent) != owner or _owner(child) != owner:
        return
    parents = database._resume_lineage_ids(parent)
    children = [sid for sid in _child_scope(database, child, parents) if _owner(sid) == owner]
    if not children:
        return
    with closing(plugin_db('jubao-drama')) as conn:
        _tables(conn)
        docs = conn.execute("SELECT id,session_id FROM agent_documents WHERE agent_id=? AND id IN ("
                            + ','.join('?' for _ in identifiers) + ") AND session_id IN ("
                            + ','.join('?' for _ in children) + ')', (owner, *identifiers, *children)).fetchall()
        conn.executemany('INSERT OR IGNORE INTO agent_document_delegations VALUES (?,?,?,?)',
                         [(parent, sid, owner, identifier) for identifier, sid in docs])
        conn.commit()


def on_subagent_stop(*, parent_session_id=None, child_session_id=None, child_status=None, child_summary=None, **_kwargs):
    if child_status != 'completed' or not isinstance(child_summary, str):
        return
    ids = list(dict.fromkeys(_DOCUMENT_ID.findall(child_summary)))
    state = get_hermes_home() / 'state.db'
    owner = _owner(parent_session_id)
    if not ids or not owner or not state.is_file():
        return
    with closing(SessionDB(state, read_only=True)) as database:
        _grant(database, parent_session_id, child_session_id, owner, ids)


def _decoded(value, fallback):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return fallback
    return value


def _spawn_count(call):
    function = call.get('function')
    if not isinstance(function, dict) or function.get('name') != 'delegate_task':
        return 0
    args = _decoded(function.get('arguments'), {})
    if not isinstance(args, dict) or args.get('action') not in (None, 'spawn'):
        return 0
    tasks = args.get('tasks')
    return len(tasks) if isinstance(tasks, list) else 1 if isinstance(args.get('goal'), str) and args['goal'].strip() else 0


def _returned_child(database, parent, summary):
    # 历史回执没有稳定 child ID 时，只用真实子会话的精确完成正文唯一归属；不猜 task 顺序。
    parents = database._resume_lineage_ids(parent)
    candidates = database._read_all("SELECT id FROM sessions WHERE json_extract(model_config,'$._delegate_from') IN ("
                                    + ','.join('?' for _ in parents) + ')', parents)
    children = [row[0] for row in candidates if _child_scope(database, row[0], parents)]
    if not children:
        return None
    rows = database._read_all(
        "SELECT DISTINCT m.session_id FROM messages m WHERE m.session_id IN (" + ','.join('?' for _ in children) + ') '
        "AND m.role='assistant' AND m.content=? AND m.tool_calls IS NULL "
        "AND (m.active=1 OR m.compacted=1) AND (m.display_kind IS NULL OR m.display_kind='') "
        "AND (m.finish_reason IS NULL OR m.finish_reason NOT IN ('length','error','cancelled','interrupted','failed'))",
        (*children, summary),
    )
    return rows[0][0] if len(rows) == 1 else None


def _legacy_deliveries(database, parents, owner):
    """只读原生 spawn 调用与结果，避免每次翻页重新载入整段长篇历史。"""
    for parent in parents:
        rows = database._read_all(
            "SELECT role,tool_calls,tool_call_id,tool_name,CASE WHEN role='tool' THEN content END "
            "FROM messages WHERE session_id=? AND (active=1 OR compacted=1) "
            "AND (display_kind IS NULL OR display_kind='') "
            "AND ((role='assistant' AND tool_calls IS NOT NULL AND instr(tool_calls,'delegate_task')>0) "
            "OR (role='tool' AND tool_name='delegate_task')) ORDER BY id", (parent,),
        )
        calls = {}
        for role, raw_calls, call_id, name, raw in rows:
            if role == 'assistant':
                for call in _decoded(raw_calls, []) or []:
                    if isinstance(call, dict) and call.get('id') and (count := _spawn_count(call)):
                        calls[call['id']] = count
                continue
            count = calls.pop(call_id, 0)
            if not count:
                continue
            if isinstance(raw, str) and raw.startswith('<persisted-output>'):
                from .agent_delivery import _read_spillover_receipt
                raw = _read_spillover_receipt(raw)
            result = _decoded(raw, {})
            if not isinstance(result, dict) or not isinstance(result.get('results'), list):
                continue
            for entry in result['results']:
                if (not isinstance(entry, dict) or entry.get('status') != 'completed'
                        or type(entry.get('task_index')) is not int or not 0 <= entry['task_index'] < count
                        or not isinstance(entry.get('summary'), str)):
                    continue
                summary = entry['summary']
                ids = list(dict.fromkeys(_DOCUMENT_ID.findall(summary)))
                if ids and (child := _returned_child(database, parent, summary)):
                    _grant(database, parent, child, owner, ids)


def delegated_document_ids(owner, parents):
    state = get_hermes_home() / 'state.db'
    if not parents or not state.is_file():
        return []
    with closing(plugin_db('jubao-drama')) as conn:
        _tables(conn)
    with closing(SessionDB(state, read_only=True)) as database:
        _legacy_deliveries(database, parents, owner)
        with closing(plugin_db('jubao-drama')) as conn:
            _tables(conn)
            rows = conn.execute('SELECT g.parent_session_id,g.child_session_id,g.document_id FROM agent_document_delegations g '
                                'JOIN agent_documents d ON d.id=g.document_id AND d.session_id=g.child_session_id AND d.agent_id=g.agent_id '
                                'WHERE g.agent_id=? AND g.parent_session_id IN (' + ','.join('?' for _ in parents) + ')',
                                (owner, *parents)).fetchall()
        return list(dict.fromkeys(identifier for parent, child, identifier in rows
                    if _owner(parent) == owner and _owner(child) == owner and _child_scope(database, child, parents)))

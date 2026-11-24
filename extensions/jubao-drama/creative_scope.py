"""会话到创作范围的绑定：同一侧栏项目共享要求清单与设定库，未归项目的聊天以会话链根为范围。

范围只在当前账号的 plugin 数据库内解析，项目标识来自本账号前端随消息发送的创作设置，
不能指向其他账号的数据；压缩续接的子会话沿父链继承同一范围。
"""

from __future__ import annotations

from contextlib import closing
import json
import re
import time

from hermes_constants import get_hermes_home
from plugins.plugin_storage import plugin_db

_PROJECT_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SETTINGS = re.compile(r"\n【本轮创作设置】\n([^\n]+)")


def _table(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS creative_scopes (session_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, updated_at REAL NOT NULL)")


def lineage(session_id: str) -> list[str]:
    """由 SessionDB 验证的压缩祖先链，按祖先到当前排列；状态库缺失时只含当前会话。"""
    if not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 256:
        raise ValueError("创作范围必须绑定有效会话")
    state = get_hermes_home() / "state.db"
    if not state.is_file():
        return [session_id]
    from hermes_state import SessionDB
    with closing(SessionDB(state, read_only=True)) as database:
        return database._resume_lineage_ids(session_id) or [session_id]


def project_from_message(user_message) -> str | None:
    """只读取前端控制区里的项目标识；正文中出现的同名文字不会被当成设置。"""
    if not isinstance(user_message, str) or "\n\n【用户本轮消息】\n" not in user_message:
        return None
    control = user_message.split("\n\n【用户本轮消息】\n", 1)[0]
    match = _SETTINGS.search(control)
    if not match:
        return None
    try:
        settings = json.loads(match[1])
    except ValueError:
        return None
    value = settings.get("project_id") if isinstance(settings, dict) else None
    if value is None:
        return ""
    return value if isinstance(value, str) and _PROJECT_ID.match(value) else None


def bind(session_id: str, project_id: str | None) -> None:
    """记录本轮的项目归属；``None`` 表示消息未声明，保留已有绑定。"""
    if project_id is None:
        return
    scope = "project:" + project_id if project_id else "chat:" + lineage(session_id)[0]
    with closing(plugin_db("jubao-drama")) as conn:
        _table(conn)
        conn.execute("INSERT INTO creative_scopes VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET "
                     "scope_id=excluded.scope_id, updated_at=excluded.updated_at", (session_id, scope, time.time()))
        conn.commit()


def scope_for(session_id: str) -> str:
    chain = lineage(session_id)
    with closing(plugin_db("jubao-drama")) as conn:
        _table(conn)
        for identifier in reversed(chain):
            row = conn.execute("SELECT scope_id FROM creative_scopes WHERE session_id=?", (identifier,)).fetchone()
            if row:
                return row[0]
    return "chat:" + chain[0]

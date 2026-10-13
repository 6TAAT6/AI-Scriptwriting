"""三个按需加载的剧本 Agent 及其会话绑定。"""

from __future__ import annotations

from pathlib import Path
from contextlib import closing
import sqlite3
import time
import json

from plugins.plugin_storage import plugin_db


_ROOT = Path(__file__).resolve().parent / "skills"
CAPABILITIES = {row["id"]: row for row in json.loads((_ROOT.parent / "capabilities.json").read_text(encoding="utf-8"))}
AGENT_PROFILES = {key: row for key, row in CAPABILITIES.items() if row["kind"] == "agent"}

_BY_SKILL = {
    alias: agent_id
    for agent_id, row in AGENT_PROFILES.items()
    for alias in (row["skill"], row["display_name"], *row.get("legacy_names", []))
}


def agent_for_skill(name: str) -> str | None:
    """把注册技能名和界面展示名映射到同一个剧本 Agent。"""
    if not isinstance(name, str):
        return None
    value = name.strip()
    if ":" in value:
        namespace, value = value.split(":", 1)
        if namespace != "jubao-drama":
            return None
    return _BY_SKILL.get(value)


def display_name(agent_id: str) -> str:
    try:
        return AGENT_PROFILES[agent_id]["display_name"]
    except KeyError:
        raise ValueError("未知剧本 Agent") from None


def _table(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS drama_agent_sessions (
            session_id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            updated_at REAL NOT NULL
        )
        """
    )
    conn.execute("CREATE TABLE IF NOT EXISTS drama_agent_requests (session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, updated_at REAL NOT NULL)")


def active_agent(session_id: str) -> str | None:
    if not isinstance(session_id, str) or not session_id.strip():
        return None
    from hermes_constants import get_hermes_home
    state = get_hermes_home() / "state.db"
    parents = None
    try:
        if state.is_file():
            parents = sqlite3.connect(state.as_uri() + "?mode=ro", uri=True)
        with closing(plugin_db("jubao-drama")) as conn:
            _table(conn)
            seen = set()
            while session_id and session_id not in seen and len(seen) < 100:
                seen.add(session_id)
                row = conn.execute("SELECT agent_id FROM drama_agent_sessions WHERE session_id=?", (session_id,)).fetchone()
                if row:
                    return row[0] or None
                if parents is None:
                    break
                parent = parents.execute("SELECT parent_session_id FROM sessions WHERE id=?", (session_id,)).fetchone()
                session_id = parent[0] if parent else ""
    finally:
        if parents is not None:
            parents.close()
    return None


def activate_agent(session_id: str, agent_id: str, *, replace=False) -> str:
    if not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 256:
        raise ValueError("剧本 Agent 必须绑定到有效会话")
    if agent_id not in AGENT_PROFILES:
        raise ValueError("未知剧本 Agent")
    inherited = active_agent(session_id)
    if inherited and inherited != agent_id and not replace:
        raise ValueError("不能在同一会话混用三个剧本 Agent，请先在用户消息中选择新的 Agent")
    with closing(plugin_db("jubao-drama")) as conn:
        _table(conn)
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT agent_id FROM drama_agent_sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        if row and row[0] != agent_id and not replace:
            raise ValueError("不能在同一会话混用三个剧本 Agent，请先在用户消息中选择新的 Agent")
        conn.execute(
            "INSERT INTO drama_agent_sessions(session_id, agent_id, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(session_id) DO UPDATE SET agent_id=excluded.agent_id, updated_at=excluded.updated_at",
            (session_id, agent_id, time.time()),
        )
        conn.commit()
    return agent_id


def request_agent(session_id: str, agent_id: str) -> None:
    if agent_id not in AGENT_PROFILES or not isinstance(session_id, str) or not session_id.strip():
        return
    with closing(plugin_db("jubao-drama")) as conn:
        _table(conn)
        conn.execute("INSERT INTO drama_agent_requests VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET agent_id=excluded.agent_id, updated_at=excluded.updated_at", (session_id, agent_id, time.time()))
        conn.commit()


def deactivate_agent(session_id: str, agent_id: str) -> None:
    if not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 256:
        raise ValueError("停用 Agent 必须来自有效会话")
    if active_agent(session_id) != agent_id:
        return
    with closing(plugin_db("jubao-drama")) as conn:
        _table(conn)
        # 空绑定阻断父会话继承，避免压缩或恢复后又自动启用。
        conn.execute("INSERT INTO drama_agent_sessions VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET agent_id=excluded.agent_id, updated_at=excluded.updated_at",
                     (session_id, "", time.time()))
        conn.execute("DELETE FROM drama_agent_requests WHERE session_id=?", (session_id,))
        conn.commit()


def requested_agent(session_id: str) -> str | None:
    with closing(plugin_db("jubao-drama")) as conn:
        _table(conn)
        row = conn.execute("SELECT agent_id FROM drama_agent_requests WHERE session_id=?", (session_id,)).fetchone()
        return row[0] if row else None


def require_agent(session_id: str) -> str:
    agent_id = active_agent(session_id)
    if not agent_id:
        raise PermissionError("请先调用三个剧本 Agent 之一，再使用剧本创作工具")
    return agent_id


def activation_required() -> bool:
    from hermes_cli.config import load_config_readonly
    config = load_config_readonly()
    return (config.get("studio_security") or {}).get("require_agent_invocation") is True


def register_skills(ctx) -> None:
    for row in CAPABILITIES.values():
        skill_dir = _ROOT / row["skill"]
        if not (skill_dir / "SKILL.md").is_file():
            raise FileNotFoundError(f"剧本 Agent 规则缺失：{skill_dir / 'SKILL.md'}")
        ctx.register_skill(
            row["skill"], skill_dir / "SKILL.md",
            description=f"{row['display_name']}：{row['description']} 调用后仅在当前会话生效。",
        )

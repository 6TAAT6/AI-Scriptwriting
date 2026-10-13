"""把 Hermes 的真实人工审批回执绑定到剧本当前产物，模型参数不能成为确认凭据。"""

from __future__ import annotations

import time
import uuid
from contextvars import ContextVar

from hermes_constants import get_hermes_home


_TOOL = "drama_confirm"
_RULE_PREFIX = "jubao-drama:"
_HUMAN_SURFACES = frozenset({"gateway", "cli"})
_HUMAN_CHOICES = frozenset({"once", "session", "always"})
_GATE_LABELS = {"core": "核心期待感（H1）", "plan": "替换方案（H2）"}


def _arguments(args):
    if not isinstance(args, dict) or set(args) - {"project_id", "gate", "plan_id"}:
        raise ValueError("确认工具只接受项目、确认阶段和方案标识，不能传入批准结果或凭据。")
    project_id, gate, plan_id = (args.get("project_id"), args.get("gate"), args.get("plan_id", ""))
    if not isinstance(project_id, str) or not project_id.strip() or len(project_id) > 128:
        raise ValueError("项目标识不能为空或超过 128 个字符。")
    if gate not in _GATE_LABELS:
        raise ValueError("确认阶段必须是 core 或 plan。")
    if not isinstance(plan_id, str) or len(plan_id) > 128:
        raise ValueError("方案标识必须是最多 128 个字符的文本。")
    if (gate == "plan" and not plan_id.strip()) or (gate == "core" and plan_id):
        raise ValueError("方案确认需要指定方案；核心期待感确认不接受方案标识。")
    return project_id, gate, plan_id


def _coordinates(session_id, turn_id, tool_call_id):
    values = (session_id, turn_id, tool_call_id)
    if not all(isinstance(value, str) and value.strip() for value in values):
        raise PermissionError("当前操作缺少可信的会话、轮次或工具调用标识。")
    return values


def _home():
    return str(get_hermes_home().resolve())


def _table(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS drama_approval_challenges (
            challenge_id TEXT PRIMARY KEY,
            profile_home TEXT NOT NULL,
            project_id TEXT NOT NULL,
            gate TEXT NOT NULL,
            plan_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            core_hash TEXT NOT NULL,
            generation_revision INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            tool_call_id TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at REAL NOT NULL,
            responded_at REAL,
            consumed_at REAL,
            choice TEXT,
            surface TEXT,
            UNIQUE(profile_home, session_id, turn_id, tool_call_id)
        )
    """)


def _one(conn, sql, parameters):
    cursor = conn.execute(sql, parameters)
    row = cursor.fetchone()
    return dict(zip((column[0] for column in cursor.description), row)) if row is not None else None


def _same_target(row, target):
    return all(row[key] == target[key] for key in ("content_hash", "core_hash", "generation_revision"))


class ApprovalBridge:
    """通过正式 hooks 和 middleware 接入原生审批，不直接调用桌面私有接口。"""

    def __init__(self, store, store_for_session=None):
        self.store = store
        self.store_for_session = store_for_session
        self._execution = ContextVar("jubao_drama_confirmation_execution", default=None)

    def _store(self, session_id=""):
        return self.store_for_session(session_id) if self.store_for_session else self.store

    def pre_tool_call(self, tool_name, args, *, session_id="", turn_id="", tool_call_id="", **_kwargs):
        if tool_name != _TOOL:
            return None
        try:
            project_id, gate, plan_id = _arguments(args)
            coordinates = _coordinates(session_id, turn_id, tool_call_id)
            store = self._store(session_id)
            profile = _home()
            with store.transaction() as conn:
                _table(conn)
                target = store.gate_target(project_id, gate, plan_id, conn=conn)
                row = _one(conn, """
                    SELECT * FROM drama_approval_challenges
                    WHERE profile_home=? AND session_id=? AND turn_id=? AND tool_call_id=?
                """, (profile, *coordinates))
                if row is not None:
                    if ((row["project_id"], row["gate"], row["plan_id"]) != (project_id, gate, plan_id)
                            or not _same_target(row, target)):
                        raise PermissionError("审批对应的产物已经变化，请重新发起本阶段确认。")
                    if row["status"] == "approved":
                        return None
                    if row["status"] != "pending":
                        raise PermissionError("这次审批已经结束，不能重复使用。")
                    challenge_id = row["challenge_id"]
                else:
                    challenge_id = uuid.uuid4().hex
                    conn.execute("""
                        INSERT INTO drama_approval_challenges
                            (challenge_id, profile_home, project_id, gate, plan_id,
                             content_hash, core_hash, generation_revision,
                             session_id, turn_id, tool_call_id, status, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                    """, (challenge_id, profile, project_id, gate, plan_id,
                          target["content_hash"], target["core_hash"], target["generation_revision"],
                          *coordinates, time.time()))
            summary = str(target.get("summary") or target["content"]).strip()
            return {
                "action": "approve",
                "rule_key": _RULE_PREFIX + challenge_id,
                "message": (
                    f"请人工确认当前{_GATE_LABELS[gate]}。\n{summary}\n"
                    f"产物版本：{target['generation_revision']}\n"
                    f"产物 SHA-256：{target['content_hash']}\n"
                    "本次决定仅适用于上述产物；修改内容后需要重新确认。"
                ),
            }
        except (ValueError, PermissionError, KeyError) as exc:
            return {"action": "block", "message": str(exc)}

    def post_approval_response(self, *, pattern_key="", choice="", surface="", session_id="",
                               turn_id="", tool_call_id="", decided_by=None, coalesced=False,
                               **_kwargs):
        prefix = "plugin_rule:" + _RULE_PREFIX
        if not isinstance(pattern_key, str) or not pattern_key.startswith(prefix):
            return
        if (not isinstance(surface, str) or surface not in _HUMAN_SURFACES
                or (decided_by is not None and decided_by not in ("human", "user"))
                or not isinstance(choice, str) or coalesced):
            return
        try:
            coordinates = _coordinates(session_id, turn_id, tool_call_id)
        except PermissionError:
            return
        challenge_id = pattern_key[len(prefix):]
        store = self._store(session_id)
        with store.transaction() as conn:
            _table(conn)
            row = _one(conn, """
                SELECT * FROM drama_approval_challenges
                WHERE challenge_id=? AND profile_home=? AND session_id=? AND turn_id=? AND tool_call_id=?
            """, (challenge_id, _home(), *coordinates))
            if row is None or row["status"] != "pending":
                return
            # 自动允许不会产生此处所需的新人工回执；拒绝或取消也不构成授权。
            status = "approved" if choice in _HUMAN_CHOICES else "rejected"
            conn.execute("""
                UPDATE drama_approval_challenges
                SET status=?, choice=?, surface=?, responded_at=?
                WHERE challenge_id=? AND status='pending'
            """, (status, choice, surface, time.time(), challenge_id))

    def tool_execution(self, tool_name, args, next_call, *, session_id="", turn_id="",
                       tool_call_id="", **_kwargs):
        if tool_name != _TOOL:
            return next_call(args)
        _arguments(args)
        coordinates = _coordinates(session_id, turn_id, tool_call_id)
        token = self._execution.set((_home(), *coordinates))
        try:
            return next_call(args)
        finally:
            self._execution.reset(token)

    def confirm(self, project_id, gate, plan_id=""):
        project_id, gate, plan_id = _arguments({"project_id": project_id, "gate": gate, "plan_id": plan_id})
        binding = self._execution.get()
        if binding is None or binding[0] != _home():
            raise PermissionError("确认必须由当前机器人会话的真实工具调用发起，不能直接写入批准结果。")
        profile, session_id, turn_id, tool_call_id = binding
        store = self._store(session_id)
        with store.transaction() as conn:
            _table(conn)
            row = _one(conn, """
                SELECT * FROM drama_approval_challenges
                WHERE profile_home=? AND session_id=? AND turn_id=? AND tool_call_id=?
                  AND project_id=? AND gate=? AND plan_id=?
            """, (profile, session_id, turn_id, tool_call_id, project_id, gate, plan_id))
            if row is None or row["status"] != "approved":
                raise PermissionError(
                    "尚未收到本次产物的真实人工确认，或该回执已使用。请使用手动审批完成确认；"
                    "自动允许、关闭审批和模型声明均不能代替人工决定。"
                )
            target = store.gate_target(project_id, gate, plan_id, conn=conn)
            if not _same_target(row, target):
                raise PermissionError("审批后产物或创作版本已变化，本次回执不能用于新内容，请重新确认。")
            receipt = {
                "evidence": f"用户通过创作确认卡片确认{_GATE_LABELS[gate]}，回执 {row['challenge_id']}。",
                "challenge_id": row["challenge_id"], "profile_home": profile,
                "session_id": session_id, "turn_id": turn_id, "tool_call_id": tool_call_id,
                "surface": row["surface"], "choice": row["choice"],
                "content_hash": row["content_hash"], "core_hash": row["core_hash"],
                "generation_revision": row["generation_revision"], "approved_at": row["responded_at"],
            }
            changed = conn.execute("""
                UPDATE drama_approval_challenges SET status='consumed', consumed_at=?
                WHERE challenge_id=? AND profile_home=? AND status='approved'
            """, (time.time(), row["challenge_id"], profile)).rowcount
            if changed != 1:
                raise PermissionError("本次确认回执已经被消费，不能重复批准。")
            return store.apply_approval(project_id, gate, target, receipt, plan_id, conn=conn)

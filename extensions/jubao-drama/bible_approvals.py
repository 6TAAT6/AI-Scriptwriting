"""设定库核心变更的人工确认：复用 Hermes 原生审批卡片，确认结果绑定到本次工具调用与变更内容。"""

from __future__ import annotations

from contextlib import closing
from contextvars import ContextVar
import json
import time
import uuid

from hermes_constants import get_hermes_home
from plugins.plugin_storage import plugin_db

from . import story_bible
from .creative_scope import scope_for

TOOL = "drama_story_bible"
# 网关与前端只展示 ``plugin_rule:jubao-drama:<32位十六进制>`` 的确认卡片，其余审批一律拒绝（技术权限边界）。
# 设定提案沿用同一格式；剧本确认与设定提案各自按编号查自己的表，互不处理对方的回执。
_RULE_PREFIX = "jubao-drama:"
_HUMAN_SURFACES = frozenset({"gateway", "cli"})
_HUMAN_CHOICES = frozenset({"once", "session", "always"})


def _table(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS story_bible_proposals (id TEXT PRIMARY KEY, profile_home TEXT NOT NULL, "
                 "scope_id TEXT NOT NULL, changes TEXT NOT NULL, digest TEXT NOT NULL, session_id TEXT NOT NULL, "
                 "turn_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, status TEXT NOT NULL, created_at REAL NOT NULL, "
                 "responded_at REAL, choice TEXT, surface TEXT, UNIQUE(profile_home,session_id,turn_id,tool_call_id))")


def _home():
    return str(get_hermes_home().resolve())


def _coordinates(session_id, turn_id, tool_call_id):
    values = (session_id, turn_id, tool_call_id)
    if not all(isinstance(value, str) and value.strip() for value in values):
        raise PermissionError("设定变更缺少可信的会话、轮次或工具调用标识")
    return values


def proposal_changes(args) -> list[dict]:
    if not isinstance(args, dict) or args.get("action") != "propose":
        raise ValueError("只有 propose 需要确认")
    changes = args.get("changes")
    if not isinstance(changes, list) or not 1 <= len(changes) <= 30:
        raise ValueError("propose 需要 1 至 30 项 changes")
    return [story_bible.clean_change(change) for change in changes]


class BibleApprovalBridge:
    def __init__(self):
        self._execution = ContextVar("jubao_drama_bible_execution", default=None)

    def pre_tool_call(self, tool_name, args, *, session_id="", turn_id="", tool_call_id="", **_kwargs):
        if tool_name != TOOL or not isinstance(args, dict) or args.get("action") != "propose":
            return None
        try:
            from agent.delegation_context import is_delegated_child_context
            if is_delegated_child_context():
                raise PermissionError("子代理不能提交设定变更，请把建议交回主会话")
            coordinates = _coordinates(session_id, turn_id, tool_call_id)
            scope = scope_for(session_id)
            changes = proposal_changes(args)
            digest = story_bible.changes_digest(scope, changes)
            summary = story_bible.describe(scope, changes)
            with closing(plugin_db("jubao-drama")) as conn:
                _table(conn)
                conn.execute("BEGIN IMMEDIATE")
                row = conn.execute("SELECT id,digest,status FROM story_bible_proposals WHERE profile_home=? AND "
                                   "session_id=? AND turn_id=? AND tool_call_id=?", (_home(), *coordinates)).fetchone()
                if row and row[1] != digest:
                    raise PermissionError("确认对应的设定变更已经变化，请重新提交")
                if row and row[2] == "approved":
                    conn.commit()
                    return None
                if row and row[2] != "pending":
                    raise PermissionError("这次设定确认已经结束，不能重复使用")
                proposal = row[0] if row else uuid.uuid4().hex
                if not row:
                    conn.execute("INSERT INTO story_bible_proposals VALUES (?,?,?,?,?,?,?,?, 'pending', ?, NULL, NULL, NULL)",
                                 (proposal, _home(), scope, json.dumps(changes, ensure_ascii=False), digest, *coordinates, time.time()))
                conn.commit()
            return {"action": "approve", "rule_key": _RULE_PREFIX + proposal,
                    "message": f"请确认以下设定库变更（共 {len(changes)} 项）：\n{summary}\n\n"
                               "确认后写入设定库，之后的创作和审稿以此为准；拒绝则不写入，继续沿用现有设定。"}
        except (ValueError, PermissionError, KeyError) as exc:
            return {"action": "block", "message": str(exc)}

    def post_approval_response(self, *, pattern_key="", choice="", surface="", session_id="", turn_id="",
                               tool_call_id="", decided_by=None, coalesced=False, **_kwargs):
        prefix = "plugin_rule:" + _RULE_PREFIX
        if not isinstance(pattern_key, str) or not pattern_key.startswith(prefix):
            return
        if (surface not in _HUMAN_SURFACES or decided_by not in (None, "human", "user")
                or not isinstance(choice, str) or coalesced):
            return
        try:
            coordinates = _coordinates(session_id, turn_id, tool_call_id)
        except PermissionError:
            return
        with closing(plugin_db("jubao-drama")) as conn:
            _table(conn)
            conn.execute("UPDATE story_bible_proposals SET status=?, choice=?, surface=?, responded_at=? "
                         "WHERE id=? AND profile_home=? AND session_id=? AND turn_id=? AND tool_call_id=? AND status='pending'",
                         ("approved" if choice in _HUMAN_CHOICES else "rejected", choice, surface, time.time(),
                          pattern_key[len(prefix):], _home(), *coordinates))
            conn.commit()

    def tool_execution(self, tool_name, args, next_call, *, session_id="", turn_id="", tool_call_id="", **_kwargs):
        if tool_name != TOOL or not isinstance(args, dict) or args.get("action") != "propose":
            return next_call(args)
        token = self._execution.set((_home(), session_id, turn_id, tool_call_id))
        try:
            return next_call(args)
        finally:
            self._execution.reset(token)

    def apply(self, args) -> list[dict]:
        """只有本次工具调用对应的、内容未变的已确认提案才能写入核心设定。"""
        binding = self._execution.get()
        if binding is None or binding[0] != _home():
            raise PermissionError("设定变更必须由当前会话的真实工具调用发起")
        home, session_id, turn_id, tool_call_id = binding
        scope = scope_for(session_id)
        changes = proposal_changes(args)
        digest = story_bible.changes_digest(scope, changes)
        with closing(plugin_db("jubao-drama")) as conn:
            _table(conn)
            row = conn.execute("SELECT id,digest,status FROM story_bible_proposals WHERE profile_home=? AND session_id=? "
                               "AND turn_id=? AND tool_call_id=?", (home, session_id, turn_id, tool_call_id)).fetchone()
        if row is None or row[2] != "approved":
            raise PermissionError("尚未收到用户对这次设定变更的确认；请等待用户在确认卡片中选择")
        if row[1] != digest:
            raise PermissionError("确认后设定内容或相关条目已变化，请重新提交确认")
        # 先写设定再标记已使用：写入失败（如同名冲突）时回执仍可在修正前保持可查。
        written = story_bible.apply_changes(scope, changes, actor="approval", session_id=session_id, allow_core=True)
        with closing(plugin_db("jubao-drama")) as conn:
            _table(conn)
            conn.execute("UPDATE story_bible_proposals SET status='applied' WHERE id=? AND status='approved'", (row[0],))
            conn.commit()
        return written

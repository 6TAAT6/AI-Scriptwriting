"""当前进度：从已保存稿件直接读出最近交付了什么、覆盖第几集、是否通过核验。

模型据此判断下一步与生成建议卡片，不再凭长对话的模糊记忆猜进度（历史数据中建议卡片常常
编造“已写到第11集”之类的进度，或在用户提出修改时直接建议写下一批）。
"""

from __future__ import annotations

from contextlib import closing
import json

from plugins.plugin_storage import plugin_db

_KIND_LABELS = {"script": "剧本正文", "outline": "大纲", "analysis": "分析", "novel": "小说", "document": "文档"}
_STATUS = {"pass": "通过核验", "fail": "未通过核验", "unverified": "核验未完成"}


def render(session_id: str, *, limit: int = 6) -> str:
    from .agent_document_reading import content_metadata
    from .capability_selection import document_owner
    from .agent_documents import _reading_scope
    try:
        owner = document_owner(session_id)
    except PermissionError:
        return ""
    sessions = _reading_scope(session_id, owner)
    if not sessions:
        return ""
    with closing(plugin_db("jubao-drama")) as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='agent_documents'").fetchone():
            return ""
        quality = conn.execute("SELECT 1 FROM sqlite_master WHERE name='agent_document_quality'").fetchone()
        delivery = conn.execute("SELECT 1 FROM sqlite_master WHERE name='agent_document_delivery'").fetchone()
        kind = "COALESCE(e.kind,'document')" if delivery else "'document'"
        rows = conn.execute(
            "SELECT d.name, d.content, " + kind + (", q.report" if quality else ", NULL")
            + " FROM agent_documents d"
            + (" LEFT JOIN agent_document_delivery e ON e.document_id=d.id" if delivery else "")
            + (" LEFT JOIN agent_document_quality q ON q.document_id=d.id" if quality else "")
            + " WHERE d.agent_id=? AND d.session_id IN (" + ",".join("?" for _ in sessions) + ")"
            + " AND " + kind + "<>'internal' ORDER BY d.rowid DESC LIMIT ?",
            (owner, *sessions, limit * 3)).fetchall()
    latest, seen = [], set()
    for name, content, kind, report in rows:
        if name in seen:
            continue  # 同名稿件只看最新版本
        seen.add(name)
        status = (json.loads(report) or {}).get("status") if report else None
        episodes = content_metadata(content, name)["episode_range"]
        latest.append(f"- {name}（{_KIND_LABELS.get(kind, '文档')}，{episodes if episodes != '未识别' else '未识别集号'}"
                      + (f"，{_STATUS[status]}" if status in _STATUS else "") + "）")
        if len(latest) >= limit:
            break
    return "\n".join(latest)

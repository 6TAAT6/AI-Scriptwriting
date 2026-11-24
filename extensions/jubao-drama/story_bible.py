"""设定库：按创作范围保存世界规则、人物、关系、物件与连续性，是创作和审稿的权威设定。

核心设定（世界规则、人物、关系、关键物件）只有用户能决定：模型通过 propose 提交变更，
由原生审批卡片取得用户确认后写入；用户在资料栏的直接编辑同样生效。非核心条目（地点、
时间线与末态、次要人物、文风、备注）由模型记录，所有版本留痕，用户可以查看和撤销。
"""

from __future__ import annotations

from contextlib import closing
import hashlib
import json
import time
from uuid import uuid4

from plugins.plugin_storage import plugin_db

from .memory import MemoryRecord, story_memory

CORE = {"world_rule": "世界规则", "character": "人物", "relationship": "人物关系", "key_item": "关键物件"}
NOTES = {"location": "地点", "timeline": "时间线与末态", "minor_character": "次要人物", "style": "文风基调", "note": "备注"}
CATEGORIES = {**CORE, **NOTES}
_MAX_NAME, _MAX_CONTENT, _MAX_ALIASES = 60, 4000, 8


def _tables(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS story_bible (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, category TEXT NOT NULL, "
                 "name TEXT NOT NULL, aliases TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, "
                 "version INTEGER NOT NULL, source TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)")
    conn.execute("CREATE INDEX IF NOT EXISTS story_bible_scope ON story_bible(scope_id,status,category)")
    conn.execute("CREATE TABLE IF NOT EXISTS story_bible_history (entry_id TEXT NOT NULL, version INTEGER NOT NULL, "
                 "action TEXT NOT NULL, actor TEXT NOT NULL, snapshot TEXT NOT NULL, session_id TEXT, reason TEXT, "
                 "at REAL NOT NULL, PRIMARY KEY(entry_id,version))")


def is_core(category) -> bool:
    return category in CORE


def _entry(row):
    keys = ("id", "scope_id", "category", "name", "aliases", "content", "status", "version", "source", "created_at", "updated_at")
    item = dict(zip(keys, row))
    item["aliases"] = json.loads(item["aliases"])
    item["core"] = is_core(item["category"])
    item["category_label"] = CATEGORIES.get(item["category"], item["category"])
    return item


_COLUMNS = "id,scope_id,category,name,aliases,content,status,version,source,created_at,updated_at"


def list_entries(scope_id: str, *, category=None, include_retired=False, include_proposed=False) -> list[dict]:
    """默认只返回生效条目；include_proposed 加上系统整理、待用户确认的条目；include_retired 返回全部状态。"""
    clauses, params = ["scope_id=?"], [scope_id]
    if category:
        clauses.append("category=?"); params.append(category)
    if not include_retired:
        clauses.append("status IN ('active','proposed')" if include_proposed else "status='active'")
    with closing(plugin_db("jubao-drama")) as conn:
        _tables(conn)
        rows = conn.execute(f"SELECT {_COLUMNS} FROM story_bible WHERE {' AND '.join(clauses)} ORDER BY category, created_at",
                            params).fetchall()
    return [_entry(row) for row in rows]


def get_entry(scope_id: str, entry_id: str) -> dict:
    with closing(plugin_db("jubao-drama")) as conn:
        _tables(conn)
        row = conn.execute(f"SELECT {_COLUMNS} FROM story_bible WHERE id=? AND scope_id=?", (entry_id, scope_id)).fetchone()
    if row is None:
        raise ValueError("当前创作范围的设定库中没有这个条目")
    return _entry(row)


def history(scope_id: str, entry_id: str) -> list[dict]:
    get_entry(scope_id, entry_id)
    with closing(plugin_db("jubao-drama")) as conn:
        _tables(conn)
        rows = conn.execute("SELECT version,action,actor,snapshot,session_id,reason,at FROM story_bible_history "
                            "WHERE entry_id=? ORDER BY version DESC", (entry_id,)).fetchall()
    return [{"version": v, "action": a, "actor": actor, "snapshot": json.loads(s), "session_id": sid, "reason": r, "at": at}
            for v, a, actor, s, sid, r, at in rows]


# ----- 变更规范化 -----

def clean_change(change) -> dict:
    """统一校验模型提案、模型记录与用户编辑的单项变更。"""
    if not isinstance(change, dict):
        raise ValueError("设定变更必须是对象")
    op = change.get("op", "add")
    if op not in {"add", "update", "retire"}:
        raise ValueError("设定变更 op 只能是 add、update 或 retire")
    if op != "add" and not isinstance(change.get("id"), str):
        raise ValueError("修改或停用设定时必须提供条目 id")
    cleaned = {"op": op, "id": change.get("id"), "reason": str(change.get("reason") or "").strip()[:300]}
    if op == "retire":
        return cleaned
    category = change.get("category")
    if category not in CATEGORIES:
        raise ValueError("设定类别必须是：" + "、".join(f"{key}（{label}）" for key, label in CATEGORIES.items()))
    name, content = change.get("name"), change.get("content")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= _MAX_NAME:
        raise ValueError(f"设定名称不能为空，最多 {_MAX_NAME} 字")
    if not isinstance(content, str) or not 1 <= len(content.strip()) <= _MAX_CONTENT:
        raise ValueError(f"设定内容不能为空，最多 {_MAX_CONTENT} 字")
    aliases = change.get("aliases") or []
    if not isinstance(aliases, list) or len(aliases) > _MAX_ALIASES or any(
            not isinstance(alias, str) or not 1 <= len(alias.strip()) <= _MAX_NAME for alias in aliases):
        raise ValueError(f"别名最多 {_MAX_ALIASES} 个，每个不超过 {_MAX_NAME} 字")
    cleaned.update(category=category, name=name.strip(), content=content.strip(),
                   aliases=list(dict.fromkeys(alias.strip() for alias in aliases)))
    return cleaned


def touches_core(scope_id: str, change: dict) -> bool:
    """新类别或原条目任一为核心即需用户确认，不能借改类别绕过审批。"""
    if is_core(change.get("category")):
        return True
    return bool(change.get("id")) and change["op"] != "add" and get_entry(scope_id, change["id"])["core"]


def changes_digest(scope_id: str, changes: list[dict]) -> str:
    """审批绑定的目标：变更内容加上被修改条目的当前版本，任一变化都需要重新确认。"""
    versions = {}
    for change in changes:
        if change.get("id") and change["op"] != "add":
            versions[change["id"]] = get_entry(scope_id, change["id"])["version"]
    payload = json.dumps({"scope": scope_id, "changes": changes, "versions": versions}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def describe(scope_id: str, changes: list[dict]) -> str:
    lines = []
    for index, change in enumerate(changes, 1):
        if change["op"] == "retire":
            entry = get_entry(scope_id, change["id"])
            lines.append(f"{index}. 停用【{entry['category_label']}】{entry['name']}")
        elif change["op"] == "update":
            entry = get_entry(scope_id, change["id"])
            lines.append(f"{index}. 修改【{CATEGORIES[change['category']]}】{change['name']}\n   原：{entry['content'][:300]}\n   新：{change['content'][:300]}")
        else:
            lines.append(f"{index}. 新增【{CATEGORIES[change['category']]}】{change['name']}：{change['content'][:300]}")
        if change.get("reason"):
            lines.append(f"   理由：{change['reason']}")
    return "\n".join(lines)


# ----- 写入 -----

def _index(entry):
    memory = story_memory()
    if entry["status"] not in {"active", "proposed"}:
        memory.delete(entry["scope_id"], entry["id"])
        return
    memory.upsert(MemoryRecord(entry["scope_id"], entry["id"], entry["category"], entry["name"],
                               entry["content"], tuple(entry["aliases"])))


def apply_changes(scope_id: str, changes: list[dict], *, actor: str, session_id: str = "", allow_core: bool,
                  status: str = "active") -> list[dict]:
    """在一个事务内应用变更并写历史；核心变更只有用户编辑或已确认的提案才能写入。"""
    changes = [clean_change(change) for change in changes]
    if not changes or len(changes) > 30:
        raise ValueError("每次设定变更为 1 至 30 项")
    if not allow_core and any(touches_core(scope_id, change) for change in changes):
        raise PermissionError("核心设定（世界规则、人物、人物关系、关键物件）需要用 propose 提交，经用户确认后写入")
    now, written = time.time(), []
    with closing(plugin_db("jubao-drama")) as conn:
        _tables(conn)
        conn.execute("BEGIN IMMEDIATE")
        for change in changes:
            if change["op"] == "add":
                duplicate = conn.execute("SELECT id FROM story_bible WHERE scope_id=? AND category=? AND name=? AND status IN ('active','proposed')",
                                         (scope_id, change["category"], change["name"])).fetchone()
                if duplicate:
                    raise ValueError(f"设定库已有同名条目“{change['name']}”（{duplicate[0]}），请用 update 修改")
                identifier, version = "B" + uuid4().hex[:10], 1
                conn.execute(f"INSERT INTO story_bible ({_COLUMNS}) VALUES (?,?,?,?,?,?,?,1,?,?,?)",
                             (identifier, scope_id, change["category"], change["name"],
                              json.dumps(change["aliases"], ensure_ascii=False), change["content"], status, actor, now, now))
            else:
                row = conn.execute("SELECT version FROM story_bible WHERE id=? AND scope_id=?",
                                   (change["id"], scope_id)).fetchone()
                if row is None:
                    raise ValueError("当前创作范围的设定库中没有这个条目")
                identifier, version = change["id"], row[0] + 1
                if change["op"] == "retire":
                    conn.execute("UPDATE story_bible SET status='retired', version=?, source=?, updated_at=? WHERE id=?",
                                 (version, actor, now, identifier))
                else:
                    conn.execute("UPDATE story_bible SET category=?, name=?, aliases=?, content=?, status='active', version=?, "
                                 "source=?, updated_at=? WHERE id=?",
                                 (change["category"], change["name"], json.dumps(change["aliases"], ensure_ascii=False),
                                  change["content"], version, actor, now, identifier))
            snapshot = conn.execute(f"SELECT {_COLUMNS} FROM story_bible WHERE id=?", (identifier,)).fetchone()
            entry = _entry(snapshot)
            conn.execute("INSERT INTO story_bible_history VALUES (?,?,?,?,?,?,?,?)",
                         (identifier, version, change["op"], actor, json.dumps(entry, ensure_ascii=False),
                          session_id, change.get("reason") or "", now))
            written.append(entry)
        conn.commit()
    for entry in written:
        try:
            _index(entry)
        except Exception:
            # 检索索引可以从正式表重建；索引失败不回滚已经写入的设定。
            pass
    return written


def revert(scope_id: str, entry_id: str, version: int, *, actor="user", session_id="") -> dict:
    """把条目恢复到指定历史版本（作为新版本写入，不删除历史）。"""
    target = next((row for row in history(scope_id, entry_id) if row["version"] == version), None)
    if target is None:
        raise ValueError("没有这个历史版本")
    snapshot = target["snapshot"]
    if snapshot["status"] != "active":
        return apply_changes(scope_id, [{"op": "retire", "id": entry_id, "reason": f"恢复到第 {version} 版"}],
                             actor=actor, session_id=session_id, allow_core=True)[0]
    return apply_changes(scope_id, [{"op": "update", "id": entry_id, "category": snapshot["category"], "name": snapshot["name"],
                                     "aliases": snapshot["aliases"], "content": snapshot["content"],
                                     "reason": f"恢复到第 {version} 版"}],
                         actor=actor, session_id=session_id, allow_core=True)[0]


def decide(scope_id: str, entry_id: str, accept: bool, *, session_id: str = "") -> dict:
    """用户对系统整理条目的决定：确认后成为正式设定，不采用则停用；都写入版本历史。"""
    entry = get_entry(scope_id, entry_id)
    if entry["status"] != "proposed":
        raise ValueError("这条设定不是待确认状态")
    now = time.time()
    with closing(plugin_db("jubao-drama")) as conn:
        _tables(conn)
        conn.execute("BEGIN IMMEDIATE")
        version = entry["version"] + 1
        conn.execute("UPDATE story_bible SET status=?, version=?, source='user', updated_at=? WHERE id=? AND status='proposed'",
                     ("active" if accept else "rejected", version, now, entry_id))
        snapshot = _entry(conn.execute(f"SELECT {_COLUMNS} FROM story_bible WHERE id=?", (entry_id,)).fetchone())
        conn.execute("INSERT INTO story_bible_history VALUES (?,?,?,?,?,?,?,?)",
                     (entry_id, version, "confirm" if accept else "reject", "user", json.dumps(snapshot, ensure_ascii=False),
                      session_id, "", now))
        conn.commit()
    _index(snapshot)
    return snapshot


# ----- 胶囊渲染 -----

def _line(entry, limit):
    alias = f"（又称：{'、'.join(entry['aliases'])}）" if entry["aliases"] else ""
    content = entry["content"] if len(entry["content"]) <= limit else entry["content"][:limit] + "……（完整内容用 drama_story_bible read 读取）"
    return f"- [{entry['id']}] {entry['name']}{alias}：{content}"


def render(scope_id: str, query: str = "", *, budget: int = 9000) -> str:
    entries = list_entries(scope_id, include_proposed=True)
    if not entries:
        return ""
    proposed = [entry for entry in entries if entry["status"] == "proposed"]
    entries = [entry for entry in entries if entry["status"] == "active"]
    sections, used = [], 0
    core = [entry for entry in entries if entry["core"]]
    for category, label in CORE.items():
        rows = [entry for entry in core if entry["category"] == category]
        if not rows:
            continue
        lines = [f"〔{label}〕"]
        for entry in rows:
            line = _line(entry, 400)
            if used + len(line) > budget * 0.7:
                lines.append(f"- {entry['name']}（[{entry['id']}]，内容较长未展开）")
                continue
            lines.append(line)
            used += len(line)
        sections.append("\n".join(lines))
    if proposed:
        lines = ["〔待用户确认的核心设定（系统依据用户原话与已交付稿件整理；可沿用，但不得在此之外新增核心设定）〕"]
        for entry in proposed:
            line = f"- [{entry['category_label']}] " + _line(entry, 300)[2:]
            if used + len(line) > budget * 0.8:
                lines.append(f"- {entry['name']}（[{entry['id']}]）")
                continue
            lines.append(line)
            used += len(line)
        sections.append("\n".join(lines))
    # 文风与格式规范每轮都要执行，与核心设定一样全量提供，不依赖检索命中。
    styles = [entry for entry in entries if entry["category"] == "style"]
    if styles:
        lines = ["〔文风与格式规范（每轮执行）〕"]
        for entry in styles:
            line = _line(entry, 1500)
            if used + len(line) > budget * 0.85:
                lines.append(f"- {entry['name']}（[{entry['id']}]，内容较长，用 drama_story_bible read 读取全文）")
                continue
            lines.append(line)
            used += len(line)
        sections.append("\n".join(lines))
    notes = {entry["id"]: entry for entry in entries if not entry["core"] and entry["category"] != "style"}
    selected = []
    timeline = sorted((entry for entry in notes.values() if entry["category"] == "timeline"),
                      key=lambda entry: entry["updated_at"], reverse=True)[:3]
    selected.extend(timeline)
    if query and notes:
        try:
            hits = story_memory().search(scope_id, query, kinds=tuple(NOTES), limit=8)
        except Exception:
            hits = []
        selected.extend(notes[hit.key] for hit in hits if hit.key in notes and notes[hit.key] not in selected)
    if selected:
        lines = ["〔与本轮相关的其他设定〕"]
        for entry in selected:
            line = f"- [{entry['category_label']}] " + _line(entry, 300)[2:]
            if used + len(line) > budget:
                break
            lines.append(line)
            used += len(line)
        sections.append("\n".join(lines))
    others = len(notes) - len(selected)
    if others > 0:
        sections.append(f"另有 {others} 条非核心设定未展开，需要时用 drama_story_bible(action=\"search\") 查找。")
    return "\n".join(sections)

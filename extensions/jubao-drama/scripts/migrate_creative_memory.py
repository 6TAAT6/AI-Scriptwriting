"""把旧会话的项目归属、用户要求合同和 OA6.1 项目成果迁移到要求清单与设定库。

只读取旧表，不删除或改写旧数据；迁移条目标记为“旧会话整理”，供用户在资料栏确认或取消。
可重复执行：每个账号、每条来源只迁移一次。默认空跑统计，加 ``--apply`` 才写入。

用法（在发布目录内，使用业务 Python）：
    PYTHONPATH=. python extensions/jubao-drama/scripts/migrate_creative_memory.py --state <HERMES_HOME> [--apply]
"""

from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
from importlib.util import module_from_spec, spec_from_file_location
import json
from pathlib import Path
import sys
import time

PLUGIN = Path(__file__).resolve().parents[1]
_SETTING_KINDS = {"target_market", "script_language", "dialogue_language", "prompt_language"}
_SEMANTIC_LIMIT = 200


def _load_plugin():
    spec = spec_from_file_location("jubao_drama_migration", PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
    package = module_from_spec(spec)
    sys.modules[spec.name] = package
    spec.loader.exec_module(package)
    import importlib
    return {name: importlib.import_module(f"{spec.name}.{name}") for name in ("ledger", "story_bible", "creative_scope")}


def _homes(state: Path):
    """遍历全部账号目录；侧栏记录只用于绑定项目归属，未登记侧栏的账号也迁移其要求与项目。"""
    sidebar = json.loads((state / "studio" / "sidebar.json").read_text(encoding="utf-8"))
    accounts = {str(account.get("profile")): account for account in sidebar.get("accounts", [])}
    homes = [*sorted((state / "profiles").glob("*")), *sorted((state / "studio-workers").glob("studio-*"))]
    for home in homes:
        if home.is_dir() and not home.is_symlink() and (home / "plugin-data" / "jubao-drama" / "data.db").is_file():
            yield accounts.get(home.name, {"profile": home.name, "sessions": []}), home


def _requirement(row):
    """旧合同条目 → (类别, 文字, 约束)；界面设置、单轮任务和整条原话式条目返回 None。"""
    kind, value, quote = row.get("kind"), row.get("value"), str(row.get("quote") or "").strip()
    scope = row.get("scope") or {}
    if row.get("status", "active") != "active" or scope.get("lifetime") == "turn" or kind in _SETTING_KINDS:
        return None
    if kind == "world":
        return "world", str(value if isinstance(value, str) else quote), None
    if kind == "forbidden_mechanism":
        return "forbid", str(value if isinstance(value, str) else quote), None
    if kind == "locked_names" and isinstance(value, list) and value:
        return "character", "人物名固定为：" + "、".join(str(name) for name in value), None
    if kind == "min_words" and isinstance(value, dict):
        low, high = value.get("minimum"), value.get("maximum")
        unit = "每集" if value.get("unit") == "per_episode" else "全文"
        span = f"{low}—{high}" if low is not None and high is not None else f"不少于{low}" if low is not None else f"不超过{high}"
        constraint = {"kind": "min_words", "metric": value.get("metric", "han_characters"),
                      "unit": "per_episode" if value.get("unit") == "per_episode" else "document",
                      "minimum": low, "maximum": high, "episodes": scope.get("episodes")}
        return "length", f"{unit}正文{span}字", constraint
    if kind == "semantic" and isinstance(value, str) and len(value.strip()) <= _SEMANTIC_LIMIT:
        return "other", value.strip(), None
    return None


def _marker(conn, key):
    conn.execute("CREATE TABLE IF NOT EXISTS creative_migrations (key TEXT PRIMARY KEY, at REAL NOT NULL)")
    return conn.execute("SELECT 1 FROM creative_migrations WHERE key=?", (key,)).fetchone() is not None


def migrate_home(modules, account, home: Path, apply: bool) -> dict:
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from plugins.plugin_storage import plugin_db
    ledger, bible, scopes = modules["ledger"], modules["story_bible"], modules["creative_scope"]
    stats = {"bound": 0, "requirements": 0, "skipped": 0, "notes": 0}
    token = set_hermes_home_override(home)
    try:
        for session in account.get("sessions", []):
            project = session.get("projectId", "default")
            if apply:
                scopes.bind(session["id"], project or "")
            stats["bound"] += 1
        with closing(plugin_db("jubao-drama")) as conn:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            contracts = conn.execute("SELECT session_id, snapshot FROM task_requirements_state").fetchall() \
                if "task_requirements_state" in tables else []
            projects = conn.execute("SELECT id, data FROM drama_projects").fetchall() if "drama_projects" in tables else []
        seen: dict[str, set] = {}
        for session_id, raw in contracts:
            snapshot = json.loads(raw)
            scope = scopes.scope_for(session_id)
            existing = seen.setdefault(scope, {item["text"] for item in ledger.list_requirements(scope, include_inactive=True)})
            for row in snapshot.get("active_requirements", []):
                mapped = _requirement(row)
                if mapped is None:
                    stats["skipped"] += 1
                    continue
                category, text, constraint = mapped
                text = text[:600]
                key = "req:" + hashlib.sha256(f"{scope}|{text}".encode()).hexdigest()
                if text in existing:
                    continue
                existing.add(text)
                stats["requirements"] += 1
                if not apply:
                    continue
                with closing(plugin_db("jubao-drama")) as conn:
                    ledger._tables(conn)
                    if _marker(conn, key):
                        continue
                    conn.execute("BEGIN IMMEDIATE")
                    ledger._insert(conn, scope, text=text, category=category, lifetime="standing",
                                   constraint=ledger.clean_constraint(constraint), origin="migration",
                                   quote=str(row.get("quote") or text)[:600], session_id=session_id)
                    conn.execute("INSERT INTO creative_migrations VALUES (?,?)", (key, time.time()))
                    conn.commit()
        for project_id, raw in projects:
            project = json.loads(raw)
            writers = [batch.get("writer_session_id") for kind in ("outline_batches", "script_batches")
                       for batch in project.get(kind) or [] if batch.get("writer_session_id")]
            if not writers:
                continue
            scope = scopes.scope_for(writers[-1])
            notes = []
            core = project.get("core") or {}
            if core.get("content") and core.get("approval"):
                notes.append(("note", f"核心期待（{project.get('title', '剧本项目')}）", core["content"]))
            plan = project.get("plan") or {}
            if plan.get("content") and plan.get("selection"):
                notes.append(("note", f"已选改编方案（{project.get('title', '剧本项目')}）", plan["content"]))
            accepted = [batch for kind in ("outline_batches", "script_batches") for batch in project.get(kind) or []
                        if batch.get("status") == "accepted" and batch.get("continuity")]
            if accepted:
                last = accepted[-1]
                episodes = last.get("episodes") or []
                label = f"第{episodes[-1]}集末态" if episodes else "最近批次末态"
                notes.append(("timeline", f"{label}（{project.get('title', '剧本项目')}）",
                              json.dumps(last["continuity"], ensure_ascii=False, indent=1)))
            for category, name, content in notes:
                key = "note:" + hashlib.sha256(f"{scope}|{project_id}|{name}".encode()).hexdigest()
                stats["notes"] += 1
                if not apply:
                    continue
                with closing(plugin_db("jubao-drama")) as conn:
                    conn.execute("CREATE TABLE IF NOT EXISTS creative_migrations (key TEXT PRIMARY KEY, at REAL NOT NULL)")
                    if _marker(conn, key):
                        continue
                bible.apply_changes(scope, [{"op": "add", "category": category, "name": name[:60], "content": content[:4000],
                                             "reason": "旧项目记录整理"}], actor="migration", allow_core=False)
                with closing(plugin_db("jubao-drama")) as conn:
                    conn.execute("INSERT OR IGNORE INTO creative_migrations VALUES (?,?)", (key, time.time()))
                    conn.commit()
    finally:
        reset_hermes_home_override(token)
    return stats


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--apply", action="store_true")
    options = parser.parse_args()
    modules = _load_plugin()
    total = {"accounts": 0, "bound": 0, "requirements": 0, "skipped": 0, "notes": 0}
    for account, home in _homes(options.state.resolve()):
        stats = migrate_home(modules, account, home, options.apply)
        total["accounts"] += 1
        for key, value in stats.items():
            total[key] += value
    print(json.dumps({"mode": "apply" if options.apply else "dry-run", **total}, ensure_ascii=False))


if __name__ == "__main__":
    main()

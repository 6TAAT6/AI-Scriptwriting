"""Optional website reference guard; no model calls, persistence or quality review.

The website, not the model, must own approval and selection records. Hashes bind
records to content; they do not prove that a human approved anything.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any


TASKS = frozenset({"analysis", "candidates", "outline", "script", "review", "export"})


def content_hash(content: str) -> str:
    """Hash exact substantive content, normalizing line endings and outer space."""
    if not isinstance(content, str) or not content.strip():
        raise ValueError("content must be nonempty text")
    normalized = content.replace("\r\n", "\n").replace("\r", "\n").strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _object(value: Any) -> Mapping:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _hash_or_none(value: Any) -> str | None:
    return content_hash(value) if _text(value) else None


def check_task(task: str, state: Mapping, *, rewrites: bool = False) -> dict:
    """Check confirmation gates only; an allowed result is not editorial approval.

    Pure review/export need no creative confirmation. If either will rewrite
    content, set rewrites=True so the same gates as script creation apply.
    """
    if task not in TASKS:
        raise ValueError(f"unknown task: {task}")
    state = _object(state)
    blockers: list[str] = []
    notes = ["仅检查确认节点；不代表资料充分、稿件已审或可直接交付。"]

    pure_operation = task in {"review", "export"} and not rewrites
    if task == "analysis" or pure_operation:
        if pure_operation:
            notes.append("按指定源稿执行已授权的审核或导出；不能顺带改写，也不能将排版通过称为剧情已审。")
            if task == "review":
                notes.append("缺少可用核心期待依据时，仅说明这一审核维度无依据；其余可判断内容继续按范围审查。")
        return {"allowed": True, "blockers": blockers, "notes": notes}

    core = _object(state.get("core"))
    core_hash = _hash_or_none(core.get("content"))
    approval = _object(core.get("approval"))
    if core_hash is None:
        blockers.append("缺少核心期待内容，先分析并形成创作依据。")
    if core.get("unresolved_conflict"):
        blockers.append("核心期待存在未解决的真实冲突，需要用户作出取舍。")
    if approval.get("kind") not in ("human_confirmation", "user_provided", "explicit_waiver"):
        blockers.append("核心期待未经人工确认或明确给定；推荐、审稿通过或沉默均不能替代。")
    elif not _text(approval.get("evidence")):
        blockers.append("核心期待确认缺少可追溯的用户输入或确认记录。")
    elif core_hash is None or approval.get("content_hash") != core_hash:
        blockers.append("核心期待已变化或确认版本不匹配，需要更新人工确认。")
    elif approval.get("kind") == "explicit_waiver" and approval.get("scope") != "core_confirmation":
        blockers.append("免确认覆盖规则须明确针对核心期待确认环节，旧代选授权不适用。")

    needs_plan = task in {"outline", "script"} or (task in {"review", "export"} and rewrites)
    if needs_plan:
        plan = _object(state.get("plan"))
        plan_hash = _hash_or_none(plan.get("content"))
        selection = _object(plan.get("selection"))
        if plan_hash is None:
            blockers.append("缺少已选总体方案，先提供候选或读取现有选定方向。")
        if core_hash is None or plan.get("core_hash") != core_hash:
            blockers.append("方案未绑定当前核心期待；期待变化后旧方案选择不能直接沿用。")
        if selection.get("kind") not in ("human_selection", "authorized_auto_selection"):
            blockers.append("总体方案尚未选定；推荐、预选或要求更多候选均不是选定。")
        elif not _text(selection.get("evidence")):
            blockers.append("方案选择缺少可追溯记录。")
        elif plan_hash is None or selection.get("content_hash") != plan_hash:
            blockers.append("方案内容已变化或选择版本不匹配，需要确认当前方向。")
        elif selection.get("kind") == "authorized_auto_selection":
            authorization = _object(selection.get("authorization"))
            if authorization.get("scope") != "plan_selection" or not _text(authorization.get("evidence")):
                blockers.append("自动选方案缺少明确代选授权；代选授权不能免除核心期待确认。")

    return {"allowed": not blockers, "blockers": blockers, "notes": notes}


def main() -> int:
    parser = argparse.ArgumentParser(description="V3 可选确认节点参考校验器（非整站服务）")
    parser.add_argument("task", choices=sorted(TASKS))
    parser.add_argument("state", type=Path, help="由网站可信流程维护的 JSON 状态文件")
    parser.add_argument("--rewrites", action="store_true", help="审核/导出包含改写时启用创作确认检查")
    args = parser.parse_args()
    state = json.loads(args.state.read_text(encoding="utf-8"))
    result = check_task(args.task, state, rewrites=args.rewrites)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["allowed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())

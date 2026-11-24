#!/usr/bin/env python3
"""Search the movie-development distilled case-card library."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def library_dir() -> Path:
    return skill_root() / "assets" / "library"


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise SystemExit(f"Missing library file: {path}")
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            if line.strip():
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    raise SystemExit(f"Invalid JSONL at {path}:{line_no}: {exc}") from exc
    return records


def flatten(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return "\n".join(f"{key}: {flatten(val)}" for key, val in value.items())
    if isinstance(value, list):
        return "\n".join(flatten(item) for item in value)
    return str(value)


def tokens(query: str) -> list[str]:
    base = [item for item in re.split(r"[\s,，、/|;；:：]+", query.strip()) if item]
    lexicon = [
        "救猫咪", "开场画面", "主题呈现", "铺垫", "催化剂", "争论", "第二幕", "B故事", "娱乐游戏", "中点",
        "坏人逼近", "一无所有", "灵魂黑夜", "第三幕", "终局", "终场画面", "伪胜利", "伪失败",
        "鬼怪屋", "金羊毛", "如愿以偿", "麻烦家伙", "变迁仪式", "伙伴之情", "推理侦探", "愚者成功",
        "被制度化", "超级英雄", "审讯", "饭桌", "追逐", "真相", "信息差", "权力", "反转", "关系",
    ]
    for word in lexicon:
        if word in query and word not in base:
            base.append(word)
    return base


def contains(value: Any, expected: str | None) -> bool:
    if not expected:
        return True
    return expected.lower() in flatten(value).lower()


def score(record: dict[str, Any], query: str) -> tuple[float, list[str]]:
    if not query:
        return 1.0, ["all"]
    title = flatten([record.get("id"), record.get("title"), record.get("category"), record.get("tags")]).lower()
    core = flatten([
        record.get("promise"),
        record.get("core_mechanism"),
        record.get("structure_model"),
        record.get("turning_points"),
        record.get("use_for"),
    ]).lower()
    hay = flatten([record.get("searchable_text"), record.get("payload")]).lower()
    total = 0.0
    matched: list[str] = []
    for token in tokens(query):
        low = token.lower()
        if not low:
            continue
        if low in title:
            total += 8
            matched.append(token)
        elif low in core:
            total += 5
            matched.append(token)
        elif low in hay:
            total += 2
            matched.append(token)
    # Curated cards contain the film's real plot mechanisms; template cards are
    # heuristic boilerplate. Prefer curated so results carry real information.
    if total > 0 and record.get("content_quality") == "curated":
        total *= 1.5
    return total, sorted(set(matched))


def matches_filters(record: dict[str, Any], args: argparse.Namespace) -> bool:
    payload = record.get("payload", {})
    if args.detail != "all" and record.get("detail") != args.detail:
        return False
    if args.stc_type and not contains([record.get("category"), record.get("tags"), payload.get("stc_type_primary"), payload.get("stc_type_candidates")], args.stc_type):
        return False
    if args.beat and not contains([record.get("tags"), payload.get("beat_name"), payload.get("linked_beat"), record.get("id")], args.beat):
        return False
    if args.film and not contains([record.get("title"), payload.get("source_title"), payload.get("film_id"), record.get("id")], args.film):
        return False
    if args.scene_type and not contains([payload.get("scene_heading"), payload.get("scene_function"), payload.get("pressure_source"), record.get("core_mechanism")], args.scene_type):
        return False
    return True


def summarize(record: dict[str, Any], current_score: float, matched: list[str]) -> dict[str, Any]:
    payload = record.get("payload", {})
    item: dict[str, Any] = {
        "id": record.get("id"),
        "detail": record.get("detail"),
        "card_type": record.get("card_type"),
        "title": record.get("title"),
        "category": record.get("category"),
        "score": round(current_score, 2),
        "matched_fields": matched[:8],
        "mechanism": record.get("core_mechanism"),
        "next_action": record.get("use_for"),
    }
    if record.get("detail") == "l1":
        item.update({
            "stc_type": payload.get("stc_type_primary"),
            "logline_pattern": payload.get("logline_pattern"),
        })
    elif record.get("detail") == "l2":
        item.update({
            "beat_name": payload.get("beat_name"),
            "approximate_position": payload.get("approximate_position"),
            "story_function": payload.get("story_function"),
        })
    else:
        item.update({
            "linked_beat": payload.get("linked_beat"),
            "scene_heading": payload.get("scene_heading"),
            "scene_function": payload.get("scene_function"),
        })
    return item


def print_text(items: list[dict[str, Any]]) -> None:
    for i, item in enumerate(items, start=1):
        print(f"{i}. [{item['score']}] {item['id']} {item['title']}")
        print(f"   detail: {item.get('detail')} / category: {item.get('category')}")
        if item.get("detail") == "l1":
            print(f"   pattern: {item.get('logline_pattern')}")
        elif item.get("detail") == "l2":
            print(f"   beat: {item.get('beat_name')} / pos: {item.get('approximate_position')}")
            print(f"   function: {item.get('story_function')}")
        else:
            print(f"   beat: {item.get('linked_beat')}")
            print(f"   scene: {item.get('scene_heading')}")
        print(f"   mechanism: {item.get('mechanism')}")
        print(f"   next: {item.get('next_action')}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query", nargs="?", default="")
    parser.add_argument("--detail", choices=["l1", "l2", "l3", "all"], default="all")
    parser.add_argument("--stc-type")
    parser.add_argument("--beat")
    parser.add_argument("--film")
    parser.add_argument("--scene-type")
    parser.add_argument("--top", type=int, default=8)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--library-dir", default=str(library_dir()))
    args = parser.parse_args()

    records = load_jsonl(Path(args.library_dir).expanduser().resolve() / "case_cards.jsonl")
    ranked: list[tuple[float, list[str], dict[str, Any]]] = []
    for record in records:
        if not matches_filters(record, args):
            continue
        current, matched = score(record, args.query)
        if current > 0:
            ranked.append((current, matched, record))
    ranked.sort(key=lambda item: (-item[0], item[2].get("detail", ""), item[2].get("id", "")))
    payload = [summarize(record, current, matched) for current, matched, record in ranked[: args.top]]
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print_text(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

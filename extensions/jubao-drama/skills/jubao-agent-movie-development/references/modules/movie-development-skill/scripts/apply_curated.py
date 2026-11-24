#!/usr/bin/env python3
"""Apply hand-curated film content to case_cards.jsonl.

Reads curated data from assets/library/curated/ and rewrites case_cards.jsonl:

- L1 cards get real loglines, arcs, A/B stories, theme questions and beat
  summaries for every curated film.
- L2 beat cards of curated films get the film's actual beat content as
  ``visible_event`` / ``opening`` / ``core_mechanism``.
- Every card receives a ``content_quality`` field: ``curated`` (hand-written,
  reflects the real film) or ``template`` (heuristic boilerplate; never cite it
  as the film's actual plot).
- The redundant ``searchable_text`` and ``turning_points`` fields are removed
  (search already scans the payload), cutting file size roughly in half.

Idempotent: safe to run multiple times.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

SKILL_ROOT = Path(__file__).resolve().parents[1]
LIB = SKILL_ROOT / "assets" / "library"
CURATED = LIB / "curated"

# beat_order -> (english key used in beat_summary, Chinese beat name)
BEAT_KEYS = {
    1: "opening_image", 2: "theme_stated", 3: "set_up", 4: "catalyst",
    5: "debate", 6: "break_into_two", 7: "b_story", 8: "fun_and_games",
    9: "midpoint", 10: "bad_guys_close_in", 11: "all_is_lost",
    12: "dark_night_of_the_soul", 13: "break_into_three", 14: "finale",
    15: "final_image",
}

GENERIC_RE = re.compile(r"^.+?承担《.+?》的(?P<func>.+?)，主类型按.+$")


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    records = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                records.append(json.loads(line))
    return records


def load_curated() -> tuple[dict[str, dict], dict[str, dict]]:
    l1: dict[str, dict] = {}
    l2: dict[str, dict] = {}
    for path in sorted(CURATED.glob("l1_films_*.jsonl")):
        for rec in load_jsonl(path):
            l1[rec["film_id"]] = rec
    for path in sorted(CURATED.glob("l2_beats_*.jsonl")):
        for rec in load_jsonl(path):
            l2[rec["film_id"]] = rec["beats"]
    return l1, l2


def simplify_generic(text: str) -> str:
    """Strip the boilerplate wrapper, keep only the generic beat function."""
    m = GENERIC_RE.match(text or "")
    return m.group("func") if m else (text or "")


def apply() -> None:
    l1_map, l2_map = load_curated()
    cards = load_jsonl(LIB / "case_cards.jsonl")
    stats = {"l1_curated": 0, "l2_curated": 0, "template": 0}

    for card in cards:
        card.pop("searchable_text", None)
        payload = card.get("payload", {})
        detail = card.get("detail")
        film_id = payload.get("film_id") or card.get("id")

        if detail == "l1":
            card.pop("turning_points", None)
            cur = l1_map.get(film_id)
            if cur:
                card["content_quality"] = "curated"
                stats["l1_curated"] += 1
                card["category"] = cur["stc_type"]
                card["promise"] = cur["logline"]
                card["core_mechanism"] = cur["protagonist_arc"]
                card["opening"] = cur["opening_final"]
                card["structure_model"] = f"A故事：{cur['a_story']}；B故事：{cur['b_story']}"
                card["tags"] = ["l1", cur["stc_type"], cur["title"]]
                payload.update({
                    "title_zh": cur["title"],
                    "stc_type_primary": cur["stc_type"],
                    "stc_type_candidates": [cur["stc_type"]],
                    "logline_pattern": cur["logline"],
                    "protagonist_arc": cur["protagonist_arc"],
                    "a_story": cur["a_story"],
                    "b_story": cur["b_story"],
                    "opening_final_image_pair": cur["opening_final"],
                    "theme_question": cur["theme_question"],
                })
                beats = l2_map.get(film_id)
                summary = payload.get("beat_summary") or {}
                for key, text in list(summary.items()):
                    if beats and key in beats:
                        summary[key] = beats[key]
                    else:
                        summary[key] = simplify_generic(text)
                payload["beat_summary"] = summary
            else:
                card["content_quality"] = "template"
                stats["template"] += 1

        elif detail == "l2":
            beats = l2_map.get(film_id)
            key = BEAT_KEYS.get(payload.get("beat_order"))
            text = beats.get(key) if beats and key else None
            if text:
                card["content_quality"] = "curated"
                stats["l2_curated"] += 1
                payload["visible_event"] = text
                card["opening"] = text
                card["core_mechanism"] = (
                    f"{text} —— 迁移时保留该节拍的功能、压力源与人物状态变化，"
                    "替换人物、行业、地点与具体事件。"
                )
                cur = l1_map.get(film_id)
                if cur:
                    card["tags"] = ["l2", cur["title"], payload.get("beat_name", "")]
            else:
                card["content_quality"] = "template"
                stats["template"] += 1
                ve = payload.get("visible_event")
                if ve and not str(ve).startswith("（模板推测）"):
                    payload["visible_event"] = f"（模板推测，未经人工校对）{ve}"
        else:
            card["content_quality"] = "template"
            stats["template"] += 1

    with (LIB / "case_cards.jsonl").open("w", encoding="utf-8") as fh:
        for card in cards:
            fh.write(json.dumps(card, ensure_ascii=False) + "\n")

    # refresh type_stats
    stats_path = LIB / "type_stats.json"
    type_stats = json.loads(stats_path.read_text(encoding="utf-8"))
    type_stats["content_quality"] = {
        "l1_curated_films": stats["l1_curated"],
        "l2_curated_beat_cards": stats["l2_curated"],
        "template_cards": stats["template"],
        "note": "curated=人工撰写、对应真实剧情机制; template=启发式生成、仅通用节拍定义",
    }
    stc_counts: dict[str, int] = {}
    for cur in l1_map.values():
        stc_counts[cur["stc_type"]] = stc_counts.get(cur["stc_type"], 0) + 1
    type_stats["stc_type_counts"] = dict(sorted(stc_counts.items()))
    stats_path.write_text(
        json.dumps(type_stats, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"applied: {stats}")


if __name__ == "__main__":
    apply()

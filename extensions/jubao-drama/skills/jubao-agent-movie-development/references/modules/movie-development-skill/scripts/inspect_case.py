#!/usr/bin/env python3
"""Inspect one movie-development case card."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                records.append(json.loads(line))
    return records


def flatten(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return "\n".join(f"{key}: {flatten(val)}" for key, val in value.items())
    if isinstance(value, list):
        return "\n".join(flatten(item) for item in value)
    return str(value)


def find_record(records: list[dict[str, Any]], needle: str) -> dict[str, Any]:
    low = needle.lower()
    matches = [
        record for record in records
        if str(record.get("id", "")).lower() == low
        or low in str(record.get("title", "")).lower()
        or low in flatten(record.get("tags")).lower()
        or low in flatten(record.get("payload")).lower()
    ]
    if not matches:
        raise SystemExit(f"No case card matched: {needle}")
    return matches[0]


def print_text(record: dict[str, Any]) -> None:
    preferred = [
        "id", "source_id", "detail", "card_type", "title", "category", "tags", "promise", "opening",
        "core_mechanism", "structure_model", "turning_points", "failure_risks", "must_replace", "use_for",
    ]
    for key in preferred:
        value = record.get(key)
        if value in (None, "", []):
            continue
        if isinstance(value, (dict, list)):
            print(f"{key}: {json.dumps(value, ensure_ascii=False)}")
        else:
            print(f"{key}: {value}")
    payload = record.get("payload", {})
    if payload:
        print("payload:")
        for key in sorted(payload):
            value = payload[key]
            if isinstance(value, (dict, list)):
                value_text = json.dumps(value, ensure_ascii=False)
            else:
                value_text = str(value)
            print(f"  {key}: {value_text}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("card", help="Card id, title fragment, beat name, scene heading, or mechanism fragment.")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--library-dir", default=str(skill_root() / "assets" / "library"))
    args = parser.parse_args()

    cards = load_jsonl(Path(args.library_dir).expanduser().resolve() / "case_cards.jsonl")
    record = find_record(cards, args.card)
    if args.json:
        print(json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print_text(record)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

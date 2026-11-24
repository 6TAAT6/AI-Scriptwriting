#!/usr/bin/env python3
"""Search the optional local full-text layer."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import zlib
from pathlib import Path
from typing import Any


OBFUSCATION_KEY = b"movie-development-skill-local-full-text-v1"


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise SystemExit(f"Missing file: {path}")
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                records.append(json.loads(line))
    return records


def xor_stream(data: bytes, record_id: str) -> bytes:
    output = bytearray()
    counter = 0
    while len(output) < len(data):
        seed = OBFUSCATION_KEY + record_id.encode("utf-8") + counter.to_bytes(8, "big")
        output.extend(hashlib.sha256(seed).digest())
        counter += 1
    return bytes(byte ^ mask for byte, mask in zip(data, output))


def decode_text(encoded: str, record_id: str) -> str:
    encrypted = base64.b64decode(encoded.encode("ascii"))
    compressed = xor_stream(encrypted, record_id)
    return zlib.decompress(compressed).decode("utf-8", errors="ignore")


def tokens(query: str) -> list[str]:
    return [item.lower() for item in re.split(r"[\s,，、/|;；:：]+", query.strip()) if item]


def compact_snippet(text: str, query_tokens: list[str], limit: int = 160) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    low = compact.lower()
    pos = 0
    for token in query_tokens:
        found = low.find(token)
        if found >= 0:
            pos = found
            break
    start = max(0, pos - 55)
    end = min(len(compact), start + limit)
    snippet = compact[start:end].strip()
    if start:
        snippet = "..." + snippet
    if end < len(compact):
        snippet += "..."
    return snippet


def score_text(text: str, query_tokens: list[str]) -> tuple[float, str]:
    low = text.lower()
    score = 0.0
    matched: list[str] = []
    for token in query_tokens:
        count = low.count(token)
        if count:
            score += min(count, 10) * (2 + min(len(token), 12) / 4)
            matched.append(token)
    if not matched:
        return 0.0, ""
    return score, compact_snippet(text, matched)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query")
    parser.add_argument("--top", type=int, default=8)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--skill-root", default=str(skill_root()))
    args = parser.parse_args()

    root = Path(args.skill_root).expanduser().resolve()
    full_text_dir = root / "assets" / "full-text"
    ft_manifest = full_text_dir / "manifest.jsonl"
    if not ft_manifest.exists():
        message = {
            "available": False,
            "message": "Optional local full-text layer is not installed. Use scripts/build_library.py --include-full-text on a local install.",
        }
        if args.json:
            print(json.dumps(message, ensure_ascii=False, indent=2))
        else:
            print(message["message"])
        return 0

    source_manifest = {
        item["id"]: item
        for item in load_jsonl(root / "assets" / "library" / "manifest.jsonl")
    }
    query_tokens = tokens(args.query)
    ranked: list[dict[str, Any]] = []
    for record in load_jsonl(ft_manifest):
        encoded_path = full_text_dir / record["encoded_name"]
        if not encoded_path.exists():
            continue
        text = decode_text(encoded_path.read_text(encoding="ascii"), record["id"])
        current, snippet = score_text(text, query_tokens)
        if current <= 0:
            continue
        source = source_manifest.get(record.get("source_id", ""), {})
        ranked.append({
            "id": record["id"],
            "source_id": record.get("source_id"),
            "film_id": record.get("film_id"),
            "title": source.get("title", record.get("title_hash")),
            "score": round(current, 2),
            "snippet": snippet,
            "next_action": "Use this only as mechanism evidence; do not reuse original dialogue, full scenes, or exact plot order.",
        })

    ranked.sort(key=lambda item: (-item["score"], item["id"]))
    payload = ranked[: args.top]
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        for i, item in enumerate(payload, start=1):
            print(f"{i}. [{item['score']}] {item['id']} {item['title']}")
            print(f"   snippet: {item['snippet']}")
            print(f"   next: {item['next_action']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

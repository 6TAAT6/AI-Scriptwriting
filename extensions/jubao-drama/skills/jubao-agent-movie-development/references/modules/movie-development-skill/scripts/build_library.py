#!/usr/bin/env python3
"""Build the movie-development deep-skill library.

The distilled library contains structural mechanism cards only. Full text is
optional, local-only, and stored in an obfuscated form for search.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import os
import re
import shutil
import zlib
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import _stc_card_builder as stc


OBFUSCATION_KEY = b"movie-development-skill-local-full-text-v1"


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for record in records:
            fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def flatten(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return "\n".join(f"{k}: {flatten(v)}" for k, v in value.items())
    if isinstance(value, list):
        return "\n".join(flatten(v) for v in value)
    return str(value)


def words(value: str) -> list[str]:
    return [item for item in re.split(r"[\s,，、/|;；:：()（）\\[\\]{}<>《》\"']+", value or "") if item]


def source_id_for(row: dict[str, str], index: int) -> str:
    title = row.get("title", "")
    match = re.match(r"^(\d{3})[_：: -]", title)
    if match:
        return f"source_{match.group(1)}"
    cache_file = row.get("cache_file", "")
    if cache_file.startswith("texts/"):
        stem = Path(cache_file).stem.lower()
        stem = re.sub(r"[^a-z0-9]+", "_", stem).strip("_")
        return f"source_{stem[:48]}"
    return f"source_{index:03d}"


def film_id_for(source: stc.SourceRow) -> str:
    return f"film_{source.film_no}"


def generated_cards(sources: list[stc.SourceRow]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, int], dict[str, int]]:
    l1: list[dict[str, Any]] = []
    l2: list[dict[str, Any]] = []
    l3: list[dict[str, Any]] = []
    scene_counts: dict[str, int] = {}
    type_counts: dict[str, int] = {name: 0 for name in stc.STC_TYPES}

    for source in sources:
        lines = stc.read_lines(source.text_path)
        primary, candidates = stc.classify_stc_type(source)
        type_counts[primary] += 1
        scenes = stc.parse_scenes(lines)
        scene_counts[source.title] = len(scenes)
        l1.append(stc.make_l1(source, lines, primary, candidates))
        l2.extend(stc.make_l2(source, lines, primary))
        l3.extend(stc.make_l3(source, lines, scenes, primary))

    return l1, l2, l3, scene_counts, type_counts


def title_for(record: dict[str, Any]) -> str:
    if record.get("detail") == "l1":
        return str(record.get("source_title", ""))
    if record.get("detail") == "l2":
        return f"{record.get('source_title', '')} / {record.get('beat_name', '')}"
    return f"{record.get('source_title', '')} / {record.get('scene_heading', '')}"


def tags_for(record: dict[str, Any]) -> list[str]:
    tags: list[str] = []
    for key in [
        "detail",
        "stc_type_primary",
        "stc_type_candidates",
        "genre_tags",
        "beat_name",
        "linked_beat",
        "scene_function",
        "pressure_source",
    ]:
        value = record.get(key)
        if isinstance(value, list):
            tags.extend(str(item) for item in value if item)
        elif value:
            tags.append(str(value))
    return sorted(set(tags))


def normalize_card(record: dict[str, Any]) -> dict[str, Any]:
    detail = record.get("detail")
    category = record.get("stc_type_primary") or record.get("linked_beat") or record.get("beat_name") or "film"
    if detail == "l1":
        card_type = "film_structure"
        promise = record.get("logline_pattern", "")
        core = record.get("protagonist_arc", "")
        structure = f"A故事：{record.get('a_story', '')}；B故事：{record.get('b_story', '')}"
        opening = record.get("opening_final_image_pair", "")
        turning = [flatten(record.get("beat_summary", ""))]
        use_for = "同类故事类型、主角弧光、A/B故事、开场终场对照"
    elif detail == "l2":
        card_type = "beat_case"
        promise = record.get("story_function", "")
        core = record.get("transferable_pattern", "")
        structure = f"{record.get('beat_name', '')} / {record.get('approximate_position', '')}"
        opening = record.get("visible_event", "")
        turning = [record.get("character_change", ""), record.get("theme_pressure", "")]
        use_for = record.get("use_for", "15节拍案例、节奏位置、人物变化")
    else:
        card_type = "scene_mechanism"
        promise = record.get("scene_function", "")
        core = record.get("transferable_mechanism", "")
        structure = record.get("escalation_pattern", "")
        opening = record.get("scene_goal", "")
        turning = [record.get("reversal", ""), record.get("character_state_change", "")]
        use_for = "场景目标、压力源、权力关系、信息差、反转机制"

    searchable = "\n".join([
        title_for(record),
        flatten(tags_for(record)),
        flatten(promise),
        flatten(core),
        flatten(structure),
        flatten(opening),
        flatten(turning),
        flatten(record),
    ])

    return {
        "id": record.get("id"),
        "source_id": record.get("film_id") or record.get("id"),
        "detail": detail,
        "card_type": card_type,
        "title": title_for(record),
        "category": category,
        "tags": tags_for(record),
        "promise": promise,
        "opening": opening,
        "core_mechanism": core,
        "structure_model": structure,
        "turning_points": [item for item in turning if item],
        "failure_risks": [
            "只复述原片剧情而没有抽取机制",
            "复用原片人物、场景调度、完整桥段或对白",
            "只借类型标签而没有迁移压力、信息差和人物变化",
        ],
        "must_replace": ["人物姓名", "职业行业", "地点空间", "具体事件顺序", "对白措辞", "结尾行动"],
        "use_for": use_for,
        "searchable_text": searchable,
        "payload": record,
    }


def build_manifest(rows: list[dict[str, str]], sources: list[stc.SourceRow], excluded: list[dict[str, Any]], cache_root: Path) -> list[dict[str, Any]]:
    indexed_by_cache = {source.cache_file: source for source in sources}
    excluded_by_cache = {item.get("cache_file", ""): item for item in excluded}
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, row in enumerate(rows, start=1):
        source_id = source_id_for(row, index)
        while source_id in seen:
            source_id = f"{source_id}_{index}"
        seen.add(source_id)
        cache_file = row.get("cache_file", "")
        indexed_source = indexed_by_cache.get(cache_file)
        excluded_item = excluded_by_cache.get(cache_file, {})
        source_type = row.get("source_type", "")
        chars = int(row.get("chars") or 0)
        lines = int(row.get("lines") or 0)
        indexed = indexed_source is not None
        records.append({
            "id": source_id,
            "film_id": film_id_for(indexed_source) if indexed_source else "",
            "title": row.get("title", ""),
            "category": source_type,
            "source_path": row.get("source_file", ""),
            "cache_file": cache_file,
            "cache_root_label": str(cache_root),
            "word_count": max(1, chars // 5) if chars else 0,
            "char_count": chars,
            "line_count": lines,
            "format": Path(row.get("source_file", "")).suffix.lstrip(".") or "txt",
            "complete": indexed,
            "indexed": indexed,
            "privacy": "distilled-only" if indexed else "excluded",
            "exclusion_reason": "" if indexed else excluded_item.get("reason", "not_indexed"),
            "source_type": source_type,
            "tags": [item.strip() for item in re.split(r"[;；]", row.get("tags", "")) if item.strip()],
            "learning_dimensions": [item.strip() for item in re.split(r"[;；]", row.get("learning_dimensions", "")) if item.strip()],
            "sha256_16": row.get("sha256_16", ""),
            "full_text_id": f"ft_{hashlib.sha256(cache_file.encode('utf-8')).hexdigest()[:16]}" if indexed else "",
        })
    return records


def build_patterns(case_cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    patterns: list[dict[str, Any]] = []
    by_type: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_beat: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_scene_pressure: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for card in case_cards:
        payload = card.get("payload", {})
        if card.get("detail") == "l1":
            by_type[str(payload.get("stc_type_primary", "未知"))].append(card)
        elif card.get("detail") == "l2":
            by_beat[str(payload.get("beat_name", "未知"))].append(card)
        elif card.get("detail") == "l3":
            by_scene_pressure[str(payload.get("pressure_source", "未知"))].append(card)

    for idx, (name, cards) in enumerate(sorted(by_type.items()), start=1):
        examples = [card["title"] for card in cards[:5]]
        patterns.append({
            "id": f"pattern_type_{idx:02d}",
            "category": "story_type",
            "pattern_name": name,
            "trigger": f"用户需要同类电影结构、类型承诺或主角弧光时，检索 {name}。",
            "steps": [
                "先确认主角的错误信念和外在目标",
                "再确认类型承诺如何在第二幕反复兑现",
                "最后用开场/终场画面对照检验人物变化",
            ],
            "good_for": examples,
            "avoid_when": ["用户只需要单场对白", "故事类型尚未明确且素材不足"],
            "quality_check": ["输出必须落到可拍事件", "不能只给类型标签"],
        })

    for idx, (name, cards) in enumerate(sorted(by_beat.items()), start=1):
        examples = [card["title"] for card in cards[:4]]
        patterns.append({
            "id": f"pattern_beat_{idx:02d}",
            "category": "beat_function",
            "pattern_name": name,
            "trigger": f"用户问节奏、15节拍、{name} 如何设计时使用。",
            "steps": [
                "先说明该节拍的故事功能",
                "再给同类案例的机制而不是剧情复述",
                "最后转译为用户项目里的新事件",
            ],
            "good_for": examples,
            "avoid_when": ["用户要的是完整剧本正文", "当前故事缺少主角目标"],
            "quality_check": ["节拍位置清楚", "人物状态有变化", "压力升级可见"],
        })

    for idx, (name, cards) in enumerate(sorted(by_scene_pressure.items())[:40], start=1):
        examples = [card["title"] for card in cards[:3]]
        patterns.append({
            "id": f"pattern_scene_{idx:02d}",
            "category": "scene_pressure",
            "pattern_name": name,
            "trigger": "用户需要增强单场戏、桥段、冲突、信息差或反转时使用。",
            "steps": [
                "确定场景目标和权力关系",
                "制造双方掌握信息或筹码的不对称",
                "让每一步升级改变人物下一步选择",
            ],
            "good_for": examples,
            "avoid_when": ["用户只要宏观世界观", "场景没有明确人物行动"],
            "quality_check": ["场景结尾必须发生转向", "机制必须迁移到原创人物和原创处境"],
        })

    patterns.extend([
        {
            "id": "pattern_failure_01",
            "category": "failure_mode",
            "pattern_name": "只像影评，不像开发建议",
            "trigger": "回答停留在评价、主题和形容词，没有改写动作。",
            "steps": ["指出具体问题", "绑定到场景/人物选择", "给可执行改法"],
            "good_for": ["剧本诊断", "改写建议"],
            "avoid_when": [],
            "quality_check": ["每条建议都有可拍动作"],
        },
        {
            "id": "pattern_failure_02",
            "category": "failure_mode",
            "pattern_name": "借鉴经典过度",
            "trigger": "案例检索后输出接近原片人物、场景或事件顺序。",
            "steps": ["只保留机制", "替换人设和压力源", "改变场景空间和行动结果"],
            "good_for": ["经典案例迁移", "桥段改写"],
            "avoid_when": [],
            "quality_check": ["不可复用对白和完整桥段"],
        },
    ])
    return patterns


def xor_stream(data: bytes, record_id: str) -> bytes:
    output = bytearray()
    counter = 0
    while len(output) < len(data):
        seed = OBFUSCATION_KEY + record_id.encode("utf-8") + counter.to_bytes(8, "big")
        output.extend(hashlib.sha256(seed).digest())
        counter += 1
    return bytes(byte ^ mask for byte, mask in zip(data, output))


def encode_text(text: str, record_id: str) -> str:
    compressed = zlib.compress(text.encode("utf-8"))
    encrypted = xor_stream(compressed, record_id)
    return base64.b64encode(encrypted).decode("ascii")


def build_full_text(sources: list[stc.SourceRow], manifest_records: list[dict[str, Any]], output_dir: Path) -> list[dict[str, Any]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    for old in output_dir.glob("*"):
        if old.is_file():
            old.unlink()
    manifest_by_cache = {item["cache_file"]: item for item in manifest_records}
    ft_records: list[dict[str, Any]] = []
    for source in sources:
        manifest_item = manifest_by_cache[source.cache_file]
        full_text_id = manifest_item["full_text_id"]
        encoded_name = f"{full_text_id}.enc"
        text = source.text_path.read_text(encoding="utf-8", errors="ignore")
        (output_dir / encoded_name).write_text(encode_text(text, full_text_id), encoding="ascii")
        ft_records.append({
            "id": full_text_id,
            "source_id": manifest_item["id"],
            "film_id": manifest_item["film_id"],
            "encoded_name": encoded_name,
            "title_hash": hashlib.sha256(manifest_item["title"].encode("utf-8")).hexdigest()[:16],
            "source_path": manifest_item["source_path"],
            "category": manifest_item["category"],
            "word_count": manifest_item["word_count"],
            "char_count": manifest_item["char_count"],
            "encrypted": True,
            "obfuscation": "built-in XOR stream over compressed UTF-8; anti-casual-reading only",
        })
    write_jsonl(output_dir / "manifest.jsonl", ft_records)
    return ft_records


def clear_full_text(output_dir: Path) -> None:
    if output_dir.exists():
        shutil.rmtree(output_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-root", default=os.environ.get("MOVIE_SKILL_CACHE_ROOT"), required=os.environ.get("MOVIE_SKILL_CACHE_ROOT") is None, help="Path to the local screenplay cache root (or set MOVIE_SKILL_CACHE_ROOT).")
    parser.add_argument("--skill-root", default=str(skill_root()))
    parser.add_argument("--min-chars", type=int, default=1000)
    parser.add_argument("--include-full-text", action="store_true")
    parser.add_argument("--clear-full-text", action="store_true")
    args = parser.parse_args()

    root = Path(args.skill_root).expanduser().resolve()
    cache_root = Path(args.cache_root).expanduser().resolve()
    cache_manifest = cache_root / "_gpts_material_cache" / "source_manifest.csv"
    if not cache_manifest.exists():
        raise SystemExit(f"Missing source manifest: {cache_manifest}")

    sources, excluded = stc.load_sources(cache_manifest, cache_root, args.min_chars)
    rows = read_csv(cache_manifest)
    l1, l2, l3, scene_counts, type_counts = generated_cards(sources)
    case_cards = [normalize_card(record) for record in [*l1, *l2, *l3]]
    manifest_records = build_manifest(rows, sources, excluded, cache_root)
    patterns = build_patterns(case_cards)

    library_dir = root / "assets" / "library"
    write_jsonl(library_dir / "manifest.jsonl", manifest_records)
    write_jsonl(library_dir / "case_cards.jsonl", case_cards)
    write_jsonl(library_dir / "patterns.jsonl", patterns)

    full_text_dir = root / "assets" / "full-text"
    full_text_count = 0
    if args.clear_full_text and not args.include_full_text:
        clear_full_text(full_text_dir)
    if args.include_full_text:
        full_text_count = len(build_full_text(sources, manifest_records, full_text_dir))

    stats = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "skill_name": "movie-development-skill",
        "cache_root_label": str(cache_root),
        "source_manifest": str(cache_manifest),
        "source_counts": {
            "manifest": len(manifest_records),
            "indexed_pdf_scripts": len(sources),
            "excluded": len(excluded),
            "episode_transcripts": sum(1 for item in manifest_records if item["source_type"] == "episode_transcript"),
            "low_text_or_other_excluded": len(excluded) - sum(1 for item in excluded if item["reason"] == "source_type_not_pdf_script"),
        },
        "card_counts": {
            "l1": len(l1),
            "l2": len(l2),
            "l3": len(l3),
            "total": len(case_cards),
        },
        "target_counts": {
            "manifest": 222,
            "case_cards": 4160,
            "full_text": 160,
        },
        "stc_type_counts": {key: value for key, value in type_counts.items() if value},
        "source_type_counts": dict(Counter(item["source_type"] for item in manifest_records)),
        "tag_counts": dict(Counter(tag for item in manifest_records for tag in item.get("tags", []))),
        "scene_detection": {
            "min_detected_scenes": min(scene_counts.values()) if scene_counts else 0,
            "max_detected_scenes": max(scene_counts.values()) if scene_counts else 0,
            "films_with_under_10_detected_scenes": [
                {"title": title, "scene_count": count}
                for title, count in sorted(scene_counts.items())
                if count < 10
            ],
        },
        "full_text": {
            "present": args.include_full_text,
            "count": full_text_count,
            "directory": "assets/full-text" if args.include_full_text else "",
            "note": "Local search layer only; excluded from shareable packages.",
        },
        "files": {
            "manifest": "assets/library/manifest.jsonl",
            "case_cards": "assets/library/case_cards.jsonl",
            "patterns": "assets/library/patterns.jsonl",
            "type_stats": "assets/library/type_stats.json",
        },
    }
    write_json(library_dir / "type_stats.json", stats)
    print(json.dumps({
        "manifest": len(manifest_records),
        "case_cards": len(case_cards),
        "patterns": len(patterns),
        "full_text": full_text_count,
    }, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

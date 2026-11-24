#!/usr/bin/env python3
"""Validate movie-development-skill structure, data, search, and packages."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any


SKILL_NAME = "movie-development-skill"
OLD_NAME = "movie-development-" + "guide"
OLD_ZIP_NAME = OLD_NAME + "-skill"
OLD_LIBRARY_DIR = "assets/" + "save" + "-the-cat-index"


def default_root() -> Path:
    return Path(__file__).resolve().parents[1]


def fail(message: str) -> None:
    raise SystemExit(f"FAIL {message}")


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        fail(f"missing {path}")
    records: list[dict[str, Any]] = []
    ids: set[str] = set()
    with path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                fail(f"invalid jsonl {path}:{line_no}: {exc}")
            record_id = record.get("id")
            if not record_id:
                fail(f"missing id {path}:{line_no}")
            if record_id in ids:
                fail(f"duplicate id {record_id} in {path}")
            ids.add(record_id)
            records.append(record)
    return records


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        fail(f"missing {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def check_skill_metadata(root: Path) -> None:
    skill = root / "SKILL.md"
    if not skill.exists():
        fail("missing SKILL.md")
    text = skill.read_text(encoding="utf-8")
    match = re.search(r"(?m)^name:\s*(.+)$", text)
    if not match:
        fail("missing SKILL.md name frontmatter")
    if match.group(1).strip() != SKILL_NAME:
        fail(f"SKILL.md name must be {SKILL_NAME}")
    if (
        "$movie-development-skill" not in text
        and "movie-development-skill/scripts" not in text
        and "scripts/search_library.py" not in text
    ):
        fail("SKILL.md does not expose new invocation or script path")

    openai = root / "agents" / "openai.yaml"
    if not openai.exists():
        fail("missing agents/openai.yaml")
    openai_text = openai.read_text(encoding="utf-8")
    if "$movie-development-skill" not in openai_text:
        fail("agents/openai.yaml default prompt does not use new skill name")


def check_references(root: Path) -> None:
    required = [
        "00_剧本开发总索引与使用说明.md",
        "结构A_故事线与类型.md",
        "结构B_15节拍写作手册.md",
        "结构C_节奏分场与第三幕.md",
        "结构D_结构诊断.md",
        "人物原型设计库.md",
        "人物弧光与关系冲突库.md",
        "群像支线暗线设计指南.md",
        "类型片场景模板库.md",
        "高质量场景拆解案例库.md",
        "对白A_方法核心.md",
        "对白B_场景类型对白库.md",
        "对白C_人物声音库.md",
        "对白D_改写案例库.md",
        "剧本诊断与改写工作流.md",
    ]
    retired = ["剧本结构与节拍指南.md", "对白撰写指南.md"]
    for name in retired:
        if (root / "references" / name).exists():
            fail(f"retired reference still present (now split into A/B/C/D files): {name}")
    ref_dir = root / "references"
    for name in required:
        path = ref_dir / name
        if not path.exists():
            fail(f"missing reference {name}")
        text = path.read_text(encoding="utf-8")
        if name == "00_剧本开发总索引与使用说明.md" and "assets/library" not in text:
            fail("root reference does not document assets/library")


def require_fields(records: list[dict[str, Any]], fields: list[str], label: str) -> None:
    for index, record in enumerate(records, start=1):
        for field in fields:
            if field not in record:
                fail(f"{label} record {index} missing {field}")


def check_library(root: Path) -> tuple[int, int, int]:
    library = root / "assets" / "library"
    manifest = load_jsonl(library / "manifest.jsonl")
    case_cards = load_jsonl(library / "case_cards.jsonl")
    patterns = load_jsonl(library / "patterns.jsonl")
    stats = load_json(library / "type_stats.json")

    require_fields(manifest, ["id", "title", "category", "source_path", "cache_file", "indexed", "privacy"], "manifest")
    require_fields(case_cards, ["id", "detail", "card_type", "title", "category", "core_mechanism", "payload"], "case card")
    require_fields(patterns, ["id", "category", "pattern_name", "trigger", "steps", "quality_check"], "pattern")

    expected_manifest = int(stats.get("target_counts", {}).get("manifest", 222))
    expected_cards = int(stats.get("target_counts", {}).get("case_cards", 4160))
    if len(manifest) != expected_manifest:
        fail(f"manifest count {len(manifest)} != {expected_manifest}")
    if len(case_cards) != expected_cards:
        fail(f"case card count {len(case_cards)} != {expected_cards}")
    detail_counts: dict[str, int] = {}
    for card in case_cards:
        detail_counts[str(card.get("detail"))] = detail_counts.get(str(card.get("detail")), 0) + 1
    if detail_counts.get("l1") != 160 or detail_counts.get("l2") != 2400 or detail_counts.get("l3") != 1600:
        fail(f"unexpected detail counts {detail_counts}")
    if len(patterns) < 25:
        fail(f"too few patterns: {len(patterns)}")
    return len(manifest), len(case_cards), len(patterns)


def check_search(root: Path) -> None:
    commands = [
        [sys.executable, str(root / "scripts" / "search_library.py"), "中点 关系破裂", "--detail", "l2", "--top", "3"],
        [sys.executable, str(root / "scripts" / "search_library.py"), "审讯 信息差 权力反转", "--detail", "l3", "--top", "3"],
        [sys.executable, str(root / "scripts" / "inspect_case.py"), "film_003"],
    ]
    for command in commands:
        result = subprocess.run(command, cwd=str(root), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if result.returncode != 0:
            fail(f"command failed: {' '.join(command)}\n{result.stderr}")
        if not result.stdout.strip():
            fail(f"command returned empty output: {' '.join(command)}")


def check_full_text(root: Path, require_full_text: bool) -> int:
    ft_dir = root / "assets" / "full-text"
    ft_manifest = ft_dir / "manifest.jsonl"
    if not ft_manifest.exists():
        if require_full_text:
            fail("full-text layer required but missing")
        return 0
    records = load_jsonl(ft_manifest)
    require_fields(records, ["id", "source_id", "encoded_name", "encrypted"], "full-text")
    for record in records:
        encoded = ft_dir / str(record["encoded_name"])
        if not encoded.exists():
            fail(f"missing full-text asset {encoded.name}")
        if not str(record["encoded_name"]).startswith("ft_") or not str(record["encoded_name"]).endswith(".enc"):
            fail(f"unexpected full-text filename {record['encoded_name']}")
    if require_full_text and len(records) != 160:
        fail(f"full-text count {len(records)} != 160")
    result = subprocess.run(
        [sys.executable, str(root / "scripts" / "search_full_text.py"), "prison hope escape", "--top", "3"],
        cwd=str(root),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if require_full_text and (result.returncode != 0 or not result.stdout.strip() or "Optional local full-text layer is not installed" in result.stdout):
        fail(f"full-text search failed\n{result.stderr}\n{result.stdout}")
    return len(records)


def is_text_file(path: Path) -> bool:
    if path.suffix.lower() in {".enc", ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".pyc"}:
        return False
    if "assets/full-text" in path.as_posix():
        return False
    return path.is_file()


def check_stale_terms(root: Path) -> None:
    forbidden = [OLD_NAME, OLD_ZIP_NAME, OLD_LIBRARY_DIR, "search" + "_stc_cases", "inspect" + "_stc_case"]
    hits: list[str] = []
    for path in root.rglob("*"):
        if not is_text_file(path):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for term in forbidden:
            if term in text:
                hits.append(f"{path.relative_to(root)} contains {term}")
    if hits:
        fail("stale terms found:\n" + "\n".join(hits[:20]))


def check_share_mode(root: Path) -> None:
    if any(root.rglob("*.pdf")):
        fail("share mode must not include raw PDFs")


def check_package(package: Path, require_full_text: bool) -> None:
    if not package.exists():
        fail(f"missing package {package}")
    with zipfile.ZipFile(package) as zf:
        names = zf.namelist()
    if not names:
        fail("package is empty")
    roots = {name.split("/", 1)[0] for name in names if name and not name.startswith("__MACOSX/")}
    if roots != {SKILL_NAME}:
        fail(f"package root must be {SKILL_NAME}, got {sorted(roots)}")
    forbidden_fragments = [
        ".DS_Store",
        "__pycache__",
        ".pyc",
        OLD_NAME,
        OLD_LIBRARY_DIR,
    ]
    bad = [name for name in names if any(fragment in name for fragment in forbidden_fragments)]
    if bad:
        fail("package contains forbidden entries:\n" + "\n".join(bad[:20]))
    if require_full_text:
        prefix = f"{SKILL_NAME}/assets/full-text/"
        manifest_name = f"{prefix}manifest.jsonl"
        enc_count = sum(1 for name in names if name.startswith(prefix) and name.endswith(".enc"))
        if manifest_name not in names:
            fail("package is missing assets/full-text/manifest.jsonl")
        if enc_count != 160:
            fail(f"package full-text asset count {enc_count} != 160")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill-root", default=str(default_root()))
    parser.add_argument("--mode", choices=["share", "local"], default="share")
    parser.add_argument("--require-full-text", action="store_true")
    parser.add_argument("--package")
    args = parser.parse_args()

    package_path = Path(args.package).expanduser().resolve() if args.package else None
    if package_path:
        check_package(package_path, args.require_full_text)

    root = Path(args.skill_root).expanduser().resolve()
    check_skill_metadata(root)
    check_references(root)
    manifest_count, case_count, pattern_count = check_library(root)
    check_search(root)
    if args.mode == "share":
        check_share_mode(root)
        full_text_count = 0
    else:
        full_text_count = check_full_text(root, args.require_full_text)
    check_stale_terms(root)

    print(
        f"PASS {SKILL_NAME} validation "
        f"mode={args.mode} manifest={manifest_count} case_cards={case_count} "
        f"patterns={pattern_count} full_text={full_text_count}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

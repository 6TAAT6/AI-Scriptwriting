#!/usr/bin/env python3
"""Build the shareable movie-development-skill ZIP."""

from __future__ import annotations

import argparse
import zipfile
from pathlib import Path


SKILL_NAME = "movie-development-skill"


def default_root() -> Path:
    return Path(__file__).resolve().parents[1]


def should_exclude(path: Path, root: Path, exclude_full_text: bool) -> bool:
    rel = path.relative_to(root).as_posix()
    parts = set(path.relative_to(root).parts)
    if ".DS_Store" in parts or "__pycache__" in parts:
        return True
    if exclude_full_text and rel.startswith("assets/full-text/"):
        return True
    if path.suffix.lower() in {".pyc", ".pyo", ".pdf", ".zip", ".log", ".tmp"}:
        return True
    if path.name.startswith("."):
        return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", default=str(default_root()))
    parser.add_argument("--output", default=str(default_root().parent / "movie-development-skill.zip"))
    parser.add_argument("--exclude-full-text", action="store_true", help="Build a distilled-only package without assets/full-text.")
    args = parser.parse_args()

    source_root = Path(args.source_root).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    if source_root.name != SKILL_NAME:
        raise SystemExit(f"source root must be named {SKILL_NAME}: {source_root}")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(source_root.rglob("*")):
            if path.is_dir() or should_exclude(path, source_root, args.exclude_full_text):
                continue
            arcname = f"{SKILL_NAME}/{path.relative_to(source_root).as_posix()}"
            zf.write(path, arcname)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

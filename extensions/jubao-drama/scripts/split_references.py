"""把大参考文档按章节拆成“目录 + 分节”，让模型只读本轮任务需要的部分。

正式版 267 个会话的统计：每会话加载规则与参考资料中位 3.7 万字、最多 149 万字，其中参考资料占 49%；
一次写 600 字的正文会先读入 7.5 万字的 writing.md。拆分只按标题切开原文，分节首尾相接即原文全文，
不改写任何规则；原整份文件移到 ``skill-sources/``（不分发给员工进程），供核对与后续更新。

用法：python scripts/split_references.py <skill 名> <参考文档名>...
"""

from __future__ import annotations

from pathlib import Path
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
_TARGET = 9000  # 每节约 9 千字以内；单个章节超过时独立成节，不在章节中间切开
_HEADING = re.compile(r"^(#{1,2}) (.+)$")


def _blocks(lines):
    """在一、二级标题处切块（代码块内的井号行不算标题）；返回 (级别, 标题, 行列表)。"""
    blocks, fenced = [[0, "", []]], False
    for line in lines:
        if line.lstrip().startswith("```"):
            fenced = not fenced
        match = None if fenced else _HEADING.match(line.rstrip("\r\n"))
        if match:
            blocks.append([len(match[1]), match[2].strip(), []])
        blocks[-1][2].append(line)
    return [block for block in blocks if block[2]]


def split(text: str) -> list[dict]:
    chunks, current = [], None
    for level, title, lines in _blocks(text.splitlines(keepends=True)):
        body = "".join(lines)
        # 开篇的元信息与一级标题合为一节；之后每个一级标题另起一节，过长时在二级标题处续切。
        if current is None or level == 1 and current["size"] > 500 or current["size"] + len(body) > _TARGET:
            current = {"titles": [], "parts": [], "size": 0}
            chunks.append(current)
        current["parts"].append(body)
        current["size"] += len(body)
        if title:
            current["titles"].append(("# " if level == 1 else "") + title)
    return [{"text": "".join(chunk["parts"]), "titles": chunk["titles"]} for chunk in chunks]


def _index(name: str, chunks: list[dict], total: int) -> str:
    rows = [f"# {name}.md 目录（已按章节拆分）", "",
            f"原文共 {total} 字，已原样拆为 {len(chunks)} 节，内容未改动。先看本目录，再用 skill_view 读取本轮任务需要的分节，"
            "例如 `references/" + name + "/01.md`。第 01 节含开场说明与核心原则，进入该阶段时先读；"
            "与本轮任务无关的分节（其他写作模式、其他节奏风格、与本场无关的库区、未触发的指令说明等）不要读取。", ""]
    for number, chunk in enumerate(chunks, 1):
        titles = "；".join(title for title in chunk["titles"] if title)[:400] or "（开篇说明）"
        rows.append(f"- `{number:02d}.md`（{len(chunk['text'])} 字）：{titles}")
    return "\n".join(rows) + "\n"


def run(skill: str, names: list[str]) -> None:
    references = ROOT / "skills" / skill / "references"
    archive = ROOT / "skill-sources" / skill / "references"
    archive.mkdir(parents=True, exist_ok=True)
    for name in names:
        source = references / f"{name}.md"
        if not source.is_file():
            source = archive / f"{name}.md"
        text = source.read_text(encoding="utf-8")
        chunks = split(text)
        assert "".join(chunk["text"] for chunk in chunks) == text
        target = references / name
        if target.exists():
            shutil.rmtree(target)
        target.mkdir()
        for number, chunk in enumerate(chunks, 1):
            (target / f"{number:02d}.md").write_text(chunk["text"], encoding="utf-8")
        (target / "index.md").write_text(_index(name, chunks, len(text)), encoding="utf-8")
        if source.parent == references:
            shutil.move(str(source), archive / f"{name}.md")
        print(f"{name}: {len(text)} 字 → {len(chunks)} 节")


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2:])

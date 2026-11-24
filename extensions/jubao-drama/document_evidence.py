"""从实际稿件计算有明确范围的字数，不采用正文中的统计或验收声明。"""

import hashlib
import re

from .manuscript_text import visible_manuscript


_HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002fa1f\U00030000-\U000323af]+")
_EPISODE_HEADING = re.compile(
    r"^[\t ]*(?:(?:[-+*]|\d+[.)、])\s+)?[\t #*]*(?:《[^》\n]+》[\t ]*)?第[\t ]*([0-9]{1,4}|[〇零一二三四五六七八九十百千两]{1,8})[\t ]*集"
    r"(?:[\t ]*[*#]+)?(?=[\t :：·—\-（(《【]|$)[^\n]*(?:\n|$)", re.MULTILINE,
)
_EPISODE_LIMIT = 20
_MARKER_TAIL = re.compile(r"[\t ]*集(?:[\t ]*[*#]+)?")
_INLINE_LEAD = re.compile(r"[\t ：:·—\-*#]*")
_SECTION_LINE = re.compile(r"^[\t ]*(?:#{1,6}[\t ]+\S|\**[一二三四五六七八九十]{1,3}[、．])", re.MULTILINE)


def episode_span(visible, headings, index):
    """一集正文在可见文本中的 [起, 止)。

    分集大纲与分析稿常把内容写在标题同一行（“- **第1集**：三年前……。”）。整行当标题跳过时，每集都算成
    0 字，最后一集还会吞下后面所有小节（2026-11-19 测试版卡片：第1—6集 0 字、第7集 1,760 字）。
    同一行写着句子或超过 40 字时，从冒号后算正文，并在下一个章节标题处截止；“第10集”独占一行的剧本照旧。
    """
    heading = headings[index]
    end = headings[index + 1].start() if index + 1 < len(headings) else len(visible)
    lead = _INLINE_LEAD.match(visible, _MARKER_TAIL.match(visible, heading.end(1)).end())
    rest = visible[lead.end():heading.end()].strip()
    if not rest or not (re.search(r"[。！？!?；]", rest) or len(rest) > 40):
        return heading.end(), end
    section = _SECTION_LINE.search(visible, heading.end(), end)
    return lead.end(), section.start() if section else end


def receipt_scopes(receipt):
    """补充既有 Word 字段的含义，不推断新检查、不改写旧回执或文件。"""
    if receipt.get("format") != "docx":
        return {}
    scopes = {
        "source_sha256": "source_text_lf_normalized",
        "content_sha256": "exported_text_lf_joined_without_layout_spacers",
        "sha256": "file_bytes",
    }
    result = {"hash_scopes": {key: value for key, value in scopes.items()
                              if isinstance(receipt.get(key), str) and re.fullmatch(r"[0-9a-f]{64}", receipt[key])}}
    if type(receipt.get("paragraphs")) is int and receipt["paragraphs"] >= 0:
        result["paragraphs_scope"] = "nonempty_top_level_content_paragraphs_excluding_table_cells"
    return result


def _counts(content):
    return {
        "han_characters": sum(len(match[0]) for match in _HAN.finditer(content)),
        "non_whitespace_characters": sum(not char.isspace() for char in content),
    }


def text_statistics(content):
    """总计覆盖全文；分集只排除独立集标题，保留场头、人物、动作和对白。"""
    source = content.replace("\r\n", "\n").replace("\r", "\n")
    visible, _ = visible_manuscript(source)
    headings = list(_EPISODE_HEADING.finditer(visible))
    episodes = []
    body_totals = {"han_characters": 0, "non_whitespace_characters": 0}
    for index, heading in enumerate(headings):
        start, end = episode_span(visible, headings, index)
        counts = _counts(visible[start:end])
        for key, value in counts.items():
            body_totals[key] += value
        if index < _EPISODE_LIMIT:
            number = str(int(heading[1])) if heading[1].isascii() else heading[1]
            episodes.append({"episode": f"第{number}集", **counts})
    return {
        "method": "unicode_han_and_non_whitespace_v1",
        "scope": "source_text_lf_normalized",
        "total_scope": "whole_source_including_headings",
        "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
        "text_scope": "HTML按可见正文统计，原始稿件摘要不去标签",
        **_counts(visible),
        "episode_scope": "body_excluding_episode_heading",
        "episodes": episodes,
        "episode_count": len(headings),
        "episodes_truncated": len(headings) > len(episodes),
        "episode_body_totals": {"scope": "recognized_episode_bodies_excluding_headings", **body_totals,
                                "episode_count": len(headings), "coverage_complete": bool(headings)},
    }

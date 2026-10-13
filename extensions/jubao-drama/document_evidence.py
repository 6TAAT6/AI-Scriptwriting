"""从实际稿件计算有明确范围的字数，不采用正文中的统计或验收声明。"""

import hashlib
import re


_HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002fa1f\U00030000-\U000323af]+")
_EPISODE_HEADING = re.compile(
    r"^[\t #*]*第[\t ]*([0-9]{1,4}|[〇零一二三四五六七八九十百千两]{1,8})[\t ]*集"
    r"(?:[\t ]*[*#]+)?(?=[\t :：·—\-（(《]|$)[^\n]*(?:\n|$)", re.MULTILINE,
)
_EPISODE_LIMIT = 20


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
    headings = list(_EPISODE_HEADING.finditer(source))
    episodes = []
    body_totals = {"han_characters": 0, "non_whitespace_characters": 0}
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(source)
        counts = _counts(source[heading.end():end])
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
        **_counts(source),
        "episode_scope": "body_excluding_episode_heading",
        "episodes": episodes,
        "episode_count": len(headings),
        "episodes_truncated": len(headings) > len(episodes),
        "episode_body_totals": {"scope": "recognized_episode_bodies_excluding_headings", **body_totals,
                                "episode_count": len(headings), "coverage_complete": bool(headings)},
    }

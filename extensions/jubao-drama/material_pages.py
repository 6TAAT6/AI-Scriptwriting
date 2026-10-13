"""原稿完整保留，模型逐段读取；不分页加载技能或提示词。"""
import re

from .documents import read_material


_EPISODE_MARKER = re.compile(
    r"(?<!\d)第\s*(?P<start>\d{1,4})(?:\s*[—–\-~至到]\s*(?P<end>\d{1,4}))?\s*集"
)


def _episode_range(text: str, start: int, end: int) -> str:
    """Return the conservative episode span explicitly visible in one text slice.

    A page may begin in the middle of an episode.  In that case the nearest marker before
    ``start`` is included as the page's inherited context, while markers at or after
    ``end`` remain outside the evidence scope.
    """
    all_markers = list(_EPISODE_MARKER.finditer(text))
    markers = [match for match in all_markers if match.start() < end]
    previous = [match for match in markers if match.start() <= start]
    if previous:
        current = previous[-1]
        markers = [match for match in markers if match is current or match.start() > start]
    if not markers:
        return "未识别"
    starts = [int(match.group("start")) for match in markers]
    ends = [int(match.group("end") or match.group("start")) for match in markers]
    first, last = min(starts), max(ends)
    return f"第{first}集" if first == last else f"第{first}—{last}集"


def material_page(args):
    if not isinstance(args, dict) or set(args) - {'path', 'start_char', 'max_chars', 'content_sha256'}:
        raise ValueError('资料读取只接受 path、start_char、max_chars 和 content_sha256')
    start = args.get('start_char', 0)
    size = args.get('max_chars', 12000)
    if type(start) is not int or start < 0 or type(size) is not int or not 1000 <= size <= 20000:
        raise ValueError('起始字符必须为非负整数，单段读取范围为 1,000 至 20,000 个字符')
    material = read_material(args.get('path', ''))
    expected = args.get('content_sha256')
    if expected is not None and expected != material['content_sha256']:
        raise ValueError('原稿内容已变化，请从第一段重新读取，不能拼接不同版本')
    text = material['text']
    if start > len(text):
        raise ValueError('起始位置超出原稿字符总数')
    end = min(len(text), start + size)
    page_text = text[start:end]
    episode_range = _episode_range(text, start, end)
    scope = {
        'start_char': start,
        'end_char': end,
        'characters': len(text),
        'episode_range': episode_range,
        'content_sha256': material['content_sha256'],
    }
    return {
        **material,
        'text': page_text,
        'start_char': start,
        'end_char': end,
        'source_start_char': start,
        'source_end_char': end,
        'source_characters': len(text),
        'episode_range': episode_range,
        'source_scope': scope,
        'has_more': end < len(text),
        'next_start_char': end if end < len(text) else None,
    }

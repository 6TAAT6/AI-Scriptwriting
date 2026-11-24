"""原稿完整保留，模型逐段读取；不分页加载技能或提示词。"""
import re

from .documents import read_material
from .document_parameters import ReadParameterError


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
    if not isinstance(args, dict) or set(args) - {'path', 'start_char', 'max_chars', 'content_sha256', 'sheet', 'cell_range', 'file_sha256'}:
        raise ReadParameterError('资料读取参数不支持；全文用 path、可选 sheet、start_char、max_chars、content_sha256（仅同一 sheet 续读），工作表切换或首次读取工作表用 file_sha256；单元格用 path、sheet、cell_range、file_sha256')
    if 'cell_range' in args:
        if {'start_char', 'max_chars', 'content_sha256'} & args.keys():
            raise ReadParameterError('精确单元格读取不能与全文字符分页参数混用')
        from .material_cells import material_cells
        return material_cells(args)
    start = args.get('start_char', 0)
    size = args.get('max_chars', 12000)
    if type(start) is not int or start < 0 or type(size) is not int or not 1000 <= size <= 100000:
        raise ReadParameterError('起始字符必须为非负整数，单段读取范围为 1,000 至 100,000 个字符')
    material = read_material(args.get('path', ''), sheet=args.get('sheet'), file_sha256=args.get('file_sha256'))
    expected = args.get('content_sha256')
    if expected is not None and expected != material['content_sha256']:
        # 内容摘要属于所选文本范围；同一工作簿的不同工作表有不同摘要。
        raise ReadParameterError('本次读取的资料版本与上一段不同（可能换了工作表或文件）：content_sha256 仅用于同一 sheet 的字符续读；'
                                 '更换 sheet 或首次读取工作表时省略 content_sha256，使用 file_sha256，并从 start_char=0 重新读取；'
                                 '之后同一 sheet 才携带本次返回的 content_sha256，不要拼接不同版本的内容')
    text = material['text']
    if start > len(text):
        raise ReadParameterError('起始位置超出原稿字符总数，请使用上次返回的 next_start_char')
    end = min(len(text), start + size)
    page_text = text[start:end]
    episode_range = _episode_range(text, start, end)
    scope = {
        'start_char': start,
        'end_char': end,
        'characters': len(text),
        'episode_range': episode_range,
        'content_sha256': material['content_sha256'],
        **{key: material[key] for key in ('sheet', 'sheet_visibility', 'file_sha256', 'read_sheets', 'unread_sheets') if key in material},
    }
    continuation = None
    if end < len(text):
        continuation = {'path': material['path'], 'start_char': end, 'max_chars': size,
                        'content_sha256': material['content_sha256']}
        if material.get('sheet'):
            continuation['sheet'] = material['sheet']
        if material.get('file_sha256'):
            continuation['file_sha256'] = material['file_sha256']
    sheet_reads = []
    # 默认文本流串接所有可见表，但模型仍可能选择其中一张单独读；每个可切换目标都给出独立首读参数。
    for sheet_name in material.get('available_sheets', []):
        if sheet_name == material.get('sheet'):
            continue
        item = {'path': material['path'], 'sheet': sheet_name, 'start_char': 0, 'max_chars': size}
        if material.get('file_sha256'):
            item['file_sha256'] = material['file_sha256']
        sheet_reads.append(item)
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
        'next_call': continuation,
        'sheet_reads': sheet_reads,
        'has_more': end < len(text),
        'next_start_char': end if end < len(text) else None,
        **({'workbook_coverage_complete': material['workbook_coverage_complete'] and end == len(text)}
           if 'workbook_coverage_complete' in material else {}),
    }

"""按工作表与坐标读取真实单元格，不运行公式、宏或外部链接。"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import PurePosixPath
import re

from .documents import MAX_FILE_BYTES, MAX_TEXT_CHARACTERS, S, R, _archive, _path, _xml
from .document_parameters import ReadParameterError
from .security import read_document_bytes

MAX_CELLS = 200


def _coordinate(value):
    match = re.fullmatch(r'\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})', value or '')
    if not match:
        raise ValueError('单元格须为 A1 格式，范围须为 A1:B5 格式')
    column = 0
    for letter in match[1].upper():
        column = column * 26 + ord(letter) - 64
    row = int(match[2])
    if column > 16384 or row > 1048576:
        raise ValueError('单元格坐标超出 Excel 工作表范围')
    return row, column


def _address(row, column):
    letters = ''
    while column:
        column, remainder = divmod(column - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters + str(row)


def _range(value):
    if not isinstance(value, str) or value.count(':') > 1:
        raise ValueError('cell_range 须为单个单元格或矩形范围')
    parts = value.strip().split(':')
    first, last = _coordinate(parts[0]), _coordinate(parts[-1])
    if first[0] > last[0] or first[1] > last[1]:
        raise ValueError('单元格范围的起点不能位于终点之后')
    return (*first, *last)


def _range_name(bounds):
    r1, c1, r2, c2 = bounds
    first, last = _address(r1, c1), _address(r2, c2)
    return first if first == last else first + ':' + last


def _choose_sheet(names, requested):
    if not isinstance(requested, str) or not requested or requested not in names:
        raise ReadParameterError('请通过 sheet 指定准确的工作表名称；可选：' + json.dumps(names, ensure_ascii=False))
    if names.count(requested) != 1:
        raise ValueError('工作簿存在重复工作表名称，无法唯一定位')
    return names.index(requested)


def workbook_sheets(data, extension):
    """隐藏是显示属性；列出同一上传文件内全部工作表，不把未读表当作不存在。"""
    if extension == 'xls':
        try:
            import xlrd
            from xlrd.compdoc import CompDocError
        except ImportError:
            raise ValueError('当前创作服务缺少 XLS 读取组件') from None
        try:
            with xlrd.open_workbook(file_contents=data, on_demand=True) as book:
                states = {0: 'visible', 1: 'hidden', 2: 'veryHidden'}
                return [{'name': sheet.name, 'visibility': states.get(sheet.visibility, 'hidden')}
                        for sheet in (book.sheet_by_index(index) for index in range(book.nsheets))]
        except (xlrd.XLRDError, CompDocError, IndexError, KeyError, TypeError):
            raise ValueError('XLS 文件无法解析，可能已加密、损坏或不是有效工作簿') from None
    with _archive(data) as archive:
        root = _xml(archive, 'xl/workbook.xml')
        namespace = root.tag.removesuffix('workbook')
        if namespace not in {f'{{{S}}}', '{http://purl.oclc.org/ooxml/spreadsheetml/main}'}:
            raise ValueError('工作簿格式无法识别')
        return [{'name': sheet.get('name', ''), 'visibility': sheet.get('state', 'visible')}
                for sheet in root.findall(f'{namespace}sheets/{namespace}sheet')]


def _value(value='', kind='blank', *, present=False, **extra):
    return {'value': value, 'value_type': kind, 'present': present, **extra}


def _xlsx_value(cell, namespace, shared):
    kind = cell.get('t')
    raw_node, formula = cell.find(f'{{{namespace}}}v'), cell.find(f'{{{namespace}}}f')
    raw = raw_node.text if raw_node is not None else None
    if kind == 'inlineStr':
        result = _value(''.join(node.text or '' for node in cell.iter(f'{{{namespace}}}t')), 'text', present=True)
    elif kind == 's':
        try:
            index = int(raw)
            if index < 0:
                raise ValueError
            result = _value(shared[index], 'text', present=True)
        except (TypeError, ValueError, IndexError):
            raise ValueError('共享字符串引用无效') from None
    elif kind in {'str', 'e', 'd', 'b'}:
        kinds = {'str': 'text', 'e': 'error', 'd': 'date', 'b': 'boolean'}
        if kind == 'b' and raw not in {'0', '1', None}:
            raise ValueError('工作表布尔值无效')
        result = _value(raw == '1' if kind == 'b' and raw is not None else raw or '', kinds[kind], present=True)
    elif raw is None or raw == '':
        result = _value(present=True)
    else:
        try:
            number = int(raw) if re.fullmatch(r'[+-]?[0-9]+', raw) else float(raw)
            if not math.isfinite(number):
                raise ValueError
            result = _value(int(number) if isinstance(number, float) and number.is_integer() else number, 'number', present=True, raw_value=raw)
        except ValueError:
            raise ValueError('工作表数值无法解析') from None
    if formula is not None:
        cached = raw is not None or kind == 'str' and raw_node is not None
        result.update(formula=formula.text or '', formula_state='cached' if cached else 'not_calculated', formula_attributes=dict(formula.attrib))
        if not cached:
            result.update(value=None, value_type='formula')
    return result


def _xlsx_cells(data, sheet_name, requested):
    with _archive(data) as archive:
        workbook = _xml(archive, 'xl/workbook.xml')
        namespaces = {f'{{{S}}}workbook': (S, R), '{http://purl.oclc.org/ooxml/spreadsheetml/main}workbook': ('http://purl.oclc.org/ooxml/spreadsheetml/main', 'http://purl.oclc.org/ooxml/officeDocument/relationships')}
        if workbook.tag not in namespaces:
            raise ValueError('工作簿格式无法识别')
        namespace, relationship_namespace = namespaces[workbook.tag]
        sheets = list(workbook.findall(f'{{{namespace}}}sheets/{{{namespace}}}sheet'))
        names = [node.get('name', '') for node in sheets]
        sheet = sheets[_choose_sheet(names, sheet_name)]
        relations = {node.get('Id'): node for node in _xml(archive, 'xl/_rels/workbook.xml.rels')}
        relation = relations.get(sheet.get(f'{{{relationship_namespace}}}id'))
        if relation is None or relation.get('TargetMode') == 'External':
            raise ValueError('工作表关系缺失或指向外部文件')
        target = relation.get('Target', '')
        if '..' in PurePosixPath(target).parts or '\\' in target:
            raise ValueError('工作表关系含路径穿越')
        member = target.lstrip('/') if target.startswith('/') else 'xl/' + target
        if not member.startswith('xl/'):
            raise ValueError('工作表关系超出文档范围')
        worksheet = _xml(archive, member)
        merges = []
        r1, c1, r2, c2 = requested
        for node in worksheet.findall(f'{{{namespace}}}mergeCells/{{{namespace}}}mergeCell'):
            bounds = _range(node.get('ref', ''))
            if bounds[0] <= r2 and bounds[2] >= r1 and bounds[1] <= c2 and bounds[3] >= c1:
                merges.append(bounds)
        needed = {(row, column) for row in range(r1, r2 + 1) for column in range(c1, c2 + 1)} | {(m[0], m[1]) for m in merges}
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            shared = [''.join(node.text or '' for node in item.iter(f'{{{namespace}}}t')) for item in _xml(archive, 'xl/sharedStrings.xml').findall(f'{{{namespace}}}si')]
        values, seen, next_row = {}, set(), 1
        for row in worksheet.findall(f'{{{namespace}}}sheetData/{{{namespace}}}row'):
            cells = row.findall(f'{{{namespace}}}c')
            first_ref = next((cell.get('r') for cell in cells if cell.get('r')), None)
            row_number = row.get('r')
            if row_number is not None and not re.fullmatch(r'[1-9][0-9]{0,6}', row_number):
                raise ValueError('工作表行号无效')
            row_number = int(row_number) if row_number is not None else _coordinate(first_ref)[0] if first_ref else next_row
            if row_number > 1048576:
                raise ValueError('工作表行号超出范围')
            next_column = 1
            for cell in cells:
                coordinate = _coordinate(cell.get('r')) if cell.get('r') else (row_number, next_column)
                if coordinate[0] != row_number or coordinate in seen or coordinate[1] > 16384:
                    raise ValueError('工作表单元格与行号不一致或存在重复坐标')
                seen.add(coordinate)
                next_column = coordinate[1] + 1
                if coordinate in needed:
                    values[coordinate] = _xlsx_value(cell, namespace, shared)
            next_row = row_number + 1
        return names, values, merges


def _xls_cells(data, sheet_name, requested):
    try:
        import xlrd
        from xlrd.compdoc import CompDocError
    except ImportError:
        raise ValueError('当前创作服务缺少 XLS 读取组件') from None
    try:
        with xlrd.open_workbook(file_contents=data, on_demand=True, formatting_info=True, ragged_rows=True) as book:
            names = book.sheet_names()
            sheet = book.sheet_by_index(_choose_sheet(names, sheet_name))
            r1, c1, r2, c2 = requested
            if r2 > 65536 or c2 > 256:
                raise ReadParameterError('单元格坐标超出 XLS 工作表范围')
            merges = [(a + 1, c + 1, b, d) for a, b, c, d in sheet.merged_cells if a < r2 and b >= r1 and c < c2 and d >= c1]
            needed = {(row, column) for row in range(r1, r2 + 1) for column in range(c1, c2 + 1)} | {(m[0], m[1]) for m in merges}
            values = {}
            for row, column in needed:
                if row > sheet.nrows or column > sheet.row_len(row - 1):
                    continue
                cell = sheet.cell(row - 1, column - 1)
                kind = {xlrd.XL_CELL_TEXT: 'text', xlrd.XL_CELL_NUMBER: 'number', xlrd.XL_CELL_DATE: 'date', xlrd.XL_CELL_BOOLEAN: 'boolean', xlrd.XL_CELL_ERROR: 'error'}.get(cell.ctype, 'blank')
                value = cell.value
                if kind == 'date':
                    value = xlrd.xldate_as_datetime(value, book.datemode).isoformat(sep=' ')
                elif kind == 'boolean':
                    value = bool(value)
                elif kind == 'error':
                    value = xlrd.error_text_from_code.get(value, '[单元格错误]')
                values[(row, column)] = _value(value, kind, present=cell.ctype != xlrd.XL_CELL_EMPTY, formula_state='not_exposed_by_xls_reader')
            return names, values, merges
    except (xlrd.XLRDError, CompDocError):
        raise ValueError('XLS 文件无法解析，可能已加密、损坏或不是有效工作簿') from None


def material_cells(args):
    source = _path(args.get('path', ''), {'.xls', '.xlsx', '.xlsm'})
    try:
        bounds = _range(args.get('cell_range'))
    except ValueError as exc:
        raise ReadParameterError(str(exc)) from None
    r1, c1, r2, c2 = bounds
    if (r2 - r1 + 1) * (c2 - c1 + 1) > MAX_CELLS:
        raise ReadParameterError(f'一次最多读取 {MAX_CELLS} 个单元格，请缩小范围')
    data = read_document_bytes(source, MAX_FILE_BYTES)
    if not data or len(data) > MAX_FILE_BYTES:
        raise ValueError('材料不能为空且每个文件最多 20 MB')
    digest = hashlib.sha256(data).hexdigest()
    if args.get('file_sha256') is not None and args['file_sha256'] != digest:
        raise ValueError('工作簿内容已变化，请重新确认文件版本后读取，不能拼接不同版本')
    reader = _xls_cells if source.suffix.lower() == '.xls' else _xlsx_cells
    names, values, merges = reader(data, args.get('sheet'), bounds)
    sheets = workbook_sheets(data, source.suffix.lower()[1:])
    visibility = next(sheet['visibility'] for sheet in sheets if sheet['name'] == args['sheet'])
    cells = []
    for row in range(r1, r2 + 1):
        for column in range(c1, c2 + 1):
            cell = {'address': _address(row, column), 'row': row, 'column': column, **values.get((row, column), _value())}
            matching = [m for m in merges if m[0] <= row <= m[2] and m[1] <= column <= m[3]]
            if len(matching) > 1:
                raise ValueError('工作表含重叠的合并范围，无法唯一定位来源')
            if matching:
                merge = matching[0]
                anchor = values.get((merge[0], merge[1]), _value())
                cell.update(merged_range=_range_name(merge), merged_anchor=_address(merge[0], merge[1]), merged_anchor_value=anchor['value'])
            cells.append(cell)
    text = json.dumps(cells, ensure_ascii=False, separators=(',', ':'))
    if len(text) > MAX_TEXT_CHARACTERS:
        raise ReadParameterError('选中单元格内容超过字符上限，请缩小 cell_range 范围')
    content_hash = hashlib.sha256(text.encode()).hexdigest()
    scope = {'mode': 'cells', 'sheet': args['sheet'], 'sheet_visibility': visibility, 'cell_range': _range_name(bounds), 'file_sha256': digest, 'coverage_complete': True,
             'start_char': 0, 'end_char': len(text), 'characters': len(text), 'episode_range': '未识别', 'content_sha256': content_hash}
    return {'mode': 'cells', 'path': str(source), 'name': source.name, 'format': source.suffix.lower()[1:],
            'sha256': digest, 'file_sha256': digest, 'size_bytes': len(data), 'sheet': args['sheet'], 'available_sheets': names,
            'sheets': sheets, 'sheet_visibility': visibility, 'workbook_coverage_complete': False,
            'cell_range': _range_name(bounds), 'cells': cells, 'cell_count': len(cells), 'coverage_complete': True, 'text': text,
            'content_sha256': content_hash, 'characters': len(text), 'source_scope': scope,
            'source_start_char': 0, 'source_end_char': len(text), 'source_characters': len(text), 'episode_range': '未识别',
            'has_more': False, 'next_start_char': None, 'formula_policy': '仅返回文件保存值；不计算公式、不加载外部引用、不执行宏。XLS读取器不提供公式表达式。'}

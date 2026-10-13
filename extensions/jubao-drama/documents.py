"""剧本材料读取及 Office 导出；回执区分内容回读与尚未进行的版式验收。"""

from __future__ import annotations

import hashlib
from io import BytesIO
import json
import math
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
from tempfile import TemporaryFile
import xml.etree.ElementTree as ET
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile

from .document_evidence import receipt_scopes, text_statistics
from .security import data_path, read_document_bytes, restricted, write_document_bytes

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_TEXT_CHARACTERS = 1500000
MAX_EXPORT_CHARACTERS = 1500000
MAX_UNPACKED_BYTES = 60 * 1024 * 1024
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
P = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT = "http://schemas.openxmlformats.org/package/2006/content-types"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

# 固定常用前缀，便于 Office 兼容性诊断。
ET.register_namespace("w", W)
ET.register_namespace("r", R)
ET.register_namespace("rel", P)


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _path(value, suffixes) -> Path:
    candidate = Path(value).expanduser()
    if ".." in candidate.parts or "\x00" in str(candidate):
        raise ValueError("文件路径不能包含上级目录或空字符")
    if candidate.suffix.lower() not in suffixes:
        raise ValueError("文件类型不支持，请使用 TXT、MD、DOCX、XLSX、CSV 或 PDF")
    if restricted():
        return data_path(candidate)[1]
    return candidate.absolute()


def _text(value, limit=MAX_EXPORT_CHARACTERS, *, allow_empty=False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ValueError("稿件内容必须是非空文本")
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    if len(value) > limit:
        raise ValueError(f"稿件有 {len(value):,} 个字符，单份最多 {limit:,} 个字符；请按章节拆分原稿，原文件未修改")
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", value):
        raise ValueError("稿件含 Office 文档无法保存的控制字符")
    return value


def _archive(data: bytes) -> ZipFile:
    try:
        archive = ZipFile(BytesIO(data))
    except BadZipFile as exc:
        raise ValueError("Office 文件不是有效的 ZIP 文档") from exc
    entries = archive.infolist()
    names = [entry.filename for entry in entries]
    invalid = len(entries) > 10000 or len(names) != len(set(names))
    invalid |= sum(entry.file_size for entry in entries) > MAX_UNPACKED_BYTES
    for entry in entries:
        name = PurePosixPath(entry.filename)
        invalid |= (
            name.is_absolute()
            or ".." in name.parts
            or "\\" in entry.filename
            or bool(entry.flag_bits & 1)
            or stat.S_ISLNK(entry.external_attr >> 16)
        )
    if invalid:
        archive.close()
        raise ValueError("文档压缩包含不安全路径、重复条目、加密内容或超量数据")
    return archive


def _xml(archive: ZipFile, name: str) -> ET.Element:
    try:
        data = archive.read(name)
        # 不解析材料内的 DTD 或实体；OOXML 正文不需要这类声明。
        declarations = data.replace(b"\x00", b"").upper()
        if b"<!DOCTYPE" in declarations or b"<!ENTITY" in declarations:
            raise ValueError("文档包含不允许的 XML 实体声明")
        return ET.fromstring(data)
    except (KeyError, BadZipFile, ET.ParseError) as exc:
        raise ValueError("Office 文档缺少必要内容或 XML 损坏") from exc


def _docx_paragraphs(archive: ZipFile) -> list[str]:
    body = _xml(archive, "word/document.xml").find(f"{{{W}}}body")
    if body is None:
        raise ValueError("Word 文档缺少正文")
    paragraphs = []
    for paragraph in body.iter(f"{{{W}}}p"):
        parts = []
        for node in paragraph.iter():
            if node.tag == f"{{{W}}}t":
                parts.append(node.text or "")
            elif node.tag == f"{{{W}}}tab":
                parts.append("\t")
            elif node.tag in (f"{{{W}}}br", f"{{{W}}}cr"):
                parts.append("\n")
        paragraphs.append("".join(parts))
    return paragraphs


def _column(reference: str, fallback: int) -> int:
    if not reference:
        return fallback
    match = re.fullmatch(r"([A-Z]{1,3})[1-9][0-9]*", reference)
    if not match:
        raise ValueError("工作表单元格坐标无效")
    number = 0
    for letter in match[1]:
        number = number * 26 + ord(letter) - 64
    if number > 16384:
        raise ValueError("工作表列号超出范围")
    return number - 1


def _xlsx_sheets(archive: ZipFile) -> list[tuple[str, list[list[str]]]]:
    workbook = _xml(archive, "xl/workbook.xml")
    relationships = _xml(archive, "xl/_rels/workbook.xml.rels")
    targets = {relation.get("Id"): relation for relation in relationships}
    shared = []
    if "xl/sharedStrings.xml" in archive.namelist():
        shared = [
            "".join(part.text or "" for part in node.iter(f"{{{S}}}t"))
            for node in _xml(archive, "xl/sharedStrings.xml").findall(f"{{{S}}}si")
        ]
    result, text_length = [], 0
    for sheet in workbook.findall(f"{{{S}}}sheets/{{{S}}}sheet"):
        if sheet.get("state", "visible") != "visible":
            continue
        relation = targets.get(sheet.get(f"{{{R}}}id"))
        if relation is None or relation.get("TargetMode") == "External":
            raise ValueError("工作表关系缺失或指向外部文件")
        target = relation.get("Target", "")
        if ".." in PurePosixPath(target).parts or "\\" in target:
            raise ValueError("工作表关系含路径穿越")
        member = target.lstrip("/") if target.startswith("/") else "xl/" + target
        if not member.startswith("xl/"):
            raise ValueError("工作表关系超出文档范围")
        rows = []
        for row in _xml(archive, member).findall(f"{{{S}}}sheetData/{{{S}}}row"):
            cells, next_column = {}, 0
            for cell in row.findall(f"{{{S}}}c"):
                column = _column(cell.get("r", ""), next_column)
                if column in cells:
                    raise ValueError("工作表含重复单元格")
                kind = cell.get("t")
                value = cell.find(f"{{{S}}}v")
                if kind == "inlineStr":
                    value = "".join(node.text or "" for node in cell.iter(f"{{{S}}}t"))
                elif kind == "s":
                    try:
                        index = int(value.text)
                        if index < 0:
                            raise ValueError
                        value = shared[index]
                    except (IndexError, ValueError, AttributeError) as exc:
                        raise ValueError("共享字符串引用无效") from exc
                elif cell.find(f"{{{S}}}f") is not None and value is None:
                    raise ValueError("工作表公式没有缓存结果，请先用 Excel 计算并保存")
                else:
                    value = "" if value is None else value.text or ""
                cells[column] = value
                next_column = column + 1
            values = [
                cells.get(index, "") for index in range(max(cells, default=-1) + 1)
            ]
            text_length += sum(map(len, values)) + len(values)
            if text_length > MAX_EXPORT_CHARACTERS:
                raise ValueError("工作表正文超过字符上限")
            rows.append(values)
        result.append((sheet.get("name", "未命名工作表"), rows))
    return result


def _pdf_text(data: bytes) -> str:
    from hermes_platform.resolver import locate_command
    from hermes_platform.resolver.known_dirs import homebrew_dirs

    if not data.startswith(b"%PDF-"):
        raise ValueError("PDF 文件格式不正确")
    converter = locate_command("pdftotext", known_dirs=homebrew_dirs())
    if not converter.found:
        raise ValueError("当前创作服务未配置 PDF 文本解析，请提供 TXT、DOCX 或 XLSX 原稿")
    # 只把已验证资料的字节交给固定转换器；不接受命令、文件路径或 shell 片段。
    with TemporaryFile() as output:
        try:
            result = subprocess.run(
                [*converter.command, "-enc", "UTF-8", "-layout", "-", "-"], input=data,
                stdout=output, stderr=subprocess.DEVNULL, timeout=30, check=False,
                env={"LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
            )
        except (OSError, subprocess.TimeoutExpired):
            raise ValueError("PDF 解析未完成，请检查文件后重试") from None
        if result.returncode:
            raise ValueError("PDF 无法解析，可能已加密或损坏")
        output.seek(0)
        encoded = output.read(MAX_TEXT_CHARACTERS * 4 + 1)
        if len(encoded) > MAX_TEXT_CHARACTERS * 4:
            raise ValueError("PDF 提取内容超过 150 万字符预算，请按章节拆分原文件")
        text = encoded.decode("utf-8", errors="strict")
    if not text.strip():
        raise ValueError("PDF 没有可读取的文字，请提供文字版原稿")
    return text.replace("\f", "\n")


def read_material(path) -> dict:
    """读取用户明确提供的本机材料，记录文件和解析文本的独立摘要。"""
    source = _path(path, {".txt", ".md", ".docx", ".xlsx", ".csv", ".pdf"})
    data = read_document_bytes(source, MAX_FILE_BYTES)
    if not data or len(data) > MAX_FILE_BYTES:
        raise ValueError("材料不能为空且每个文件最多 20 MB")
    extension = source.suffix.lower()[1:]
    if extension in {"txt", "md", "csv"}:
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ValueError("文本材料须使用 UTF-8 编码") from exc
    elif extension == "pdf":
        text = _pdf_text(data)
    else:
        with _archive(data) as archive:
            if extension == "docx":
                text = "\n".join(_docx_paragraphs(archive))
            else:
                text = "\n\n".join(
                    "【" + name + "】\n" + "\n".join("\t".join(row) for row in rows)
                    for name, rows in _xlsx_sheets(archive)
                )
    text = _text(text, MAX_TEXT_CHARACTERS)
    return {
        "path": str(source),
        "name": source.name,
        "format": extension,
        "text": text,
        "sha256": _sha(data),
        "content_sha256": _sha(text.encode()),
        "characters": len(text),
        "size_bytes": len(data),
    }


def _element(parent, namespace, name, attributes=None, text=None):
    element = ET.SubElement(parent, f"{{{namespace}}}{name}", attributes or {})
    element.text = text
    return element


def _bytes(element: ET.Element) -> bytes:
    return ET.tostring(element, encoding="utf-8", xml_declaration=True)


def _content_types(overrides) -> bytes:
    # Office 包元数据使用默认命名空间，兼容 LibreOffice 的格式探测。
    root = ET.Element("Types", {"xmlns": CONTENT})
    for extension, mime in (
        ("rels", "application/vnd.openxmlformats-package.relationships+xml"),
        ("xml", "application/xml"),
    ):
        ET.SubElement(root, "Default", {"Extension": extension, "ContentType": mime})
    for name, kind in overrides.items():
        ET.SubElement(root, "Override", {"PartName": "/" + name, "ContentType": kind})
    return _bytes(root)


def _relationships(items) -> bytes:
    root = ET.Element("Relationships", {"xmlns": P})
    for index, (kind, target) in enumerate(items, 1):
        ET.SubElement(
            root,
            "Relationship",
            {"Id": f"rId{index}", "Type": R + "/" + kind, "Target": target},
        )
    return _bytes(root)


def _package(parts) -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, "w", compression=ZIP_DEFLATED) as archive:
        for name, data in parts.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def _publish(data, destination, extension, content, **details) -> dict:
    target = _path(destination, {"." + extension})
    # 独占创建保护历史稿件，调用方为新版本分配新的文件名。
    saved = write_document_bytes(target, data)
    if saved != data:
        raise ValueError("导出文件写入后的字节校验失败")
    receipt = {
        "path": str(target),
        "name": target.name,
        "format": extension,
        "sha256": _sha(saved),
        "content_sha256": _sha(content.encode()),
        "size_bytes": len(saved),
        "content_verified": True,
        "layout_verified": False,
        "verification": {
            "content_roundtrip": "passed",
            "layout": "not_checked",
            "wps": "not_checked",
            "business_acceptance": "not_assessed",
        },
        **details,
    }
    return {**receipt, **receipt_scopes(receipt)}


def _markdown_inline(value: str) -> str:
    """只解析文档模式下可明确识别的 Markdown 装饰。"""
    value = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"(```|`|\*\*|__)(.*?)\1", r"\2", value)
    value = value.replace("\\|", "|")
    return value.strip()


def _markdown_table_cells(line: str) -> list[str]:
    value = line.strip()
    if value.startswith("|"):
        value = value[1:]
    if value.endswith("|"):
        value = value[:-1]
    return [_markdown_inline(cell.strip()) for cell in re.split(r"(?<!\\)\|", value)]


def _markdown_rows(source: str) -> tuple[list[dict], str]:
    """将大纲、文档的标题、列表和表格变成对应 Word 结构。"""
    entries, plain_lines = [], []
    lines = source.split("\n")
    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            index += 1
            continue
        if (
            stripped.startswith("|")
            and index + 1 < len(lines)
            and re.fullmatch(r"\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*", lines[index + 1])
        ):
            rows = [_markdown_table_cells(line)]
            index += 2
            while index < len(lines) and lines[index].strip().startswith("|"):
                rows.append(_markdown_table_cells(lines[index]))
                index += 1
            width = max(map(len, rows))
            rows = [row + [""] * (width - len(row)) for row in rows]
            entries.append({"kind": "table", "rows": rows})
            plain_lines.extend(value for row in rows for value in row)
            continue
        heading = re.match(r"^\s*(#{1,6})\s+(.+?)\s*#*\s*$", line)
        if heading:
            value = _markdown_inline(heading.group(2))
            entries.append({"kind": "paragraph", "text": value, "level": len(heading.group(1))})
            plain_lines.append(value)
            index += 1
            continue
        bullet = re.match(r"^\s*(?:(?P<unordered>[-*+])\s+|(?P<ordered>\d+[.)])\s+)(.+)$", line)
        if bullet:
            value = _markdown_inline(bullet.group(3))
            entries.append({
                "kind": "paragraph", "text": value,
                "list": "ordered" if bullet.group("ordered") else "unordered",
            })
            plain_lines.append(value)
            index += 1
            continue
        value = _markdown_inline(line.strip())
        entries.append({"kind": "paragraph", "text": value})
        plain_lines.append(value)
        index += 1
    return entries, "\n".join(plain_lines)


def _word_paragraph(
    body,
    text: str,
    *,
    title: bool = False,
    heading: bool = False,
    list_item: str | bool = False,
    gap: bool = False,
):
    paragraph = _element(body, W, "p")
    props = _element(paragraph, W, "pPr")
    _element(
        props,
        W,
        "spacing",
        {
            f"{{{W}}}before": "0",
            f"{{{W}}}after": "0",
            f"{{{W}}}line": "240" if gap else "300",
            f"{{{W}}}lineRule": "auto",
        },
    )
    if heading or title:
        _element(props, W, "keepNext")
    if gap:
        return paragraph
    if title:
        _element(props, W, "jc", {f"{{{W}}}val": "center"})
    _element(props, W, "widowControl")
    if list_item:
        num_props = _element(props, W, "numPr")
        _element(num_props, W, "ilvl", {f"{{{W}}}val": "0"})
        _element(num_props, W, "numId", {f"{{{W}}}val": "2" if list_item == "ordered" else "1"})
    run = _element(paragraph, W, "r")
    run_props = _element(run, W, "rPr")
    _element(
        run_props,
        W,
        "rFonts",
        {
            f"{{{W}}}ascii": "SimSun",
            f"{{{W}}}hAnsi": "SimSun",
            f"{{{W}}}eastAsia": "宋体",
            f"{{{W}}}cs": "SimSun",
        },
    )
    _element(run_props, W, "sz", {f"{{{W}}}val": "28" if title else "24"})
    _element(run_props, W, "szCs", {f"{{{W}}}val": "28" if title else "24"})
    if heading or title:
        _element(run_props, W, "b")
    for part_index, part in enumerate(text.split("\t")):
        if part_index:
            _element(run, W, "tab")
        _element(run, W, "t", {XML_SPACE: "preserve"}, part)
    return paragraph


def _word_table(body, rows: list[list[str]]):
    table = _element(body, W, "tbl")
    props = _element(table, W, "tblPr")
    _element(props, W, "tblW", {f"{{{W}}}w": "0", f"{{{W}}}type": "auto"})
    borders = _element(props, W, "tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        _element(borders, W, edge, {
            f"{{{W}}}val": "single", f"{{{W}}}sz": "4", f"{{{W}}}space": "0",
            f"{{{W}}}color": "BFBFBF",
        })
    grid = _element(table, W, "tblGrid")
    width = max(1, 9000 // max(map(len, rows)))
    for _ in range(max(map(len, rows))):
        _element(grid, W, "gridCol", {f"{{{W}}}w": str(width)})
    for values in rows:
        row = _element(table, W, "tr")
        for value in values:
            cell = _element(row, W, "tc")
            cell_props = _element(cell, W, "tcPr")
            _element(cell_props, W, "tcW", {f"{{{W}}}w": str(width), f"{{{W}}}type": "dxa"})
            _word_paragraph(cell, value, heading=values is rows[0])
    return table


def _word_footer() -> bytes:
    footer = ET.Element(f"{{{W}}}ftr")
    paragraph = _element(footer, W, "p")
    props = _element(paragraph, W, "pPr")
    _element(props, W, "jc", {f"{{{W}}}val": "center"})
    run = _element(paragraph, W, "r")
    _element(_element(run, W, "rPr"), W, "rFonts", {f"{{{W}}}eastAsia": "宋体"})
    _element(run, W, "fldChar", {f"{{{W}}}fldCharType": "begin"})
    _element(run, W, "instrText", {XML_SPACE: "preserve"}, " PAGE ")
    _element(run, W, "fldChar", {f"{{{W}}}fldCharType": "separate"})
    _element(run, W, "t", {XML_SPACE: "preserve"}, "1")
    _element(run, W, "fldChar", {f"{{{W}}}fldCharType": "end"})
    return _bytes(footer)


def _word_numbering() -> bytes:
    numbering = ET.Element(f"{{{W}}}numbering")
    abstract = _element(numbering, W, "abstractNum", {f"{{{W}}}abstractNumId": "0"})
    _element(abstract, W, "multiLevelType", {f"{{{W}}}val": "singleLevel"})
    level = _element(abstract, W, "lvl", {f"{{{W}}}ilvl": "0"})
    _element(level, W, "start", {f"{{{W}}}val": "1"})
    _element(level, W, "numFmt", {f"{{{W}}}val": "bullet"})
    _element(level, W, "lvlText", {f"{{{W}}}val": "•"})
    _element(level, W, "lvlJc", {f"{{{W}}}val": "left"})
    ordered_abstract = _element(numbering, W, "abstractNum", {f"{{{W}}}abstractNumId": "1"})
    _element(ordered_abstract, W, "multiLevelType", {f"{{{W}}}val": "singleLevel"})
    ordered_level = _element(ordered_abstract, W, "lvl", {f"{{{W}}}ilvl": "0"})
    _element(ordered_level, W, "start", {f"{{{W}}}val": "1"})
    _element(ordered_level, W, "numFmt", {f"{{{W}}}val": "decimal"})
    _element(ordered_level, W, "lvlText", {f"{{{W}}}val": "%1."})
    _element(ordered_level, W, "lvlJc", {f"{{{W}}}val": "left"})
    num = _element(numbering, W, "num", {f"{{{W}}}numId": "1"})
    _element(num, W, "abstractNumId", {f"{{{W}}}val": "0"})
    ordered_num = _element(numbering, W, "num", {f"{{{W}}}numId": "2"})
    _element(ordered_num, W, "abstractNumId", {f"{{{W}}}val": "1"})
    return _bytes(numbering)


def export_document(text, destination, *, document_kind="script") -> dict:
    """生成可编辑 Word；正文和 Markdown 文档都保留可回读的实际段落。"""
    source = _text(text)
    if document_kind not in {"script", "outline", "document"}:
        raise ValueError("document_kind 必须是 script、outline 或 document")
    entries = []
    plain_content = source
    if document_kind == "script":
        lines = [line for line in source.split("\n") if line.strip()]
        entries = [{"kind": "paragraph", "text": line} for line in lines]
        plain_content = "\n".join(lines)
    else:
        entries, plain_content = _markdown_rows(source)
    document = ET.Element(f"{{{W}}}document")
    body = _element(document, W, "body")
    visible_index = 0
    previous_heading = False
    for entry in entries:
        if entry["kind"] == "table":
            _word_table(body, entry["rows"])
            continue
        if document_kind == "script" and visible_index:
            _word_paragraph(body, "", gap=True, heading=previous_heading)
        value = entry["text"]
        title = bool(re.fullmatch(r"第.+集", value)) or entry.get("level") == 1
        scene = bool(re.match(r"^\d+[-—]\d+场?\s", value))
        person = bool(re.match(r"^(?:出场)?人物[:：]", value))
        _word_paragraph(
            body,
            value,
            title=title,
            heading=scene or person or entry.get("level", 0) > 1,
            list_item=entry.get("list", False),
        )
        previous_heading = title or scene or person
        visible_index += 1
    section = _element(body, W, "sectPr")
    _element(section, W, "footerReference", {f"{{{R}}}id": "rId1", f"{{{W}}}type": "default"})
    _element(section, W, "pgSz", {f"{{{W}}}w": "11906", f"{{{W}}}h": "16838"})
    _element(
        section,
        W,
        "pgMar",
        {
            f"{{{W}}}top": "1080",
            f"{{{W}}}bottom": "1080",
            f"{{{W}}}left": "1080",
            f"{{{W}}}right": "1080",
            f"{{{W}}}footer": "720",
        },
    )
    parts = {
        "word/document.xml": _bytes(document),
        "word/footer1.xml": _word_footer(),
        "word/numbering.xml": _word_numbering(),
        "_rels/.rels": _relationships([("officeDocument", "word/document.xml")]),
        "word/_rels/document.xml.rels": _relationships([
            ("footer", "footer1.xml"), ("numbering", "numbering.xml")
        ]),
        "[Content_Types].xml": _content_types({
            "word/document.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
            "word/footer1.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml",
            "word/numbering.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
        }),
    }
    data = _package(parts)
    with _archive(data) as archive:
        actual = _docx_paragraphs(archive)
        if document_kind == "script":
            if actual[::2] != lines or any(actual[1::2]):
                raise ValueError("Word 正文回读与指定源稿不一致")
        elif "\n".join(actual) != plain_content:
            raise ValueError("Word 文档回读与指定源稿不一致")
    return _publish(
        data,
        destination,
        "docx",
        plain_content,
        paragraphs=visible_index,
        source_sha256=_sha(source.encode()),
        document_kind=document_kind,
        text_statistics=text_statistics(source),
    )


def export_script(text, destination, *, document_kind="script") -> dict:
    """兼容旧接口并支持 script、outline、document 三类 Word 导出。"""
    return export_document(text, destination, document_kind=document_kind)


def _chunks(text, size=480):
    chunks = []
    while text:
        stop = min(size, len(text))
        newlines = list(re.finditer("\n", text[:stop]))
        if len(newlines) > 18:
            stop = newlines[17].end()
        elif stop < len(text) and newlines:
            stop = newlines[-1].end()
        chunks.append(text[:stop])
        text = text[stop:]
    return chunks or [""]


def _sheet(rows, widths) -> bytes:
    root = ET.Element(f"{{{S}}}worksheet")
    properties = _element(root, S, "sheetPr")
    _element(properties, S, "pageSetUpPr", {"fitToPage": "1"})
    views = _element(root, S, "sheetViews")
    view = _element(views, S, "sheetView", {"workbookViewId": "0"})
    _element(
        view,
        S,
        "pane",
        {
            "ySplit": "1",
            "topLeftCell": "A2",
            "activePane": "bottomLeft",
            "state": "frozen",
        },
    )
    columns = _element(root, S, "cols")
    for index, width in enumerate(widths, 1):
        _element(
            columns,
            S,
            "col",
            {
                "min": str(index),
                "max": str(index),
                "width": str(width),
                "customWidth": "1",
            },
        )
    sheet_data = _element(root, S, "sheetData")
    for number, values in enumerate(rows, 1):
        lines = max(
            sum(max(1, math.ceil(len(line) * 2 / width)) for line in value.split("\n"))
            for value, width in zip(values, widths)
        )
        row = _element(
            sheet_data,
            S,
            "row",
            {
                "r": str(number),
                "ht": str(min(400, max(24, lines * 16 + 8))),
                "customHeight": "1",
            },
        )
        for column, value in enumerate(values):
            cell = _element(
                row,
                S,
                "c",
                {
                    "r": f"{chr(65 + column)}{number}",
                    "t": "inlineStr",
                    "s": "1" if number == 1 else "0",
                },
            )
            inline = _element(cell, S, "is")
            _element(inline, S, "t", {XML_SPACE: "preserve"}, value)
    _element(root, S, "pageMargins", {
        "left": "0.25", "right": "0.25", "top": "0.35", "bottom": "0.35",
        "header": "0.15", "footer": "0.15",
    })
    # 宽表用 A3 横向保留字号；只限制页宽，长稿仍可纵向分页。
    _element(root, S, "pageSetup", {
        "paperSize": "8" if len(widths) > 2 else "9", "orientation": "landscape",
        "fitToWidth": "1", "fitToHeight": "0",
    })
    return _bytes(root)


def export_outline(character_rows, episode_rows, destination) -> dict:
    """导出原新人物及集数对照；长文本以续行保存，公式形文本仍按文字保存。"""
    if (
        not isinstance(character_rows, list)
        or not character_rows
        or not isinstance(episode_rows, list)
        or not episode_rows
    ):
        raise ValueError("导出对照表需要完整人物和集数记录")
    people = [["原人物", "新人物"]]
    episodes = [["原集数", "原大纲", "新集数", "新大纲"]]
    total = 0
    for record in character_rows:
        columns = [_text(record.get(key)) for key in ("original", "new")]
        total += sum(map(len, columns))
        chunks = [_chunks(value) for value in columns]
        for index in range(max(map(len, chunks))):
            people.append([
                parts[index] if index < len(parts) else "" for parts in chunks
            ])
    for record in episode_rows:
        original, old_text, new, new_text = [
            _text(record.get(key))
            for key in (
                "original_episodes",
                "original_outline",
                "new_episodes",
                "new_outline",
            )
        ]
        if len(original) > 200 or len(new) > 200:
            raise ValueError("集数标签过长，请使用可读的集数范围")
        total += len(original) + len(old_text) + len(new) + len(new_text)
        old_chunks, new_chunks = _chunks(old_text), _chunks(new_text)
        for index in range(max(len(old_chunks), len(new_chunks))):
            suffix = "（续）" if index else ""
            episodes.append([
                original + suffix,
                old_chunks[index] if index < len(old_chunks) else "",
                new + suffix,
                new_chunks[index] if index < len(new_chunks) else "",
            ])
    if total > MAX_EXPORT_CHARACTERS:
        raise ValueError("对照表超过允许的字符上限")
    workbook = ET.Element(f"{{{S}}}workbook")
    sheets = _element(workbook, S, "sheets")
    for index, name in enumerate(("人物对照", "集数对照"), 1):
        _element(
            sheets,
            S,
            "sheet",
            {"name": name, "sheetId": str(index), f"{{{R}}}id": f"rId{index}"},
        )
    defined_names = _element(workbook, S, "definedNames")
    for index, name in enumerate(("人物对照", "集数对照")):
        _element(defined_names, S, "definedName", {
            "name": "_xlnm.Print_Titles", "localSheetId": str(index),
        }, f"'{name}'!$1:$1")
    styles = f'''<?xml version="1.0" encoding="UTF-8"?>
      <styleSheet xmlns="{S}"><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font>
      <font><b/><sz val="11"/><name val="Microsoft YaHei"/></font></fonts>
      <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
      <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
      <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
      <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
      <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf></cellXfs>
      <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'''
    overrides = {
        "xl/workbook.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "xl/styles.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
    }
    for index in (1, 2):
        overrides[f"xl/worksheets/sheet{index}.xml"] = (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
        )
    parts = {
        "xl/workbook.xml": _bytes(workbook),
        "xl/styles.xml": styles,
        "xl/worksheets/sheet1.xml": _sheet(people, [48, 48]),
        "xl/worksheets/sheet2.xml": _sheet(episodes, [18, 64, 18, 64]),
        "_rels/.rels": _relationships([("officeDocument", "xl/workbook.xml")]),
        "xl/_rels/workbook.xml.rels": _relationships([
            ("worksheet", "worksheets/sheet1.xml"),
            ("worksheet", "worksheets/sheet2.xml"),
            ("styles", "styles.xml"),
        ]),
        "[Content_Types].xml": _content_types(overrides),
    }
    data = _package(parts)
    with _archive(data) as archive:
        if _xlsx_sheets(archive) != [("人物对照", people), ("集数对照", episodes)]:
            raise ValueError("Excel 回读的表名、字段或完整内容不一致")
    content = json.dumps(
        [character_rows, episode_rows], ensure_ascii=False, sort_keys=True
    )
    return _publish(
        data,
        destination,
        "xlsx",
        content,
        sheet_rows={"人物对照": len(people) - 1, "集数对照": len(episodes) - 1},
        character_records=len(character_rows),
        episode_records=len(episode_rows),
    )

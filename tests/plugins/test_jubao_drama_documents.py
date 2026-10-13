"""验证剧本材料解析与真实 Office 文件的内容保真和输入边界。"""

import hashlib
import importlib.util
from pathlib import Path
import sys
import subprocess
import xml.etree.ElementTree as ET
from zipfile import ZipFile

import pytest


W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
MODULE = Path(__file__).resolve().parents[2] / "extensions/jubao-drama/documents.py"


def load_documents():
    assert MODULE.is_file(), "剧本材料读取与导出功能尚未实现"
    from plugins.plugin_loader import register_synthetic_package
    package = "jubao_drama_documents_test_source"
    register_synthetic_package(package, [str(MODULE.parent)])
    spec = importlib.util.spec_from_file_location(package + ".documents", MODULE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def write_zip(path, parts):
    with ZipFile(path, "w") as archive:
        for name, text in parts.items():
            archive.writestr(name, text)


def xlsx_rows(archive, name):
    sheet = ET.fromstring(archive.read(name))
    return [
        ["".join(cell.itertext()) for cell in row.findall(f"{{{S}}}c")]
        for row in sheet.findall(f"{{{S}}}sheetData/{{{S}}}row")
    ]


def test_import_reads_visible_material_without_executing_or_escaping(tmp_path):
    documents = load_documents()
    raw = "\ufeff第1集\r\n△她打开信。\r\n林青：别走。（Stay.）".encode()
    for suffix in ("txt", "md"):
        source = tmp_path / f"原稿.{suffix}"
        source.write_bytes(raw)
        material = documents.read_material(source)
        assert material["text"] == "第1集\n△她打开信。\n林青：别走。（Stay.）"
        assert material["sha256"] == hashlib.sha256(raw).hexdigest()
        assert (
            material["content_sha256"]
            == hashlib.sha256(material["text"].encode()).hexdigest()
        )
        assert material["characters"] == len(material["text"])

    source = tmp_path / "原稿.docx"
    write_zip(
        source,
        {
            "word/document.xml": f'''<w:document xmlns:w="{W}"><w:body>
      <w:p><w:r><w:t>第1集</w:t></w:r></w:p>
      <w:p><w:r><w:t>△她</w:t><w:tab/><w:t>打开信。</w:t><w:br/><w:t>信上写着 &lt;回家&gt;</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>林青：别走。</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>'''
        },
    )
    assert (
        documents.read_material(source)["text"]
        == "第1集\n△她\t打开信。\n信上写着 <回家>\n林青：别走。"
    )

    workbook = f'''<workbook xmlns="{S}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>
      <sheet name="原稿" sheetId="1" r:id="rId1"/>
      <sheet name="内部" sheetId="2" state="hidden" r:id="rId2"/>
    </sheets></workbook>'''
    relations = """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>
      <Relationship Id="rId2" Target="worksheets/sheet2.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>
    </Relationships>"""
    parts = {
        "xl/workbook.xml": workbook,
        "xl/_rels/workbook.xml.rels": relations,
        "xl/sharedStrings.xml": f'<sst xmlns="{S}"><si><r><t>第1</t></r><r><t>集</t></r></si></sst>',
        "xl/worksheets/sheet1.xml": f'''<worksheet xmlns="{S}"><sheetData><row r="1">
          <c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>△她打开信。</t></is></c>
          <c r="D1"><f>1+1</f><v>2</v></c>
        </row></sheetData></worksheet>''',
        "xl/worksheets/sheet2.xml": f'<worksheet xmlns="{S}"><sheetData><row><c t="inlineStr"><is><t>内部内容</t></is></c></row></sheetData></worksheet>',
    }
    source = tmp_path / "原稿.xlsx"
    write_zip(source, parts)
    assert (
        documents.read_material(source)["text"] == "【原稿】\n第1集\t\t△她打开信。\t2"
    )

    unsafe = tmp_path / "不安全.docx"
    for extra in ({"../outside.txt": "内容"}, {"/outside.txt": "内容"}):
        write_zip(unsafe, {"word/document.xml": "<root/>", **extra})
        with pytest.raises(ValueError):
            documents.read_material(unsafe)
    write_zip(
        unsafe, {"word/document.xml": '<!DOCTYPE x [<!ENTITY a "替换内容">]><x>&a;</x>'}
    )
    with pytest.raises(ValueError):
        documents.read_material(unsafe)
    write_zip(unsafe, {"word/document.xml": "<root/>"})
    with pytest.raises(ValueError):
        documents.read_material(unsafe)
    too_long = tmp_path / "过长.txt"
    too_long.write_text("字" * (documents.MAX_TEXT_CHARACTERS + 1), encoding="utf-8")
    with pytest.raises(ValueError):
        documents.read_material(too_long)
    for invalid in (
        tmp_path,
        tmp_path / ".." / tmp_path.name / "原稿.docx",
        tmp_path / "代码.py",
    ):
        with pytest.raises(ValueError):
            documents.read_material(invalid)


def test_exports_preserve_all_text_and_exact_sheets_without_claiming_layout(tmp_path):
    documents = load_documents()
    text = (
        "第1集\n\n1-1 家中 日 内\n出场人物：林青\n\n△她拿起写有 <约定> 的信。\n林青：我会回来。（I'll be back.）\n"
        + "△"
        + "她向前走。" * 7000
    )
    target = tmp_path / "正文.docx"
    receipt = documents.export_script(text, target)
    expected = [line for line in text.splitlines() if line.strip()]
    with ZipFile(target) as archive:
        body = ET.fromstring(archive.read("word/document.xml")).find(f"{{{W}}}body")
        paragraphs = ["".join(p.itertext()) for p in body.findall(f"{{{W}}}p")]
        assert paragraphs[::2] == expected
        assert all(not p for p in paragraphs[1::2])
        assert not body.findall(f"{{{W}}}tbl")
    assert [
        line
        for line in documents.read_material(target)["text"].splitlines()
        if line.strip()
    ] == expected
    assert receipt["sha256"] == hashlib.sha256(target.read_bytes()).hexdigest()
    assert receipt["content_verified"] is True and receipt["layout_verified"] is False
    before = target.read_bytes()
    with pytest.raises(FileExistsError):
        documents.export_script("不能覆盖原稿", target)
    assert target.read_bytes() == before

    original = "原剧情：\n" + "她被迫作出选择。\n" * 3600
    replacement = "=SUM(A1:A2)\n" + "她取出证据，换回自由。\n" * 3100
    characters = [{"original": "林青（原主角）", "new": "莉娅（继承人）"}]
    episodes = [
        {
            "original_episodes": "第1—2集",
            "original_outline": original,
            "new_episodes": "第1集",
            "new_outline": replacement,
        }
    ]
    target = tmp_path / "原新人物与大纲对照.xlsx"
    receipt = documents.export_outline(characters, episodes, target)
    with ZipFile(target) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheets = workbook.findall(f"{{{S}}}sheets/{{{S}}}sheet")
        assert [s.attrib["name"] for s in sheets] == ["人物对照", "集数对照"]
        assert all(s.attrib.get("state", "visible") == "visible" for s in sheets)
        people = xlsx_rows(archive, "xl/worksheets/sheet1.xml")
        assert people == [["原人物", "新人物"], ["林青（原主角）", "莉娅（继承人）"]]
        rows = xlsx_rows(archive, "xl/worksheets/sheet2.xml")
        assert rows[0] == ["原集数", "原大纲", "新集数", "新大纲"]
        assert all(len(row) == 4 for row in rows)
        assert "".join(row[1] for row in rows[1:]) == original
        assert "".join(row[3] for row in rows[1:]) == replacement
        assert rows[1][0] == "第1—2集" and rows[1][2] == "第1集"
        assert all("续" in row[0] and "续" in row[2] for row in rows[2:])
        assert all(
            not ET.fromstring(archive.read(name)).findall(f".//{{{S}}}f")
            for name in ("xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml")
        )
    assert receipt["sha256"] == hashlib.sha256(target.read_bytes()).hexdigest()
    assert receipt["content_verified"] is True and receipt["layout_verified"] is False
    assert receipt["sheet_rows"]["集数对照"] == len(rows) - 1
    with pytest.raises(ValueError):
        documents.export_outline(
            characters, [{**episodes[0], "new_outline": ""}], tmp_path / "空.xlsx"
        )
    with pytest.raises(ValueError):
        documents.export_script("不能删除\x00字符", tmp_path / "非法.docx")


def test_script_export_uses_common_chinese_screenplay_layout_and_page_number(tmp_path):
    documents = load_documents()
    target = tmp_path / "第01批正文.docx"
    source = "第1集\n3-1场 接待室 日 内\n出场人物：林青、周野\n△林青推门而入。\n林青：你终于来了。\n△屏幕显示 **文字** 和 `#tag`。"

    receipt = documents.export_script(source, target, document_kind="script")

    assert receipt["content_verified"] is True
    assert receipt["layout_verified"] is False
    with ZipFile(target) as archive:
        document = ET.fromstring(archive.read("word/document.xml"))
        body = document.find(f"{{{W}}}body")
        paragraphs = body.findall(f"{{{W}}}p")
        visible = ["".join(p.itertext()) for p in paragraphs]
        assert visible[::2] == source.splitlines()
        assert all(not value for value in visible[1::2])

        title = paragraphs[0]
        title_props = title.find(f"{{{W}}}pPr")
        assert title_props.find(f"{{{W}}}jc").attrib[f"{{{W}}}val"] == "center"
        title_run_props = title.find(f"{{{W}}}r/{{{W}}}rPr")
        assert title_run_props.find(f"{{{W}}}b") is not None
        assert title_run_props.find(f"{{{W}}}sz").attrib[f"{{{W}}}val"] == "28"

        scene_props = paragraphs[2].find(f"{{{W}}}pPr")
        assert scene_props.find(f"{{{W}}}keepNext") is not None
        assert paragraphs[3].find(f"{{{W}}}pPr/{{{W}}}keepNext") is not None, "标题后的空行也必须随正文分页"
        person_run_props = paragraphs[4].find(f"{{{W}}}r/{{{W}}}rPr")
        assert person_run_props.find(f"{{{W}}}b") is not None
        assert paragraphs[8].find(f"{{{W}}}r/{{{W}}}rPr/{{{W}}}b") is None, "对白正文不能整段加粗"
        assert paragraphs[8].find(f"{{{W}}}pPr/{{{W}}}keepNext") is None, "对白之间应允许自然分页"

        section = body.find(f"{{{W}}}sectPr")
        page_size = section.find(f"{{{W}}}pgSz")
        assert page_size.attrib[f"{{{W}}}w"] == "11906"
        assert page_size.attrib[f"{{{W}}}h"] == "16838"
        margins = section.find(f"{{{W}}}pgMar")
        assert margins.attrib[f"{{{W}}}left"] == "1080"
        section_tags = [child.tag for child in section]
        assert section_tags.index(f"{{{W}}}footerReference") < section_tags.index(f"{{{W}}}pgSz"), "节属性须符合 Word 元素顺序"
        footer = archive.read("word/footer1.xml").decode()
        assert "PAGE" in footer
        assert "w:fldChar" in footer


def test_outline_export_keeps_markdown_semantics_without_markdown_tokens(tmp_path):
    documents = load_documents()
    target = tmp_path / "叙事大纲.docx"
    source = (
        "# 叙事大纲\n\n"
        "## 第一集\n\n"
        "- 林青发现证据\n"
        "- 周野试图阻止她\n\n"
        "1. 进入书房\n2. 带走证据\n\n"
        "| 场次 | 内容 |\n| --- | --- |\n| 1-1 | 林青打开信件 |"
    )

    receipt = documents.export_script(source, target, document_kind="outline")

    expected = "叙事大纲\n第一集\n林青发现证据\n周野试图阻止她\n进入书房\n带走证据\n场次\n内容\n1-1\n林青打开信件"
    assert documents.read_material(target)["text"] == expected
    assert receipt["content_sha256"] == hashlib.sha256(expected.encode()).hexdigest()

    with ZipFile(target) as archive:
        document = ET.fromstring(archive.read("word/document.xml"))
        body = document.find(f"{{{W}}}body")
        text = "".join(body.itertext())
        assert "#" not in text and "|" not in text and "---" not in text
        assert "叙事大纲" in text and "林青发现证据" in text
        assert body.findall(f"{{{W}}}tbl"), "Markdown 表格应保留为 Word 表格语义"
        list_paragraphs = [
            p for p in body.findall(f"{{{W}}}p")
            if "林青发现证据" in "".join(p.itertext())
        ]
        assert list_paragraphs
        num_props = list_paragraphs[0].find(f"{{{W}}}pPr/{{{W}}}numPr")
        assert num_props is not None
        ordered = next(p for p in body.findall(f"{{{W}}}p") if "进入书房" in "".join(p.itertext()))
        ordered_number = ordered.find(f"{{{W}}}pPr/{{{W}}}numPr/{{{W}}}numId")
        assert ordered_number.attrib != num_props.find(f"{{{W}}}numId").attrib, "有序步骤不能变成普通项目符号"
        numbering = ET.fromstring(archive.read("word/numbering.xml"))
        numbering_tags = [child.tag for child in numbering]
        last_definition = max(index for index, tag in enumerate(numbering_tags) if tag == f"{{{W}}}abstractNum")
        first_instance = min(index for index, tag in enumerate(numbering_tags) if tag == f"{{{W}}}num")
        assert last_definition < first_instance, "编号定义必须先于编号实例，避免 Word 修复文件"


@pytest.mark.parametrize("extension", ["docx", "xlsx"])
def test_exported_office_package_opens_in_real_libreoffice(tmp_path, extension):
    from hermes_platform.resolver import locate_command

    converter = locate_command("soffice")
    if not converter.found:
        pytest.skip("当前测试环境未配置 LibreOffice")
    extractor = locate_command("pdftotext")
    if extension == "xlsx" and not extractor.found:
        pytest.skip("当前测试环境未配置 PDF 文本读取工具")
    documents = load_documents()
    target = tmp_path / f"export.{extension}"
    if extension == "docx":
        documents.export_script("第1集\n林岚：请保留原始证据。", target)
    else:
        documents.export_outline(
            [{"original": "OriginalPerson", "new": "NewPerson"}],
            [{"original_episodes": str(index + 1), "original_outline": f"OriginalOutline{index:03}",
              "new_episodes": str(index + 1), "new_outline": f"NewOutline{index:03}"} for index in range(45)],
            target,
        )
    output = tmp_path / "rendered"
    output.mkdir()
    result = subprocess.run(
        [*converter.command, "-env:UserInstallation=" + (tmp_path / "profile").as_uri(),
         "--headless", "--convert-to", "pdf", "--outdir", str(output), str(target)],
        capture_output=True, text=True, timeout=30, check=False,
    )
    rendered = output / "export.pdf"
    assert rendered.is_file(), result.stdout + result.stderr
    assert rendered.read_bytes().startswith(b"%PDF-")
    if extension == "xlsx":
        text = subprocess.run([*extractor.command, "-layout", str(rendered), "-"],
                              capture_output=True, text=True, timeout=10, check=True).stdout
        pages = [page for page in text.split("\f") if page.strip()]
        assert any("OriginalPerson" in page and "NewPerson" in page for page in pages)
        outline_pages = [page for page in pages if "OriginalOutline" in page]
        assert len(outline_pages) > 1, "长表应纵向分页，不能缩成一页"
        for index in range(45):
            assert any(f"OriginalOutline{index:03}" in page and f"NewOutline{index:03}" in page
                       for page in outline_pages), "原新对照列不能被拆到不同页面"

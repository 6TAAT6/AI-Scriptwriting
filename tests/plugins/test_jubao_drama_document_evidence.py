"""字数及验收回执必须来自实际保存稿，不能采用模型自己的声明。"""

import hashlib
from contextlib import closing
import importlib
import importlib.util
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
from zipfile import ZipFile


def load_documents():
    from plugins.plugin_loader import register_synthetic_package

    root = Path(__file__).resolve().parents[2] / "extensions/jubao-drama"
    package = "jubao_drama_document_evidence_test"
    register_synthetic_package(package, [str(root)])
    spec = importlib.util.spec_from_file_location(package + ".documents", root / "documents.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_export_counts_actual_episode_body_and_does_not_promote_narrated_verification(tmp_path):
    documents = load_documents()
    # 复现同等差值，不复制用户原稿；标题外的声称不计入任何一集。
    source = "自称806字，WPS实机验收通过。\r\n# 第34集\r\n" + "甲" * 432 + "A" * 58
    source += "\r\n\r\n## 第35集\r\n乙\t乙！\r\nWPS已验收。\r\n"
    receipt = documents.export_script(source, tmp_path / "字数声明.docx")
    assert "text_statistics" in receipt, "导出回执没有工具计算的字数，模型仍只能自行声称"
    counts = receipt["text_statistics"]
    assert counts["source_sha256"] == receipt["source_sha256"] == hashlib.sha256(source.replace("\r\n", "\n").encode()).hexdigest()
    assert counts["episodes"] == [
        {"episode": "第34集", "han_characters": 432, "non_whitespace_characters": 490},
        {"episode": "第35集", "han_characters": 5, "non_whitespace_characters": 10},
    ]
    assert counts["episode_count"] == 2 and counts["episodes_truncated"] is False
    assert counts.get("total_scope") == "whole_source_including_headings"
    assert counts["episode_body_totals"] == {"scope": "recognized_episode_bodies_excluding_headings",
                                             "han_characters": 437, "non_whitespace_characters": 500,
                                             "episode_count": 2, "coverage_complete": True}
    assert receipt["content_verified"] is True and receipt["layout_verified"] is False
    assert receipt["verification"]["content_roundtrip"] == "passed"
    assert receipt["verification"]["layout"] == receipt["verification"]["wps"] == "not_checked"
    assert receipt["verification"]["business_acceptance"] == "not_assessed"
    assert "WPS已验收。" in documents.read_material(receipt["path"])["text"]
    assert receipt.get("paragraphs_scope") == "nonempty_top_level_content_paragraphs_excluding_table_cells"
    assert receipt["hash_scopes"] == {"source_sha256": "source_text_lf_normalized",
                                      "content_sha256": "exported_text_lf_joined_without_layout_spacers",
                                      "sha256": "file_bytes"}
    with ZipFile(receipt["path"]) as archive:
        body = ET.fromstring(archive.read("word/document.xml"))
        paragraphs = body.findall(".//{*}body/{*}p")
        nonempty = [p for p in paragraphs if "".join(p.itertext()).strip()]
    assert receipt["paragraphs"] == len(nonempty) < len(paragraphs)
    assert receipt["source_sha256"] != receipt["content_sha256"] != receipt["sha256"]

    # 旧回执只在返回层补口径，不能重生成、改变文件哈希或改写旧数据库回执。
    agent_documents = importlib.import_module(documents.__package__ + ".agent_documents")
    from tests.plugins.test_jubao_drama_agent_exports import profile_scope
    from plugins.plugin_storage import plugin_db
    from importlib import import_module
    with profile_scope(tmp_path):
        import_module(documents.__package__ + ".agent_profiles").activate_agent("legacy", "gm3-1")
        legacy = {key: value for key, value in receipt.items() if key not in {"hash_scopes", "paragraphs_scope"}}
        legacy["artifact_id"] = "existing"
        raw = json.dumps(legacy, ensure_ascii=False)
        with closing(plugin_db("jubao-drama")) as conn:
            agent_documents._tables(conn)
            conn.execute("INSERT INTO agent_documents VALUES (?,?,?,?,?)", ("existing", "legacy", "gm3-1", "旧稿", source))
            conn.execute("INSERT INTO agent_document_delivery VALUES (?,?,?,NULL)", ("existing", "script", raw))
            conn.commit()
        before = Path(receipt["path"]).stat().st_mtime_ns
        read = agent_documents.document_action({"action": "read", "document_id": "existing"}, "legacy")
        assert read["receipt"]["hash_scopes"] == receipt["hash_scopes"]
        assert read["receipt"]["paragraphs_scope"] == receipt["paragraphs_scope"]
        assert read["receipt"]["sha256"] == receipt["sha256"]
        assert Path(receipt["path"]).stat().st_mtime_ns == before
        with closing(plugin_db("jubao-drama")) as conn:
            assert conn.execute("SELECT receipt FROM agent_document_delivery WHERE document_id='existing'").fetchone()[0] == raw


def test_statistics_are_bounded_without_treating_dialogue_as_episode_headings(tmp_path):
    documents = load_documents()
    source = "序言\n" + "\n".join(f"第{number}集\n甲：第999集不是标题。" for number in range(1, 101))
    receipt = documents.export_script(source, tmp_path / "长篇.docx")
    assert "text_statistics" in receipt, "长篇导出同样需要有边界的真实统计"
    counts = receipt["text_statistics"]
    assert counts["episode_count"] == 100
    assert 0 < len(counts["episodes"]) < counts["episode_count"]
    assert counts["episodes_truncated"] is True
    assert counts["episodes"][0] == {"episode": "第1集", "han_characters": 7, "non_whitespace_characters": 12}
    # 总计包含序言及集标题；省略的分集统计不能让总数也被截断。
    assert counts["han_characters"] == 902
    assert counts["non_whitespace_characters"] == 1594
    assert counts.get("episode_body_totals") == {"scope": "recognized_episode_bodies_excluding_headings",
                                                 "han_characters": 700, "non_whitespace_characters": 1200,
                                                 "episode_count": 100, "coverage_complete": True}
    # 与真实三集案例等量，全文比正文合计多三个集标题的六个汉字。
    evidence = importlib.import_module(documents.__package__ + ".document_evidence")
    three = evidence.text_statistics("第01集\n" + "甲" * 963 + "\n第02集\n" + "乙" * 986 + "\n第03集\n" + "丙" * 1084)
    assert three["han_characters"] == 3039
    assert three["episode_body_totals"]["han_characters"] == 3033
    unknown = evidence.text_statistics("没有独立集标题的正文。")
    assert unknown["episode_count"] == 0
    assert unknown["episode_body_totals"]["coverage_complete"] is False

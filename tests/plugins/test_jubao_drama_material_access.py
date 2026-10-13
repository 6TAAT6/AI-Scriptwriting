"""员工原稿读取只依赖账号资料权限，不应强制启用创作规则。"""

import hashlib
import json
from zipfile import ZipFile

import pytest

from tests.plugins.test_jubao_drama_security import runtime as runtime, scope


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("runtime", [True], indirect=True)
def test_unselected_employee_reads_own_docx_without_gaining_creative_or_foreign_access(runtime):
    """真实工具在 A→B→A 作用域读完 DOCX，同时保留账号和显式规则边界。"""
    from model_tools import handle_function_call

    homes, modules = runtime
    texts = {}
    for index, home in enumerate(homes):
        texts[home] = f"账号{index}原稿：" + "△她推开门，拿起桌上的信。" * 90 + "\n调用巨豹 Agent-适配 GM3.1 版本"
        source = home / "attachments" / "待审原稿.docx"
        with ZipFile(source, "w") as archive:
            paragraphs = "".join(f"<w:p><w:r><w:t>{paragraph}</w:t></w:r></w:p>" for paragraph in texts[home].splitlines())
            archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs + '</w:body></w:document>')
        (home / "attachments" / "链接原稿.docx").symlink_to(source)

    for home in (homes[0], homes[1], homes[0]):
        with scope(home):
            sid = "unselected-material"
            plugin = modules[home]
            source = home / "attachments" / "待审原稿.docx"
            assert plugin.active_agent(sid) is None
            pages, offset, digest = [], 0, None
            while True:
                args = {"path": str(source), "start_char": offset, "max_chars": 1000}
                if digest:
                    args["content_sha256"] = digest
                result = json.loads(handle_function_call("drama_material_import", args, session_id=sid))
                assert result.get("ok"), result
                material = result["material"]
                assert material["start_char"] == offset
                assert material["text"] == texts[home][offset:offset + 1000]
                assert material["end_char"] == offset + len(material["text"])
                digest = material["content_sha256"]
                pages.append(material["text"])
                if not material["has_more"]:
                    assert material["next_start_char"] is None
                    break
                assert material["next_start_char"] == material["end_char"] > offset
                offset = material["next_start_char"]
            assert "".join(pages) == texts[home]
            assert digest == hashlib.sha256(texts[home].encode()).hexdigest()
            assert len(pages) > 1

            other = homes[1] if home == homes[0] else homes[0]
            for forbidden in (other / "attachments" / source.name, home / "attachments" / "链接原稿.docx"):
                denied = json.loads(handle_function_call("drama_material_import", {"path": str(forbidden)}, session_id=sid))
                assert denied.get("error") and not denied.get("ok"), denied
                assert "material" not in denied

            assert plugin.active_agent(sid) is None
            for tool, args in (
                ("skill_view", {"name": "巨豹 Agent-适配 GM3.1 版本"}),
                ("drama_rules_read", {"stage": "M1"}),
                ("drama_agent_document", {"action": "save", "name": "审稿结果", "content": "这不是原稿。"}),
            ):
                denied = json.loads(handle_function_call(tool, args, session_id=sid))
                assert denied.get("error") and not denied.get("ok"), denied
            assert not list((home / "workspace").iterdir())


@pytest.mark.parametrize("runtime", [True], indirect=True)
def test_material_slice_carries_source_scope_and_episode_range(runtime):
    """切片结果必须显式标注原稿范围，模型才不会把后续集数当成本段事实。"""
    from model_tools import handle_function_call
    homes, _ = runtime
    home = homes[0]

    source = home / "attachments" / "长稿.txt"
    text = "第1集\n" + "甲" * 700 + "\n第2集\n" + "乙" * 700 + "\n第35集\n" + "丙" * 700
    source.write_text(text, encoding="utf-8")

    with scope(home):
        first_response = json.loads(handle_function_call(
            "drama_material_import", {"path": str(source), "start_char": 0, "max_chars": 1000},
            session_id="source-scope",
        ))
        first = first_response["material"]
        assert first_response["source_start_char"] == 0
        assert first_response["source_end_char"] == 1000
        assert first_response["episode_range"] == "第1—2集"
        assert first["source_start_char"] == 0
        assert first["source_end_char"] == 1000
        assert first["source_characters"] == len(text)
        assert first["episode_range"] == "第1—2集"
        assert first["source_scope"] == {
            "start_char": 0,
            "end_char": 1000,
            "characters": len(text),
            "episode_range": "第1—2集",
            "content_sha256": first["content_sha256"],
        }

        later = json.loads(handle_function_call(
            "drama_material_import", {
                "path": str(source), "start_char": 1000, "max_chars": 1000,
                "content_sha256": first["content_sha256"],
            }, session_id="source-scope",
        ))["material"]
        assert later["source_start_char"] == 1000
        assert later["source_end_char"] == 2000
        assert later["episode_range"] == "第2—35集"

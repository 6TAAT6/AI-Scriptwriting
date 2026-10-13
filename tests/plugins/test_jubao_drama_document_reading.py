"""稿件回读必须覆盖合法续接，并保持结果可由员工模型完整读取。"""

from contextlib import closing
import hashlib
import importlib
import importlib.util
import json
from pathlib import Path
import sys

import pytest

from tests.plugins.test_jubao_drama_agent_exports import profile_scope


@pytest.fixture
def plugin():
    location = Path(__file__).resolve().parents[2] / "extensions/jubao-drama/__init__.py"
    spec = importlib.util.spec_from_file_location(
        "jubao_document_reading_test", location, submodule_search_locations=[str(location.parent)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_compression_reads_stay_within_account_agent_and_verified_lineage(plugin, tmp_path, monkeypatch):
    from agent.secret_scope import is_multiplex_active, set_multiplex_active
    from hermes_state import SessionDB

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    homes = [tmp_path / "a", tmp_path / "b"]
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    previous = is_multiplex_active()
    set_multiplex_active(True)
    saved = {}
    try:
        for home in (*homes, homes[0]):
            home.mkdir(exist_ok=True)
            (home / "config.yaml").write_text("studio_security:\n  restricted: true\n  require_agent_invocation: true\n")
            with profile_scope(home), closing(SessionDB(home / "state.db")) as database:
                if home not in saved:
                    database.create_session("parent", source="web")
                    plugin.activate_agent("parent", "gm3-1")
                    result = plugin.document_action({"action": "save", "kind": "script", "name": "第1—10集",
                                                     "content": f"第1集\n林岚：这是账号{home.name}的蓝钥匙。"}, "parent")
                    saved[home] = result["document"]["id"]
                    database.end_session("parent", "compression")
                    database.create_session("continued", source="web", parent_session_id="parent")
                    for sid, source, marker in (("branch", "web", "_branched_from"), ("delegate", "tool", "_delegate_from"),
                                                ("reset", "web", "_reset_from")):
                        database.create_session(sid, source=source, parent_session_id="parent",
                                                model_config={marker: "parent"})
                    database.create_session("unrelated", source="web")
                    plugin.activate_agent("unrelated", "gm3-1")
                    database.create_session("different-agent", source="web", parent_session_id="parent")
                    plugin.activate_agent("different-agent", "gr4-7", replace=True)
                    database.create_session("skills-parent", source="web")
                    selection = importlib.import_module(plugin.__name__ + ".capability_selection")
                    selection._apply_commands([("调用", "humanize")], "skills-parent")
                    independent = plugin.document_action({"action": "save", "kind": "internal", "name": "独立技能稿",
                                                          "content": "只属于独立技能会话的正文。"}, "skills-parent")
                    database.end_session("skills-parent", "compression")
                    database.create_session("skills-child", source="web", parent_session_id="skills-parent")
                    saved[(home, "skills")] = independent["document"]["id"]
                identifier = saved[home]
                read = plugin.document_action({"action": "read", "document_id": identifier}, "continued")
                assert f"账号{home.name}的蓝钥匙" in read["document"]["content"]
                assert identifier in {item["id"] for item in plugin.document_action({"action": "list"}, "continued")["documents"]}
                assert plugin.document_action({"action": "export", "document_id": identifier}, "continued")["receipt"]["content_verified"]
                independent = plugin.document_action({"action": "read", "document_id": saved[(home, "skills")]}, "skills-child")
                assert independent["document"]["content"] == "只属于独立技能会话的正文。"
                for sid in ("branch", "delegate", "reset", "unrelated", "different-agent"):
                    with pytest.raises(ValueError, match="当前 Agent 会话"):
                        plugin.document_action({"action": "read", "document_id": identifier}, sid)
                other = next((saved[candidate] for candidate in homes if candidate != home and candidate in saved), None)
                if other:
                    with pytest.raises(ValueError, match="当前 Agent 会话"):
                        plugin.document_action({"action": "read", "document_id": other}, "continued")
    finally:
        set_multiplex_active(previous)


def test_model_document_pages_reconstruct_only_requested_text_without_spillover(plugin, tmp_path):
    from tools.budget_config import BudgetConfig
    from tools.tool_result_storage import maybe_persist_tool_result

    with profile_scope(tmp_path):
        plugin.activate_agent("author", "gm3-1")
        saved_ids = []
        for index in range(50):
            content = f"第{index + 1}集\n" + "其他批次的完整正文。" * (1100 if index < 10 else 1)
            saved = plugin.document_action({"action": "save", "kind": "internal", "name": f"第{index + 1}集_" + "稿件" * 50,
                                            "content": content}, "author")
            saved_ids.append(saved["document"]["id"])
        target = "\n\n".join(f"第{episode}集\n" + "林岚：我留下这把钥匙。" * 60 for episode in range(51, 151))
        saved = plugin.document_action({"action": "save", "kind": "script", "name": "第51—150集", "content": target}, "author")
        identifier = saved["document"]["id"]
        assert "content" not in saved["document"]
        assert all("content" not in item for item in saved["project"]["artifacts"])

        seen, offset, snapshot = [], 0, None
        concurrent_id = None
        while True:
            listed = plugin.document_action({"action": "list", "offset": offset, "limit": 50,
                                             **({"snapshot_rowid": snapshot} if snapshot is not None else {})}, "author")
            if snapshot is None:
                snapshot = listed["snapshot_rowid"]
                concurrent = plugin.document_action({"action": "save", "kind": "internal", "name": "翻页期间的新稿",
                                                     "content": "第52集\n并发新增不挤动旧目录。"}, "author")
                concurrent_id = concurrent["document"]["id"]
            assert listed["snapshot_rowid"] == snapshot
            assert "project" not in listed and "exports" not in listed
            assert listed["coverage"]["start_offset"] == offset
            assert listed["coverage"]["end_offset"] == offset + len(listed["documents"])
            assert listed["coverage"]["complete"] is (offset == 0 and len(listed["documents"]) == listed["total"])
            assert listed["total"] == 51 and listed["offset"] == offset
            assert all("content" not in item and item["content_sha256"] and item["characters"] > 0 for item in listed["documents"])
            raw = json.dumps(listed, ensure_ascii=False, indent=2)
            assert len(raw) <= 6000
            for item in listed["documents"]:
                if item.get("id", item.get("artifact_id")) == identifier:
                    stats = item["text_statistics"]
                    assert stats["episode_count"] == 100 and "episodes" not in stats
            assert maybe_persist_tool_result(raw, "drama_agent_document", f"list-{offset}", config=BudgetConfig(default_result_size=8000)) == raw
            seen.extend(item["id"] for item in listed["documents"])
            if not listed["has_more"]:
                assert listed["next_offset"] is None and listed["next_call"] is None
                break
            assert listed["next_offset"] > offset
            next_call = listed["next_call"]
            assert next_call == {"action": "list", "offset": listed["next_offset"], "snapshot_rowid": snapshot}
            offset = next_call["offset"]
        assert seen == [identifier, *reversed(saved_ids)]
        fresh = plugin.document_action({"action": "list", "limit": 1}, "author")
        assert fresh["documents"][0]["id"] == concurrent_id and fresh["total"] == 52
        assert fresh["snapshot_rowid"] > snapshot

        digest, start, parts = hashlib.sha256(target.encode()).hexdigest(), 0, []
        while True:
            page = plugin.document_action({"action": "read", "document_id": identifier, "start_char": start,
                                           "max_chars": 20000, "content_sha256": digest}, "author")
            assert page["start_char"] == start and page["characters"] == len(target) and page["content_sha256"] == digest
            assert page["source_scope"]["hash_target"] == "stored_document_text"
            assert page["end_char"] - start == len(page["document"]["content"]) <= 20000
            assert [item["id"] for item in page["project"]["artifacts"]] == [identifier]
            assert all("content" not in item for item in page["project"]["artifacts"])
            raw = json.dumps(page, ensure_ascii=False, indent=2)
            assert "其他批次的完整正文" not in raw
            assert maybe_persist_tool_result(raw, "drama_agent_document", f"read-{start}") == raw
            parts.append(page["document"]["content"])
            if not page["has_more"]:
                assert page["next_start_char"] is None
                break
            start = page["next_start_char"]
        assert "".join(parts) == target
        for arguments in ({"content_sha256": "0" * 64}, {"start_char": -1}, {"max_chars": 20001}, {"max_chars": True}):
            with pytest.raises(ValueError):
                plugin.document_action({"action": "read", "document_id": identifier, **arguments}, "author")
        for arguments in ({"offset": -1}, {"limit": 51}, {"limit": True}, {"snapshot_rowid": -1}, {"snapshot_rowid": True}, {"snapshot_rowid": "1"}):
            with pytest.raises(ValueError):
                plugin.document_action({"action": "list", **arguments}, "author")

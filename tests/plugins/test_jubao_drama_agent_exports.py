"""独立稿件保存须交付真实 Word，失败可恢复且跨账号、会话和 Agent 隔离。"""

from contextlib import closing, contextmanager
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import pytest

from plugins.plugin_storage import plugin_db


@pytest.fixture
def plugin():
    location = Path(__file__).resolve().parents[2] / "extensions/jubao-drama/__init__.py"
    spec = importlib.util.spec_from_file_location(
        "jubao_drama_agent_exports_test", location, submodule_search_locations=[str(location.parent)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@contextmanager
def profile_scope(home):
    from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from tools.terminal_scope import reset_terminal_scope, set_terminal_scope

    home_token = set_hermes_home_override(home)
    secret_token = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
    terminal_token = set_terminal_scope({})
    try:
        yield
    finally:
        reset_terminal_scope(terminal_token)
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)


def test_save_persists_word_versions_and_recovers_without_losing_saved_text(plugin, tmp_path):
    with profile_scope(tmp_path):
        plugin.activate_agent("author", "gm3-1")
        # 旧版只有正文表，升级后仍可读取和补导出。
        with closing(plugin_db("jubao-drama")) as conn:
            conn.execute("CREATE TABLE agent_documents (id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, name TEXT, content TEXT)")
            conn.execute("INSERT INTO agent_documents VALUES (?,?,?,?,?)", ("legacy", "author", "gm3-1", "旧项目介绍", "林岚追查失踪的师父。"))
            conn.commit()
        legacy = plugin.document_action({"action": "export", "document_id": "legacy"}, "author")
        assert legacy["receipt"]["artifact_id"] == "legacy"
        assert legacy["receipt"]["kind"] == "document"

        args = {"action": "save", "name": "第01批叙事大纲", "content": "# 第1集\n主角在雨夜找到证据。", "kind": "outline"}
        saved = plugin.document_action(args, "author")
        receipt = saved["receipt"]
        document_id = saved["document"]["id"]
        assert saved["document"]["kind"] == "outline" and saved["document"]["status"] == "draft"
        assert receipt["artifact_id"] == document_id and receipt["status"] == "draft"
        assert receipt["format"] == "docx" and receipt["kind"] == "outline"
        assert "主角在雨夜找到证据。" in plugin.read_material(receipt["path"])["text"]
        assert plugin.document_action(args, "author")["receipt"] == receipt
        assert plugin.document_action({"action": "export", "document_id": document_id}, "author")["receipt"] == receipt

        revised = plugin.document_action({**args, "content": "第1集\n主角在雨夜找到新的证据。"}, "author")
        internal = plugin.document_action({"action": "save", "name": "内部笔记", "content": "待核实师父动机。", "kind": "internal"}, "author")
        assert revised["document"]["id"] != document_id
        assert "receipt" not in internal
        with pytest.raises(ValueError, match="内部稿件"):
            plugin.document_action({"action": "export", "document_id": internal["document"]["id"]}, "author")
        listed = plugin.document_action({"action": "list"}, "author")
        read = plugin.document_action({"action": "read", "document_id": document_id}, "author")
        assert read["project"]["exports"] == [receipt]
        listed_ids = {item["id"] for item in listed["documents"]}
        while listed["has_more"]:
            listed = plugin.document_action(listed["next_call"], "author")
            listed_ids.update(item["id"] for item in listed["documents"])
        assert document_id in listed_ids and revised["document"]["id"] in listed_ids
        for expected in (receipt, revised["receipt"]):
            exported = plugin.document_action({"action": "export", "document_id": expected["artifact_id"]}, "author")["receipt"]
            assert exported["sha256"] == expected["sha256"] and exported["source_sha256"] == expected["source_sha256"]

        # 回执存在不能证明磁盘文件仍可读，损坏后须生成新文件并保留原路径。
        Path(receipt["path"]).write_bytes(b"damaged document")
        repaired = plugin.document_action({"action": "export", "document_id": document_id}, "author")
        assert repaired["receipt"]["path"] != receipt["path"]
        assert Path(receipt["path"]).read_bytes() == b"damaged document"
        assert "主角在雨夜找到证据。" in plugin.read_material(repaired["receipt"]["path"])["text"]

        plugin.activate_agent("blocked", "gm3-1")
        blocked = tmp_path / "workspace" / "agents" / "gm3-1" / hashlib.sha256(b"blocked").hexdigest()[:24]
        blocked.write_text("不能作为目录", encoding="utf-8")
        new_args = {"action": "save", "name": "待导出正文", "content": "第1集\n林岚：证据找到了。", "kind": "script"}
        failed = plugin.document_action(new_args, "blocked")
        assert failed["ok"] is False and failed["saved"] is True and failed["export_error"]
        pending = plugin.document_action({"action": "list"}, "blocked")
        assert plugin.document_action({"action": "read", "document_id": pending["documents"][0]["id"]}, "blocked")["document"]["content"] == new_args["content"]
        assert plugin.document_action({"action": "read", "document_id": pending["documents"][0]["id"]}, "blocked")["document"]["export_status"] == "failed"
        blocked.unlink()
        retried = plugin.document_action(new_args, "blocked")
        assert retried["ok"] is True and retried["document"]["id"] == failed["document"]["id"]
        assert "林岚：证据找到了。" in plugin.read_material(retried["receipt"]["path"])["text"]
        listed = plugin.document_action({"action": "list"}, "author")
        assert revised["document"]["id"] in {item["id"] for item in listed["documents"]}


def test_real_profile_scope_preserves_receipts_across_a_b_a_without_cross_access(plugin, tmp_path, monkeypatch):
    from agent.secret_scope import is_multiplex_active, set_multiplex_active

    homes = [tmp_path / "profile-a", tmp_path / "profile-b"]
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    for home in homes:
        (home / "workspace").mkdir(parents=True)
        (home / "config.yaml").write_text("studio_security:\n  restricted: true\n  require_agent_invocation: true\n", encoding="utf-8")
    was_multiplex = is_multiplex_active()
    set_multiplex_active(True)
    saved = {}
    args = {"action": "save", "name": "第01批正文", "content": "第1集\n林岚：证据找到了。", "kind": "script"}
    try:
        for home in (homes[0], homes[1], homes[0]):
            with profile_scope(home):
                plugin.activate_agent("author", "gm3-1")
                current = plugin.document_action(args, "author")
                assert current["ok"] and current["receipt"]["content_verified"]
                assert Path(current["receipt"]["path"]).is_relative_to(home)
                assert "林岚：证据找到了。" in plugin.read_material(current["receipt"]["path"])["text"]
                if home in saved:
                    assert current["document"]["id"] == saved[home]["document"]["id"]
                    assert current["receipt"] == saved[home]["receipt"]
                saved[home] = current
                listed = plugin.document_action({"action": "list"}, "author")
                assert [row["id"] for row in listed["documents"]] == [current["document"]["id"]]
                restored = plugin.document_action({"action": "export", "document_id": current["document"]["id"]}, "author")["receipt"]
                assert all(restored[key] == current["receipt"][key]
                           for key in ("artifact_id", "path", "sha256", "source_sha256", "content_verified"))
                other = next((value for key, value in saved.items() if key != home), None)
                if other:
                    with pytest.raises(ValueError, match="当前 Agent 会话"):
                        plugin.document_action({"action": "read", "document_id": other["document"]["id"]}, "author")
                plugin.activate_agent("other-session", "gm3-1")
                assert plugin.document_action({"action": "list"}, "other-session")["documents"] == []
                plugin.activate_agent("author", "gr4-7", replace=True)
                assert plugin.document_action({"action": "list"}, "author")["documents"] == []
                with pytest.raises(ValueError, match="当前 Agent 会话"):
                    plugin.document_action({"action": "export", "document_id": current["document"]["id"]}, "author")
                plugin.activate_agent("author", "gm3-1", replace=True)
    finally:
        set_multiplex_active(was_multiplex)
    assert saved[homes[0]]["document"]["id"] != saved[homes[1]]["document"]["id"]


def test_completed_reply_recovers_each_manuscript_from_real_history_once(plugin, tmp_path):
    from hermes_state import SessionDB

    response = (
        "这次分别给出分析、大纲、正文和小说。\n\n# 《夜雨》大纲与剧本\n\n"
        "## 剧情分析\n\n### 人物动机\n\n1. 林岚的调查目标是找出证物被替换的时间。她先核对两位证人的陈述，"
        "发现同一段录音被剪接；线索的来源在前场已经交代，反转因此有明确依据。\n\n"
        "## 第1批分集大纲\n\n第1集\n林岚在雨夜回到旧楼，找到门卫留下的钥匙。她没有贸然开门，"
        "而是先找到登记簿，核对钥匙领取人，再和门卫一起打开档案室。\n\n"
        "## 第1批剧本正文\n\n第01集\n\n1-1场 档案室 夜 内\n\n人物：林岚、门卫\n\n"
        "△林岚把登记簿放在桌上，指着最下面一行日期。\n\n林岚：这把钥匙昨晚是谁领走的？\n\n"
        "门卫：老周。上面还有他的签名。\n\n"
        "## 小说第一章\n\n雨水顺着旧楼的外墙往下流。林岚站在门口，听见门卫把一串钥匙放到桌上。"
        "她翻开登记簿，那个熟悉的签名仍然留在最下面。她终于知道该去哪里找人。\n\n"
        "## 下一步\n请选择继续方向。\n\n```studio-suggestions\n[{\"label\":\"继续\",\"prompt\":\"继续下一批\"}]\n```"
    )
    with profile_scope(tmp_path):
        database = SessionDB(tmp_path / "state.db")
        try:
            database.create_session("writer", source="web")
            plugin.activate_agent("writer", "gm3-1")
            database.append_message("writer", "user", "生成剧情分析、大纲、剧本正文和小说，每类独立交付。")
            identifier = database.append_message("writer", "assistant", response, finish_reason="stop")
            delivery = importlib.import_module(plugin.__name__ + ".agent_delivery")
            result = delivery.reconcile_session_documents("writer")
            assert {item["kind"] for item in result["documents"]} == {"analysis", "outline", "script", "novel"}
            assert len(result["project"]["exports"]) == 4
            assert all(str(item["source_message_id"]) == str(identifier) for item in result["documents"])
            for receipt in result["project"]["exports"]:
                content = plugin.read_material(receipt["path"])["text"]
                assert "studio-suggestions" not in content and "请选择继续方向" not in content
                assert content.strip() and receipt["content_verified"]
            files = sorted(tmp_path.rglob("*.docx"))
            again = delivery.reconcile_session_documents("writer")
            assert again["captures"] == []
            assert again["documents"] == result["documents"]
            assert sorted(tmp_path.rglob("*.docx")) == files
            database.end_session("writer", "compression")
            database.create_session("continued", source="web", parent_session_id="writer")
            database.append_message("continued", "assistant", response, finish_reason="stop")
            database.append_message("continued", "user", "继续核对刚才的稿件。")
            continued = delivery.reconcile_session_documents("continued")
            assert {item["id"] for item in continued["documents"]} == {item["id"] for item in result["documents"]}
            assert sorted(tmp_path.rglob("*.docx")) == files
        finally:
            database.close()


def test_delivery_obeys_agent_profile_and_completion_boundaries(plugin, tmp_path, monkeypatch):
    from hermes_state import SessionDB
    from agent.secret_scope import is_multiplex_active, set_multiplex_active

    delivery = importlib.import_module(plugin.__name__ + ".agent_delivery")
    homes = [tmp_path / "a", tmp_path / "b"]
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    before = is_multiplex_active()
    set_multiplex_active(True)
    seen = set()
    try:
        for home in (homes[0], homes[1], homes[0]):
            home.mkdir(exist_ok=True)
            with profile_scope(home):
                database = SessionDB(home / "state.db")
                try:
                    database.create_session("writer", source="web")
                    for agent_id in ("oa6-1", "gm3-1", "gr4-7"):
                        plugin.activate_agent("writer", agent_id, replace=True)
                        assert delivery.capture_response("writer", "你好，今天想写什么？", source_id="chat")["captures"] == []
                        assert delivery.capture_response("writer", "## 剧本写作建议\n先写人物，再写冲突。", source_id="advice")["captures"] == []
                        title = {"oa6-1": "## 第04集", "gm3-1": "**第04集**", "gr4-7": "第04集"}[agent_id]
                        response = title + "\n\n**4-1场 办公室 日 内**\n\n人物：林岚、门卫\n\n△林岚推门进来，把登记簿放在桌上。\n\n林岚：昨晚是谁来过？\n\n门卫：老周签了名，钥匙也是他领走的。"
                        saved = delivery.capture_response("writer", response, source_id=agent_id)
                        assert len(saved["captures"]) == (0 if (home, agent_id) in seen else 1)
                        assert len(saved["documents"]) == 1
                        seen.add((home, agent_id))
                        assert Path(saved["project"]["exports"][0]["path"]).is_relative_to(home)
                        assert all(row["kind"] == "script" for row in saved["documents"])
                    if (home, "broken") not in seen:
                        plugin.activate_agent("broken", "gm3-1")
                        blocked = home / "workspace/agents/gm3-1" / hashlib.sha256(b"broken").hexdigest()[:24]
                        blocked.parent.mkdir(parents=True, exist_ok=True)
                        blocked.write_text("暂时不能建立目录")
                        failed = delivery.capture_response("broken", response, source_id="retry")
                        assert failed["documents"][0]["export_status"] == "failed"
                        blocked.unlink()
                        recovered = delivery.capture_response("broken", response, source_id="retry")
                        assert recovered["documents"][0]["id"] == failed["documents"][0]["id"]
                        assert recovered["documents"][0]["export_status"] == "ready"
                        seen.add((home, "broken"))
                    plugin.activate_agent("unfinished", "gm3-1")
                    database.create_session("unfinished", source="web")
                    database.append_message("unfinished", "assistant", response, finish_reason="length")
                    delivery.on_session_end(session_id="unfinished", completed=False, interrupted=True)
                    assert delivery.session_documents("unfinished")["documents"] == []
                    assert delivery.reconcile_session_documents("unfinished")["documents"] == []
                finally:
                    database.close()
    finally:
        set_multiplex_active(before)


def test_delivery_preserves_story_text_and_reuses_saved_manuscript_without_stale_download(plugin, tmp_path):
    delivery = importlib.import_module(plugin.__name__ + ".agent_delivery")
    novel = "# 第一章\n\n雨下了一夜，她走进空旷的候车厅，把旧照片放在桌上。照片背面的日期早已褪色，只剩下一个模糊的名字。\n\n下一步，她打算沿着河堤去找最后一名目击者。\n\n那个人曾在十年前看见船离开码头，却一直没有对任何人说起。她收好照片，决定天亮后立刻出发。"
    script = "## 第1批剧本正文\n\n第01集\n\n1-1场 档案室 日 内\n\n人物：林岚、门卫\n\n△林岚推开门，把旧照片放在桌上。\n\n林岚：这张照片是谁留下的？\n\n门卫：一直锁在柜子里，昨晚才找到。"
    with profile_scope(tmp_path):
        plugin.activate_agent("preserve", "gm3-1")
        result = delivery.capture_response("preserve", novel, source_id="novel")
        assert result["documents"][0]["content"] == novel
        saved = plugin.document_action({"action": "save", "name": "第1批剧本正文", "content": script, "kind": "script"}, "preserve")
        recovered = delivery.capture_response("preserve", script, source_id="script")
        scripts = [row for row in recovered["documents"] if row["kind"] == "script"]
        assert [row["id"] for row in scripts] == [saved["document"]["id"]]
        assert scripts[0]["content"] == script
        revised = delivery.capture_response("preserve", script.replace("昨晚才找到", "今天上午才找到"), source_id="revised")
        assert len([row for row in revised["documents"] if row["kind"] == "script"]) == 2
        Path(saved["receipt"]["path"]).write_bytes(b"corrupt")
        inspected = delivery.session_documents("preserve")
        stale = next(row for row in inspected["documents"] if row["id"] == saved["document"]["id"])
        assert stale["export_status"] != "ready"
        assert all(row["artifact_id"] != stale["id"] for row in inspected["project"]["exports"])
        repaired = delivery.capture_response("preserve", script, source_id="script")
        current = next(row for row in repaired["project"]["exports"] if row["artifact_id"] == stale["id"])
        assert current["path"] != saved["receipt"]["path"]
        assert "这张照片" in plugin.read_material(current["path"])["text"]
        for title in ("项目档案", "人物设定", "世界观", "创作方案"):
            content = f"# {title}\n\n故事发生在临江小城，主角林岚负责调查旧案。她必须在档案封存前找到最后一名证人，并核对被调换的照片。\n\n原始照片由门卫保管，钥匙由林岚持有；任何转移都必须在后续场景中明确交代。"
            material = delivery.capture_response("preserve", content, source_id=title)
            assert material["captures"][0]["kind"] == "document"
        # 不同模型常在回复中补类型标题及交付通知，正式工具已保存的纯正文不能因此变成新版本。
        notification = "四份短稿已分别按 analysis、outline、script、novel 类型独立保存并生成 Word，可通过稿件栏下载；以上通知未写入稿件。"
        introduction = "我是巨豹智能体，当前已启用 GM3.1 版本；输入 `/help` 可查看可用命令。"
        for kind, title in (("analysis", "剧情分析"), ("outline", "分集大纲"), ("novel", "小说正文")):
            session = "wrapper-" + kind
            plugin.activate_agent(session, "gm3-1")
            content = "林岚把照片交给门卫，请他核对背面的日期。门卫认出了那个名字，却没有立即作答。\n\n下一步，她打算沿着河堤去找最后一名目击者。她把剩余材料装进袋里，等到天亮才出发。"
            original = plugin.document_action({"action": "save", "name": title, "content": content, "kind": kind}, session)
            response = f"## {title}\n\n{content}\n\n{notification}\n\n{introduction}"
            captured = delivery.capture_response(session, response, source_id="wrapped")
            assert len(captured["documents"]) == 1
            assert captured["documents"][0]["id"] == original["document"]["id"]
            assert captured["documents"][0]["content"] == content
            if kind == "novel":
                chapter = delivery.capture_response(session, "## 小说正文\n\n# 第一章\n\n" + content, source_id="chapter")
                assert len(chapter["documents"]) == 2
                assert any("第一章" in row["content"] for row in chapter["documents"])


def test_reconcile_uses_explicit_turn_ownership_and_real_tool_receipts_for_summary_links(plugin, tmp_path):
    from hermes_state import SessionDB
    delivery = importlib.import_module(plugin.__name__ + ".agent_delivery")
    content = "第01集\n\n1-1场 档案室 日 内\n\n人物：林岚、门卫\n\n△林岚推开门，把旧照片放在桌上。\n\n林岚：这张照片是谁留下的？\n\n门卫：一直锁在柜子里，昨晚才找到。"
    with profile_scope(tmp_path):
        database = SessionDB(tmp_path / "state.db")
        try:
            database.create_session("history", source="web")
            database.append_message("history", "user", "随便给我一段剧情。", timestamp=10)
            database.append_message("history", "assistant", content.replace("第01集", "第99集"), timestamp=11, finish_reason="stop")
            plugin.activate_agent("history", "gm3-1")
            database.append_message("history", "user", "调用巨豹 Agent-适配 GM3.1 版本\n生成剧本正文。")
            call = {"id": "save-call", "type": "function", "function": {"name": "drama_agent_document", "arguments": "{}"}}
            database.append_message("history", "assistant", "", tool_calls=[call])
            saved = plugin.document_action({"action": "save", "name": "第一批正文", "content": content, "kind": "script"}, "history")
            database.append_message("history", "tool", json.dumps(saved, ensure_ascii=False), tool_name="drama_agent_document", tool_call_id="save-call")
            summary = "本批剧本正文已经完成并保存为 Word 文件。\n\n" + "你可以在右侧资料栏阅读和下载这一批稿件，确认后再继续下一批。正文保留既有排版和人物设定。" * 4
            identifier = database.append_message("history", "assistant", summary, finish_reason="stop")
            result = delivery.reconcile_session_documents("history")
            assert [row["id"] for row in result["documents"]] == [saved["document"]["id"]]
            assert str(result["documents"][0]["source_message_id"]) == str(identifier)
            assert result["documents"][0]["source_response_sha256"] == hashlib.sha256(summary.encode()).hexdigest()
            assert delivery.capture_response("history", summary, source_id="summary-without-receipt", user_message="生成剧本正文。")["captures"] == []

            # 原生超长回执会落盘为指针，真实来源关联仍须恢复；不同 profile 和符号链接不得读取。
            from tools.tool_result_storage import maybe_persist_tool_result
            database.append_message("history", "user", "继续交付创作资料，并补齐大纲。")
            document = "# 项目档案\n\n故事发生在临江小城，林岚负责调查十年前的旧案。她必须在档案封存前找到最后一名目击者，并核对被调换的旧照片。\n\n故事风格保持克制，所有反转都有明确的证据来源和时间顺序。"
            saved_material = plugin.document_action({"action": "save", "name": "项目档案", "content": document, "kind": "document"}, "history")
            spill = maybe_persist_tool_result(json.dumps(saved_material, ensure_ascii=False), "drama_agent_document", "call_receipt", threshold=1)
            database.append_message("history", "tool", spill, tool_name="drama_agent_document", tool_call_id="call_receipt")
            outline = "项目档案已经保存为 Word 文件。\n\n## 分集大纲\n\n第1集，林岚发现照片被调换，开始追查谁在最后一次交接时进入档案室。\n\n第2集，她找到门卫的登记本，核对领取钥匙的人，并把两份互相矛盾的证言放到一起。"
            last = database.append_message("history", "assistant", outline, finish_reason="stop")
            materials = delivery.reconcile_session_documents("history")
            assert len(materials["documents"]) == 3
            associated = [row for row in materials["documents"] if str(row.get("source_message_id")) == str(last)]
            assert {row["kind"] for row in associated} == {"document", "outline"}
            outsider = tmp_path.parent / "other-profile-receipt.txt"
            outsider.write_text(json.dumps(saved_material, ensure_ascii=False))
            forbidden = f"<persisted-output>\nFull output saved to: {outsider}\n</persisted-output>"
            assert delivery._tool_document_ids({"tool_name": "drama_agent_document", "content": forbidden}, {saved_material["document"]["id"]}) == []
            linked_path = tmp_path / "cache/spillover/call_link.txt"
            linked_path.symlink_to(outsider)
            symbolic = f"<persisted-output>\nFull output saved to: {linked_path}\n</persisted-output>"
            assert delivery._tool_document_ids({"tool_name": "drama_agent_document", "content": symbolic}, {saved_material["document"]["id"]}) == []

            instructions = "请从以下入口中选择，我再进入创作阶段。\n\n1. **灵感碎片**：一句话概念、人物设定雏形、核心戏剧冲突或特定情境。\n2. **已有材料**：现有的大纲草案、人物小传、分集设想或初稿剧本。\n3. **快速启动方向**：指定项目类型，例如短片或连续剧。"
            assert delivery.capture_response("history", instructions, source_id="instructions")["captures"] == []
            workflow = "### 进入 Step 3a（S3 大纲锁定前置）\n\n请选择稳健版还是大胆版。稳健版采用人物关系推进剧情，大胆版采用外部事件推进剧情。确认后我再输出完整大纲。"
            assert delivery.capture_response("history", workflow, source_id="workflow")["captures"] == []
            archive = "# 项目档案\n\n## 世界观设定\n\n故事发生在临江小城，照片和档案均由门卫保管。林岚必须取得登记钥匙，才能进入封存室，任何证物转移都需要明确交代。\n\n## 三幕大纲\n\n第一幕，林岚发现照片被换；第二幕，她找到领取钥匙的人；第三幕，两人共同核对证言并锁定作案时间。每个反转都基于已经建立的线索。"
            saved_archive = plugin.document_action({"action": "save", "name": "完整项目档案", "content": archive, "kind": "document"}, "history")
            database.append_message("history", "user", "展示已保存的项目档案。")
            database.append_message("history", "tool", json.dumps(saved_archive, ensure_ascii=False), tool_name="drama_agent_document")
            database.append_message("history", "assistant", archive + "\n\n" + workflow, finish_reason="stop")
            archived = delivery.reconcile_session_documents("history")
            assert len(archived["documents"]) == 4
            assert next(item for item in archived["documents"] if item["id"] == saved_archive["document"]["id"])["content"] == archive
            outline_source = "原稿以照片被调换作为开场，以钥匙登记作为推进线索。林岚核对了两份互相矛盾的证言，最终确定照片是在档案室关闭之后被人偷换。"
            authoritative = plugin.document_action({"action": "save", "name": "雨夜_分集大纲_候选版本v1.0", "content": outline_source, "kind": "outline"}, "history")
            for version, expected_count in (("v1.0", 5), ("v1.1", 6)):
                database.append_message("history", "user", "查看本批正式大纲。")
                database.append_message("history", "tool", json.dumps(authoritative, ensure_ascii=False), tool_name="drama_agent_document")
                display = f"本批文稿已保存并生成 Word。\n\n# 《雨夜》分集大纲 · 候选版本{version}\n\n林岚以照片失窃为调查起点，借助钥匙领取表缩小嫌疑人范围。两份证词的冲突让她最终确认了照片被换的时间，并决定在下一集当面对质。"
                database.append_message("history", "assistant", display, finish_reason="stop")
                compared = delivery.reconcile_session_documents("history")
                assert len(compared["documents"]) == expected_count
                assert next(item for item in compared["documents"] if item["id"] == authoritative["document"]["id"])["content"] == outline_source
        finally:
            database.close()


def test_merge_delivery_summary_does_not_become_a_manuscript_or_link_read_sources(plugin, tmp_path):
    """真实合并稿已保存时，交付说明和核对摘句不是另一份完整正文。"""
    from hermes_state import SessionDB
    delivery = importlib.import_module(plugin.__name__ + '.agent_delivery')
    with profile_scope(tmp_path), closing(SessionDB(tmp_path / 'state.db')) as database:
        database.create_session('merge', source='web')
        plugin.activate_agent('merge', 'gm3-1')
        source = plugin.document_action({'action':'save','kind':'script','name':'第一集来源',
                                         'content':'第1集\n1-1场 室内 日 内\n人物：林岚\n△林岚将交付给剧院的道具放好。\n林岚：钥匙给你。'}, 'merge')
        database.append_message('merge','user','调用巨豹 Agent-适配 GM3.1 版本\n请合并原文并核对两端台词。')
        read_args = {'action':'read','document_id':source['document']['id']}
        database.append_message('merge','assistant',tool_calls=[{'id':'read-source','type':'function','function':{'name':'drama_agent_document','arguments':json.dumps(read_args)}}])
        database.append_message('merge','tool',json.dumps(plugin.document_action(read_args,'merge'),ensure_ascii=False),tool_name='drama_agent_document',tool_call_id='read-source')
        content = '第1集\n1-1场 室内 日 内\n人物：林岚\n林岚：钥匙给你。\n\n第2集\n2-1场 街头 夜 外\n人物：林岚\n△林岚完成交付，转身离开。\n林岚：我们明天见。'
        save_args = {'action':'save','kind':'script','name':'第01-02集完整正文','content':content}
        database.append_message('merge','assistant',tool_calls=[{'id':'save-merge','type':'function','function':{'name':'drama_agent_document','arguments':json.dumps(save_args,ensure_ascii=False)}}])
        merged=plugin.document_action(save_args,'merge')
        database.append_message('merge','tool',json.dumps(merged,ensure_ascii=False),tool_name='drama_agent_document',tool_call_id='save-merge')
        summary='已完成来源确认与原文合并：\n1. **来源确认**：第一集来自此前已保存的第一批正文，第二集来自独立保存的完整原稿。\n2. **合并交付**：未做任何重写或摘要删减，已按第 01 至 02 集正文顺序全量合并并生成专属 Word。\n\n---\n\n### 【核对关键台词】\n- **第 01 集最后一句台词**：\n  > **林岚：钥匙给你。**\n- **第 02 集最后一句台词**：\n  > **林岚：我们明天见。**\n\n---\n\n【Word 交付文件】\n- 全剧完整正文合集：合并正文.docx'
        message_id=database.append_message('merge','assistant',summary,finish_reason='stop')
        result=delivery.reconcile_session_documents('merge')
        assert {row['id'] for row in result['documents']} == {source['document']['id'],merged['document']['id']}
        assert next(row for row in result['documents'] if row['id']==merged['document']['id'])['content']==content
        linked=[row['id'] for row in result['documents'] if str(row.get('source_message_id'))==str(message_id)]
        assert linked==[merged['document']['id']]
        assert '林岚完成交付' in plugin.read_material(merged['receipt']['path'])['text']
        database.append_message('merge','user','请只核对刚才合并稿的集数、第五集场头与末句台词。')
        args={'action':'read','document_id':merged['document']['id']}
        database.append_message('merge','assistant',tool_calls=[{'id':'verify-read','type':'function','function':{'name':'drama_agent_document','arguments':json.dumps(args)}}])
        database.append_message('merge','tool',json.dumps(plugin.document_action(args,'merge'),ensure_ascii=False),tool_name='drama_agent_document',tool_call_id='verify-read')
        verification='已根据刚才的完整正文读取核对：\n\n1. 集数：第1至2集。\n2. 字符总数：按原稿记录核对。\n3. 第1集场头：\n1-1场 室内 日 内\n4. 第2集最后一句台词：\n林岚：我们明天见。\n\n以上仅为读取到的四项核对结果，原稿中的其他段落未在此重复展示。'
        checked=database.append_message('merge','assistant',verification,finish_reason='stop')
        verified=delivery.reconcile_session_documents('merge')
        assert {row['id'] for row in verified['documents']} == {source['document']['id'],merged['document']['id']}
        assert not any(str(row.get('source_message_id'))==str(checked) for row in verified['documents'])


def test_document_verification_heading_is_not_new_script_and_real_creation_still_saves(plugin, tmp_path):
    """核查报告即使标题含完整正文也不是剧本；无工具的真实创作仍补存。"""
    delivery = importlib.import_module(plugin.__name__ + '.agent_delivery')
    with profile_scope(tmp_path):
        plugin.activate_agent('review-only', 'gm3-1')
        report = "已完成稿件目录查询与完整正文的分段回读核查，报告如下：\n\n### 一、会话稿件目录核查结果\n- 已保存稿件总数：31份\n\n### 二、《测试故事》第1—10集全剧完整正文回读核查结果\n- 对应文档编号：example\n- 总字符数：17059字符（汉字13454，非空白15894）\n- 第10集最后一句：\n> 全体将士：我们明天再见。"
        assert delivery.capture_response('review-only', report, source_id='review-result', user_message='核对已有完整正文。')['captures'] == []
        created = "第1集\n\n1-1场 剧院 日 内\n\n人物：林岚\n\n△林岚将要交付给剧院的道具放好，逐一核对箱子上的名字，再把清单收进口袋。\n\n林岚：核查结果已经写在记录里，这次我们可以放心出发了。"
        result = delivery.capture_response('review-only', created, source_id='new-scene', user_message='请创作第一集完整正文。')
        assert len(result['captures']) == 1
        assert result['captures'][0]['content'] == created
        explicit = plugin.document_action({'action':'save','kind':'analysis','name':'正文核查分析报告','content':report}, 'review-only')
        assert explicit['ok'] and explicit['document']['kind'] == 'analysis'

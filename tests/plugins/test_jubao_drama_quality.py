"""真实剧本工具应保留审核依据，并支持只审稿和只导出的授权范围。"""

import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest


@pytest.fixture
def plugin():
    location = Path(__file__).resolve().parents[2] / "extensions/jubao-drama/__init__.py"
    spec = importlib.util.spec_from_file_location(
        "jubao_drama_quality_test", location, submodule_search_locations=[str(location.parent)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def approve(store, project_id, gate, plan_id=""):
    return store.apply_approval(project_id, gate, store.gate_target(project_id, gate, plan_id), {
        "evidence": "用户确认本次显示的版本", "challenge_id": "fixture-challenge",
        "session_id": "user-session",
    }, plan_id)


def reviewer(callback):
    from agent.plugin_llm import PluginLlmStructuredResult

    def complete_structured(**kwargs):
        verdict, report, issues = callback(json.loads(kwargs["input"][0]["text"]))
        return PluginLlmStructuredResult(
            text=json.dumps({"verdict": verdict, "report": report, "issues": issues}),
            parsed={"verdict": verdict, "report": report, "issues": issues},
            provider="test", model="test", agent_id="review-test",
        )

    return SimpleNamespace(llm=SimpleNamespace(complete_structured=complete_structured))


def test_review_only_reviews_source_without_rewriting_or_creative_gates(plugin):
    store = plugin.ProjectStore()
    source = "第1集\n△林岚收起欠条。\n林岚：这钱，我替他还。"
    project = store.create("只审核现成稿", mode="review", source={"content": source})

    def assess(payload):
        assert payload["batch"]["content"] == source
        assert not payload["basis"]["core"]["approval"]
        return "revise", "核心期待依据不足；当前正文缺少欠款原因。", ["欠款动机缺少依据"]

    result = json.loads(plugin._review_handler(
        reviewer(assess), {"project_id": project["id"], "batch_id": "source"}, session_id="editor"
    ))
    current = store.get(project["id"])
    assert result["review"]["verdict"] == "revise"
    assert current["source"]["content"] == source
    assert current["stage"] == "END" and not current["script_batches"]
    assert current["core"]["approval"] is None


def test_agent_documents_are_versioned_and_isolated_between_agents_and_sessions(plugin, tmp_path):
    from hermes_cli.config import atomic_config_replace
    from hermes_constants import get_hermes_home

    atomic_config_replace(get_hermes_home() / 'config.yaml', {
        'studio_security': {'restricted': True, 'require_agent_invocation': True},
    })
    (get_hermes_home() / 'workspace').mkdir(exist_ok=True)
    plugin.activate_agent('gm-author', 'gm3-1')
    plugin.activate_agent('gr-author', 'gr4-7')
    plugin.activate_agent('gm-other', 'gm3-1')
    result = json.loads(plugin._agent_document_handler({
        'action': 'save', 'name': '状态快照', 'content': '角色甲已经取回欠条。',
    }, session_id='gm-author'))
    document_id = result['document']['id']
    read = json.loads(plugin._agent_document_handler({'action': 'read', 'document_id': document_id}, session_id='gm-author'))
    assert read['document']['content'] == '角色甲已经取回欠条。'
    assert json.loads(plugin._agent_document_handler({'action': 'list'}, session_id='gr-author'))['documents'] == []
    for session in ('gr-author', 'gm-other'):
        with pytest.raises(ValueError, match='当前 Agent 会话'):
            plugin._agent_document_handler({'action': 'read', 'document_id': document_id}, session_id=session)
    exported = json.loads(plugin._agent_document_handler({
        'action': 'export', 'document_id': document_id,
    }, session_id='gm-author'))
    assert exported['receipt']['content_verified']
    assert '角色甲已经取回欠条。' in plugin.read_material(exported['receipt']['path'])['text']
    unchanged = json.loads(plugin._agent_document_handler({'action': 'read', 'document_id': document_id}, session_id='gm-author'))
    assert unchanged['document']['content'] == '角色甲已经取回欠条。'


def test_independent_review_receives_real_requirements_and_prior_accepted_state(plugin):
    store = plugin.ProjectStore()
    project = store.create("连续性审核", source={"content": "林岚是女性修表师，为偿还师父的救命恩情留下。"},
                           request="中国现实，中文，2集，每集约60秒；保留性别和报恩动机。")
    project_id = project["id"]
    store.submit(project_id, "core", {"content": "林岚用专业能力自证清白。"}, "author")
    approve(store, project_id, "core")
    store.submit(project_id, "candidates", {"items": [{"id": "a", "content": "利用校时差找出调包者。"}]}, "author")
    approve(store, project_id, "plan", "a")
    first = store.submit(project_id, "outline_batch", {
        "id": "outline-1", "episodes": [1], "content": "林岚发现监控晚八分钟，欠条交给警方。",
        "continuity": {"欠条": "警方持有"}, "final": False,
        "character_rows": [{"original": "林岚", "new": "林岚"}],
        "episode_rows": [{"original_episodes": "1", "original_outline": "林岚受到指控。",
                          "new_episodes": "1", "new_outline": "林岚把欠条交给警方。"}],
    }, "author")["outline_batches"][0]
    review = {"batch_id": first["id"], "verdict": "pass", "report": "证据链完整。", "issues": []}
    reviewed = store.submit(project_id, "review", review, "editor", trusted_receipt={
        "source": "plugin_llm", "reviewer_session_id": "independent", "request_id": "call-1",
        "artifact_hash": first["content_hash"], "review_hash": plugin.content_hash(review["report"]),
        "project_revision": store.get(project_id)["revision"],
        "generation_revision": store.get(project_id)["generation_revision"],
    })
    store.submit(project_id, "accept_batch", {"batch_id": first["id"], "review_id": reviewed["reviews"][-1]["id"]}, "editor")
    store.submit(project_id, "outline_batch", {
        "id": "outline-2", "episodes": [2], "content": "林岚拿出一直贴身保管的欠条反击。", "final": True,
        "character_rows": [{"original": "林岚", "new": "林岚"}],
        "episode_rows": [{"original_episodes": "2", "original_outline": "林岚发现真相。",
                          "new_episodes": "2", "new_outline": "林岚拿出贴身欠条。"}],
    }, "author")

    def assess(payload):
        basis = payload["basis"]
        assert basis["request"] == "中国现实，中文，2集，每集约60秒；保留性别和报恩动机。"
        assert basis["language"] == "chinese" and basis["region"] == "中国"
        assert basis["source"]["content"] == "林岚是女性修表师，为偿还师父的救命恩情留下。"
        assert basis["core"]["content"] == "林岚用专业能力自证清白。"
        assert basis["core"]["approval"]["content_hash"] == plugin.content_hash(basis["core"]["content"])
        assert basis["plan"]["content"] == "利用校时差找出调包者。"
        assert basis["previous_batch"]["continuity"] == {"欠条": "警方持有"}
        assert payload["batch"]["id"] == "outline-2"
        return "revise", "第2集欠条仍在警方手里，不能凭空出现在林岚身上。", ["欠条持有者连续性错误"]

    result = json.loads(plugin._review_handler(
        reviewer(assess), {"project_id": project_id, "batch_id": "outline-2"}, session_id="editor"
    ))
    assert result["project"]["outline_batches"][-1]["status"] == "revision_requested"
    assert result["review"]["issues"] == ["欠条持有者连续性错误"]


def test_export_only_preserves_source_without_creating_review_claim(plugin, tmp_path):
    store = plugin.ProjectStore()
    source = "第1集\n△林岚推开门。\n林岚：欠条拿来。"
    project = store.create("现成稿导出", mode="export", source={"content": source})
    destination = tmp_path / "用户现成稿.docx"
    result = json.loads(plugin._export_handler({
        "project_id": project["id"], "kind": "script", "destination": str(destination),
    }))
    assert result["receipt"]["content_verified"] is True
    assert [line for line in plugin.read_material(destination)["text"].splitlines() if line.strip()] == source.splitlines()
    current = store.get(project["id"])
    assert current["source"]["content"] == source
    assert current["reviews"] == [] and current["script_batches"] == []
    assert current["core"]["approval"] is None


def test_script_must_cover_the_accepted_outline_before_declaring_final(plugin, tmp_path):
    store = plugin.ProjectStore()
    project = store.create("四集完整交付", source={"content": "原稿共四集，依次发现疑点、取证、对质、脱身。"})
    project_id = project["id"]
    store.submit(project_id, "core", {"content": "主角证明清白并重获自由。"}, "author")
    approve(store, project_id, "core")
    store.submit(project_id, "candidates", {"items": [{"id": "a", "content": "凭维修记录揭穿调包。"}]}, "author")
    approve(store, project_id, "plan", "a")
    store.submit(project_id, "outline_batch", {
        "id": "outline-all", "episodes": [1, 2, 3, 4], "content": "四集新纲全文。", "final": True,
        "character_rows": [{"original": "林岚", "new": "叶青"}],
        "episode_rows": [{"original_episodes": "1—4", "original_outline": "四集原纲",
                          "new_episodes": "1—4", "new_outline": "四集新纲"}],
    }, "author")
    review = json.loads(plugin._review_handler(
        reviewer(lambda _: ("pass", "四集事件与人物因果已核对。", [])),
        {"project_id": project_id, "batch_id": "outline-all"}, session_id="editor",
    ))["review"]
    store.submit(project_id, "accept_batch", {"batch_id": "outline-all", "review_id": review["id"]}, "editor")
    plugin._export_handler({"project_id": project_id, "kind": "outline", "destination": str(tmp_path / "四集新纲.xlsx")})

    for episodes in ([3, 4], [1, 2]):
        with pytest.raises(ValueError, match="新纲|正文"):
            store.submit(project_id, "script_batch", {
                "episodes": episodes, "content": "仅有两集正文。", "final": True,
            }, "author")
    assert store.get(project_id)["script_batches"] == []
    partial = store.submit(project_id, "script_batch", {
        "id": "script-1", "episodes": [1, 2], "content": "前两集正文。", "final": False,
    }, "author")
    assert partial["script_batches"][0]["episodes"] == [1, 2]
    assert not partial["script_batches"][0]["final"]


def test_concurrent_source_change_cannot_register_export_as_current_version(plugin, tmp_path, monkeypatch):
    store = plugin.ProjectStore()
    project = store.create("并发导出", mode="export", source={"content": "第一版原稿。"})
    export = plugin.export_script

    def export_and_update_source(text, destination):
        receipt = export(text, destination)
        store.submit(project["id"], "source", {"content": "第二版已修订原稿。"}, "author")
        return receipt

    monkeypatch.setattr(plugin, "export_script", export_and_update_source)
    with pytest.raises(ValueError, match="版本|变化"):
        plugin._export_handler({"project_id": project["id"], "kind": "script", "destination": str(tmp_path / "旧版本.docx")})
    current = store.get(project["id"])
    assert current["source"]["content"] == "第二版已修订原稿。"
    assert current["exports"] == []


@pytest.mark.parametrize("kind", ["outline", "script"])
def test_export_rejects_a_reopened_earlier_batch_instead_of_omitting_it(plugin, tmp_path, kind):
    store = plugin.ProjectStore()
    project = store.create("两集交付不可缺集", source={"content": "第1集发现疑点，第2集证据揭晓。"})
    project_id = project["id"]
    store.submit(project_id, "core", {"content": "主角凭证据证明清白。"}, "author")
    approve(store, project_id, "core")
    store.submit(project_id, "candidates", {"items": [{"id": "a", "content": "修表师找出监控时间误差。"}]}, "author")
    approve(store, project_id, "plan", "a")

    def draft_and_accept(stage, episode):
        batch_id = f"{stage}-{episode}"
        store.submit(project_id, stage + "_batch", {
            "id": batch_id, "episodes": [episode], "content": f"第{episode}集的{stage}完整稿件。",
            "final": episode == 2,
            "character_rows": [{"original": "林岚", "new": "叶青"}],
            "episode_rows": [{"original_episodes": str(episode), "original_outline": f"原第{episode}集",
                              "new_episodes": str(episode), "new_outline": f"新第{episode}集"}],
        }, "author")
        review = json.loads(plugin._review_handler(
            reviewer(lambda _: ("pass", "本集证据和前后衔接已核对。", [])),
            {"project_id": project_id, "batch_id": batch_id}, session_id="editor",
        ))["review"]
        store.submit(project_id, "accept_batch", {"batch_id": batch_id, "review_id": review["id"]}, "editor")

    for episode in (1, 2):
        draft_and_accept("outline", episode)
    plugin._export_handler({"project_id": project_id, "kind": "outline", "destination": str(tmp_path / "完整新纲.xlsx")})
    if kind == "script":
        for episode in (1, 2):
            draft_and_accept("script", episode)
    plugin._review_handler(
        reviewer(lambda _: ("revise", "第1集证据取得时机需要返修。", ["证据出现过早"])),
        {"project_id": project_id, "batch_id": kind + "-1"}, session_id="editor",
    )
    before = store.get(project_id)
    assert [batch["status"] for batch in before[kind + "_batches"]] == ["revision_requested", "accepted"]
    destination = tmp_path / ("不可缺第1集." + ("xlsx" if kind == "outline" else "docx"))
    with pytest.raises(ValueError, match="全部"):
        plugin._export_handler({"project_id": project_id, "kind": kind, "destination": str(destination)})
    assert not destination.exists()
    assert store.get(project_id)["exports"] == before["exports"]


def test_review_cannot_accept_identical_text_recreated_under_changed_story_basis(plugin):
    store = plugin.ProjectStore()
    project = store.create("审核不能穿越改编版本", source={"content": "林岚取证自证清白。"})
    project_id = project["id"]
    draft = {"id": "outline-1", "episodes": [1], "content": "林岚还清欠款，重获自由。", "final": True,
             "character_rows": [{"original": "林岚", "new": "林岚"}],
             "episode_rows": [{"original_episodes": "1", "original_outline": "林岚取证自证清白。",
                               "new_episodes": "1", "new_outline": "林岚还清欠款，重获自由。"}]}

    def establish_basis(core, plan):
        store.submit(project_id, "core", {"content": core}, "author")
        approve(store, project_id, "core")
        store.submit(project_id, "candidates", {"items": [{"id": "a", "content": plan}]}, "author")
        approve(store, project_id, "plan", "a")
        return store.submit(project_id, "outline_batch", draft, "author")

    original = establish_basis("主角还清欠款重获自由。", "修表师发现多扣利息。")

    def delayed_assessment(payload):
        assert payload["basis"]["core"]["content"] == "主角还清欠款重获自由。"
        changed = establish_basis("主角发现欠款早已还清，拒绝再次偿还。", "修表师用已还款凭证揭穿诈骗。")
        assert changed["outline_batches"][0]["content_hash"] == original["outline_batches"][0]["content_hash"]
        return "pass", "主角还清欠款的结尾符合旧版创作依据。", []

    with pytest.raises(ValueError, match="版本|依据"):
        plugin._review_handler(reviewer(delayed_assessment), {
            "project_id": project_id, "batch_id": "outline-1",
        }, session_id="editor")
    current = store.get(project_id)
    assert current["generation_revision"] > original["generation_revision"]
    assert current["reviews"] == []
    assert current["outline_batches"][0]["status"] == "draft"


def test_published_submit_examples_reach_the_real_candidate_selection_gate(plugin):
    contract = json.loads(plugin._rules_handler({"stage": "M2A"}))["submit_contract"]
    project = json.loads(plugin._create_handler({"title": "工具参数契约验收"}))["project"]
    for kind in ("source", "core"):
        plugin._submit_handler({"project_id": project["id"], "kind": kind,
                                "data": contract[kind]["example"]}, session_id="author")
    approve(plugin.ProjectStore(), project["id"], "core")
    data = contract["candidates"]["example"]
    submitted = json.loads(plugin._submit_handler({
        "project_id": project["id"], "kind": "candidates", "data": data,
    }, session_id="author"))["project"]
    assert submitted["stage"] == "H2"
    assert submitted["candidates"][0]["content"] == data["items"][0]["content"]
    target = plugin.ProjectStore().gate_target(project["id"], "plan", data["items"][0]["id"])
    assert target["content"] == data["items"][0]["content"]


def test_restart_requires_explicit_stage_and_preserves_confirmed_direction_for_outline_retry(plugin, tmp_path):
    store = plugin.ProjectStore()
    contract = json.loads(plugin._rules_handler({"stage": "M2B"}))["submit_contract"]
    project = store.create("导出字段修复不能清空方向", source={"content": "原稿全文。"})
    project_id = project["id"]
    store.submit(project_id, "core", contract["core"]["example"], "author")
    approve(store, project_id, "core")
    store.submit(project_id, "candidates", contract["candidates"]["example"], "author")
    approve(store, project_id, "plan", "A")
    before = store.submit(project_id, "outline_batch", contract["outline_batch"]["example"], "author")
    for invalid in ({"scope": "outline", "reason": "仅修复对照数据，不改变方向"},
                    {"reason": "未明确重做阶段"}, {"stage": "invalid", "reason": "未知阶段"},
                    {"stage": "M2B", "scope": "outline", "reason": "未知字段"}):
        with pytest.raises(ValueError):
            store.submit(project_id, "restart", invalid, "author")
        assert store.get(project_id) == before
    restarted = store.submit(project_id, "restart", {"stage": "M2B", "reason": "修订当前新纲"}, "author")
    assert restarted["core"] == before["core"] and restarted["plan"] == before["plan"]
    assert restarted["stage"] == "M2B" and restarted["outline_batches"] == []
    assert restarted["archives"][-1]["outline_batches"] == before["outline_batches"]
    store.submit(project_id, "outline_batch", contract["outline_batch"]["example"], "author")
    review = json.loads(plugin._review_handler(reviewer(lambda _: ("pass", "完整新纲已审核。", [])),
                        {"project_id": project_id, "batch_id": "outline-1"}, session_id="editor"))["review"]
    store.submit(project_id, "accept_batch", {"batch_id": "outline-1", "review_id": review["id"]}, "editor")
    plugin._export_handler({"project_id": project_id, "kind": "outline", "destination": str(tmp_path / "重做前新纲.xlsx")})
    with_script = store.submit(project_id, "script_batch", contract["script_batch"]["example"], "author")
    script_restart = store.submit(project_id, "restart", {"stage": "M3", "reason": "仅重做正文"}, "author")
    assert script_restart["outline_batches"] == with_script["outline_batches"]
    assert script_restart["exports"] == with_script["exports"]
    assert script_restart["script_batches"] == [] and script_restart["stage"] == "M3"
    plan_restart = store.submit(project_id, "restart", {"stage": "M2A", "reason": "重新提供方向"}, "author")
    assert plan_restart["core"] == before["core"]
    assert plan_restart["plan"]["selection"] is None and plan_restart["stage"] == "M2A"
    reset = store.submit(project_id, "restart", {"stage": "M1", "reason": "明确从核心全量重做"}, "author")
    assert reset["core"]["approval"] is None and reset["stage"] == "M1"


def test_outline_rejects_unexportable_rows_before_saving_a_draft(plugin):
    from copy import deepcopy

    store = plugin.ProjectStore()
    contract = json.loads(plugin._rules_handler({"stage": "M2B"}))["submit_contract"]
    project = store.create("新纲提交校验", source={"content": "原稿全文。"})
    project_id = project["id"]
    store.submit(project_id, "core", contract["core"]["example"], "author")
    approve(store, project_id, "core")
    store.submit(project_id, "candidates", contract["candidates"]["example"], "author")
    approve(store, project_id, "plan", "A")
    valid = contract["outline_batch"]["example"]
    before = store.get(project_id)
    invalid_rows = (
        ("character_rows", [{"原人物": "林岚", "新人物": "叶青"}]),
        ("episode_rows", [{"原集数": "1", "原大纲": "原纲", "新集数": "1", "新大纲": "新纲"}]),
        ("character_rows", []), ("episode_rows", None),
        ("character_rows", ["人物说明"]), ("character_rows", [{"original": "林岚", "new": " "}]),
    )
    for key, rows in invalid_rows:
        invalid = deepcopy(valid)
        invalid[key] = rows
        with pytest.raises(ValueError, match=key):
            store.submit(project_id, "outline_batch", invalid, "author")
        assert store.get(project_id) == before
    saved = store.submit(project_id, "outline_batch", valid, "author")
    assert saved["outline_batches"][0]["character_rows"] == valid["character_rows"]

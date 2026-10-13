"""剧本状态必须绑定真实确认版本，并隔离同进程的不同配置。"""

import importlib.util
from pathlib import Path

import pytest

from agent.secret_scope import is_multiplex_active, set_multiplex_active
from hermes_constants import reset_hermes_home_override, set_hermes_home_override


@pytest.fixture
def workflow():
    location = Path(__file__).resolve().parents[2] / "extensions/jubao-drama/workflow.py"
    if not location.is_file():
        return None
    spec = importlib.util.spec_from_file_location("jubao_drama_workflow_test", location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def approve(store, project_id, gate, plan_id=""):
    target = store.gate_target(project_id, gate, plan_id)
    return store.apply_approval(project_id, gate, target, {
        "evidence": "用户明确确认当前展示版本", "challenge_id": "challenge-1",
        "session_id": "user-session", "turn_id": "turn-1", "tool_call_id": "tool-1",
        "surface": "desktop",
    }, plan_id)


def test_project_language_defaults_to_chinese_and_preserves_explicit_bilingual(workflow):
    store = workflow.ProjectStore()
    default_project = store.create("默认中文创作")
    bilingual_project = store.create("明确选择双语创作", language="bilingual")
    assert store.get(default_project["id"])["language"] == "chinese"
    assert store.get(bilingual_project["id"])["language"] == "bilingual"


def test_confirmations_bind_versions_and_acceptance_requires_independent_review(workflow):
    assert workflow is not None, "剧本持久化模块尚未实现"
    store = workflow.ProjectStore()
    project = store.create("改编项目", source={"content": "受冤者寻回家人并证明清白。"})
    project_id = project["id"]
    store.submit(project_id, "core", {"content": "观众期待她证明清白并找回亲人。"}, "author")
    candidates = {"items": [{"id": "a", "content": "现代家族故事。"}]}
    with pytest.raises(ValueError):
        store.submit(project_id, "candidates", candidates, "author")
    approve(store, project_id, "core")
    store.submit(project_id, "candidates", candidates, "author")
    stale = store.gate_target(project_id, "plan", "a")
    store.submit(project_id, "candidates", {"items": [
        {"id": "a", "content": "不同的宫廷故事。"}, {"id": "b", "content": "另一个现代故事。"},
    ]}, "author")
    with pytest.raises(ValueError):
        store.apply_approval(project_id, "plan", stale, {
            "evidence": "确认旧版本", "challenge_id": "old", "session_id": "user",
        }, "a")
    approve(store, project_id, "plan", "a")
    draft = store.submit(project_id, "outline_batch", {
        "id": "outline-1", "episodes": [1, 2], "content": "完整新纲第一批。",
        "continuity": {"location": "城堡"}, "final": True,
        "character_rows": [{"original": "小云", "new": "安娜"}],
        "episode_rows": [{"original_episodes": "1—2", "original_outline": "原纲",
                          "new_episodes": "1—2", "new_outline": "新纲"}],
    }, "author")["outline_batches"][0]
    with pytest.raises(ValueError):
        store.submit(project_id, "accept_batch", {"batch_id": draft["id"]}, "editor")
    review = {"batch_id": draft["id"], "verdict": "pass", "report": "已核对核心和连续性。", "issues": []}
    receipt = {"reviewer_session_id": "author", "source": "plugin_llm", "request_id": "review-call",
               "artifact_hash": draft["content_hash"], "review_hash": workflow.content_hash(review["report"]),
               "project_revision": store.get(project_id)["revision"],
               "generation_revision": store.get(project_id)["generation_revision"]}
    with pytest.raises(ValueError):
        store.submit(project_id, "review", review, "editor", trusted_receipt=receipt)
    receipt["reviewer_session_id"] = "independent-review"
    reviewed = store.submit(project_id, "review", review, "editor", trusted_receipt=receipt)
    failed_review = {**review, "verdict": "revise", "report": "证据出场时机有误。", "issues": ["证物尚未取得"]}
    failed_receipt = {**receipt, "request_id": "review-call-2", "review_hash": workflow.content_hash(failed_review["report"]),
                      "project_revision": reviewed["revision"]}
    store.submit(project_id, "review", failed_review, "editor", trusted_receipt=failed_receipt)
    with pytest.raises(ValueError):
        store.submit(project_id, "accept_batch", {
            "batch_id": draft["id"], "review_id": reviewed["reviews"][-1]["id"],
        }, "editor")
    for malformed in ({**review, "issues": ["未修复问题"]}, {**review, "verdict": "approved"}):
        with pytest.raises(ValueError):
            store.submit(project_id, "review", malformed, "editor", trusted_receipt={
                **receipt, "project_revision": store.get(project_id)["revision"],
            })
    reviewed = store.submit(project_id, "review", review, "editor", trusted_receipt={
        **receipt, "request_id": "review-call-3", "project_revision": store.get(project_id)["revision"],
    })
    accepted = store.submit(project_id, "accept_batch", {
        "batch_id": draft["id"], "review_id": reviewed["reviews"][-1]["id"],
    }, "editor")
    assert accepted["outline_batches"][0]["status"] == "accepted"
    assert accepted["outline_batches"][0]["continuity"] == {"location": "城堡"}
    changed_plan = approve(store, project_id, "plan", "b")
    assert changed_plan["outline_batches"] == []
    assert changed_plan["archives"][-1]["outline_batches"][0]["status"] == "accepted"
    store.submit(project_id, "core", {"content": "观众改为期待她救回亲人。"}, "author")
    reset = store.get(project_id)
    assert reset["core"]["approval"] is None
    assert reset["outline_batches"] == []
    assert any(item["outline_batches"] for item in reset["archives"])
    with pytest.raises(ValueError):
        store.submit(project_id, "script_batch", {"episodes": [1], "content": "正文"}, "author")


def test_real_transactions_and_pure_operations_are_profile_scoped(workflow, tmp_path):
    assert workflow is not None, "剧本持久化模块尚未实现"
    store = workflow.ProjectStore()
    multiplex_before = is_multiplex_active()
    set_multiplex_active(True)
    try:
        token = set_hermes_home_override(tmp_path / "a")
        try:
            project_a = store.create("仅审核", mode="review", source={"content": "现成剧本"})
            assert store.status(project_a["id"])["guards"]["review"]["allowed"]
            before = store.get(project_a["id"])
            with pytest.raises(RuntimeError):
                with store.transaction() as connection:
                    changed = store.get(project_a["id"], connection)
                    changed["title"] = "事务中断"
                    store.save(changed, connection)
                    raise RuntimeError("模拟中断")
            assert store.get(project_a["id"]) == before
            analysis = store.create("只做分析", mode="analysis", language="chinese", source={"content": "原剧全文"})
            analyzed = store.submit(analysis["id"], "core", {"content": "分析后的核心期待"}, "analyst")
            assert analyzed["stage"] == "END"
            assert analyzed["core"]["approval"] is None
        finally:
            reset_hermes_home_override(token)
        token = set_hermes_home_override(tmp_path / "b")
        try:
            assert store.list() == []
            with pytest.raises(ValueError):
                store.get(project_a["id"])
            project_b = store.create("仅导出", mode="export", source={"content": "现成中文正文"})
            assert store.status(project_b["id"])["guards"]["export"]["allowed"]
            assert not store.status(project_b["id"])["guards"]["script"]["allowed"]
        finally:
            reset_hermes_home_override(token)
        token = set_hermes_home_override(tmp_path / "a")
        try:
            assert {project["id"] for project in store.list()} == {project_a["id"], analysis["id"]}
            assert store.get(project_a["id"])["title"] == "仅审核"
        finally:
            reset_hermes_home_override(token)
    finally:
        set_multiplex_active(multiplex_before)

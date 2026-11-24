"""OA6.1 项目状态的模型视图：保留流程决策所需的标识、阶段和摘要，不回传原稿全文与历史归档。

正式状态仍由 ProjectStore 完整保存；工具结果改用本视图，避免每次状态查询把整份原稿、
全部批次正文和归档副本塞回上下文。需要某一批的全文时按 batch_id 单独取。
"""

from __future__ import annotations


def _clip(text, limit):
    text = text if isinstance(text, str) else ""
    return text if len(text) <= limit else text[:limit] + f"……（共 {len(text)} 字，已截断）"


def _batch(batch, *, full=False):
    row = {key: batch.get(key) for key in ("id", "kind", "episodes", "status", "final", "content_hash",
                                           "generation_revision", "review_id", "at")}
    row["characters"] = len(batch.get("content") or "")
    row["continuity"] = batch.get("continuity") or {}
    if batch.get("quality_check"):
        row["quality_check"] = {"status": batch["quality_check"].get("status")}
    row["previous_versions"] = len(batch.get("previous_versions") or [])
    if full:
        row["content"] = batch.get("content", "")
        for key in ("character_rows", "episode_rows"):
            if batch.get(key):
                row[key] = batch[key]
    return row


def project_view(project, *, batch_id=None):
    if not isinstance(project, dict):
        return project
    source = project.get("source") or {}
    core = project.get("core") or {}
    plan = project.get("plan") or {}
    view = {key: project.get(key) for key in ("id", "title", "mode", "agent_id", "stage", "region", "language", "revision",
                                              "generation_revision", "outline_batch_size", "script_batch_size", "updated_at")}
    view["request"] = _clip(project.get("request"), 600)
    view["source"] = ({"name": source.get("name"), "path": source.get("path"), "content_hash": source.get("content_hash"),
                       "characters": len(source.get("content") or "")} if source else {})
    view["core"] = {"content": core.get("content", ""), "unresolved_conflict": bool(core.get("unresolved_conflict")),
                    "confirmed": bool(core.get("approval"))}
    view["candidates"] = [{"id": item.get("id"), "title": item.get("title"), "content": _clip(item.get("content"), 800)}
                          for item in project.get("candidates") or []]
    view["plan"] = {"id": plan.get("id"), "content": _clip(plan.get("content"), 2000), "selected": bool(plan.get("selection"))}
    for kind in ("outline_batches", "script_batches"):
        view[kind] = [_batch(batch, full=batch.get("id") == batch_id) for batch in project.get(kind) or []]
    view["reviews"] = [{"id": item.get("id"), "batch_id": item.get("batch_id"), "verdict": item.get("verdict"),
                        "issues": (item.get("issues") or [])[:10], "generation_revision": item.get("generation_revision")}
                       for item in (project.get("reviews") or [])[-5:]]
    view["reviews_total"] = len(project.get("reviews") or [])
    view["exports"] = [{key: item.get(key) for key in ("kind", "format", "name", "path", "content_verified", "artifact_id")}
                       for item in project.get("exports") or []]
    view["archives_total"] = len(project.get("archives") or [])
    if "guards" in project:
        view["guards"] = project["guards"]
    if batch_id == "source" and source:
        view["source"]["content"] = source.get("content", "")
    view["view"] = ("精简视图：原稿全文、批次正文和历史归档不随状态返回。需要某批全文时调用 drama_project_status 并传 batch_id；"
                    "原稿可用 drama_material_import 按路径分页读取。")
    return view

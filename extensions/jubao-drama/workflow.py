"""剧本项目的正式状态、版本确认与批次验收。"""

from __future__ import annotations

import copy
import importlib.util
import json
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from plugins.plugin_storage import plugin_data_dir, plugin_db


_spec = importlib.util.spec_from_file_location(
    "jubao_drama_original_guards", Path(__file__).parent / "vendor/drama-agent-v3/runtime/guards.py"
)
_guards = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_guards)
content_hash = _guards.content_hash
check_task = _guards.check_task

MODES = {"full", "analysis", "outline", "review", "export"}
_GATES = {"core": "core", "plan": "plan", "H1": "core", "H2": "plan"}
_STATE_FIELDS = ("source", "core", "candidates", "plans_digest", "plan", "outline_batches",
                 "script_batches", "reviews", "exports")


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _now():
    return datetime.now(timezone.utc).isoformat()


def _text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label}不能为空")
    return value.strip()


def _gate_name(gate):
    if gate not in _GATES:
        raise ValueError("未知确认节点")
    return _GATES[gate]


def _require_gate(project, task):
    result = check_task(task, project)
    if not result["allowed"]:
        raise ValueError("；".join(result["blockers"]))


def _empty_core():
    return {"content": "", "unresolved_conflict": False, "approval": None}


def _empty_plan():
    return {"content": "", "core_hash": None, "selection": None}


def _archive(project, reason):
    project["archives"].append({
        **{key: copy.deepcopy(project[key]) for key in _STATE_FIELDS},
        "generation_revision": project["generation_revision"], "reason": reason, "at": _now(),
    })
    project["generation_revision"] += 1


def _clear_downstream(project):
    for key in ("outline_batches", "script_batches", "reviews", "exports"):
        project[key] = []


def _source(data):
    if not isinstance(data, dict):
        raise ValueError("原稿资料必须是对象")
    result = {key: copy.deepcopy(data[key]) for key in ("name", "path", "content", "materials") if key in data}
    result["content"] = _text(result.get("content"), "原稿全文")
    result["id"] = "source"
    result["content_hash"] = content_hash(result["content"])
    result["writer_session_id"] = "user-source"
    return result


class ProjectStore:
    """连接只属于本次事务，目录由当前配置的作用域动态解析。"""

    def __init__(self, agent_id="oa6-1"):
        self.agent_id = agent_id

    def _assert_agent(self, project):
        # 旧 OA6.1 项目没有该字段，按原 Agent 归档；其它 Agent 永远不能读到它。
        if project.get("agent_id", "oa6-1") != self.agent_id:
            raise ValueError("当前剧本 Agent 无权访问这个项目")
        return project

    @contextmanager
    def transaction(self):
        conn = plugin_db("jubao-drama")
        try:
            conn.execute("CREATE TABLE IF NOT EXISTS drama_projects "
                         "(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL)")
            conn.commit()
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def data_dir(self):
        return plugin_data_dir("jubao-drama")

    def get(self, project_id, conn=None):
        if conn is None:
            with self.transaction() as connection:
                return self.get(project_id, connection)
        row = conn.execute("SELECT data FROM drama_projects WHERE id = ?", (project_id,)).fetchone()
        if row is None:
            raise ValueError("当前配置中没有这个剧本项目")
        return self._assert_agent(json.loads(row[0]))

    def save(self, project, conn):
        if not conn.in_transaction:
            raise ValueError("正式状态只能在事务内保存")
        previous = conn.execute("SELECT revision FROM drama_projects WHERE id = ?", (project["id"],)).fetchone()
        revision = project.get("revision", 0)
        if (previous and previous[0] != revision) or (previous is None and revision != 0):
            raise ValueError("项目版本已经变化，请重新读取后再保存")
        updated = copy.deepcopy(project)
        updated.update(revision=revision + 1, updated_at=_now())
        conn.execute("INSERT INTO drama_projects(id, revision, data) VALUES (?, ?, ?) "
                     "ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, data=excluded.data",
                     (updated["id"], updated["revision"], _json(updated)))
        project.update(updated)
        return project

    def create(self, title, mode="full", region="中国", language="chinese", request="", source=None,
               outline_batch_size=4, script_batch_size=2, *, conn=None):
        if conn is None:
            with self.transaction() as connection:
                return self.create(title, mode, region, language, request, source,
                                   outline_batch_size, script_batch_size, conn=connection)
        language = "chinese" if language == "zh-CN" else language
        if mode not in MODES or region not in {"中国", "欧美"} or language not in {"bilingual", "chinese"}:
            raise ValueError("请使用有效的剧本模式、地区和台词语言")
        if any(type(size) is not int or size < 1 for size in (outline_batch_size, script_batch_size)):
            raise ValueError("每批集数必须是正整数")
        project = {
            "id": uuid4().hex, "title": _text(title, "项目名"), "mode": mode,
            "agent_id": self.agent_id,
            "region": region, "language": language, "request": str(request), "revision": 0,
            "generation_revision": 1, "stage": {"review": "M4", "export": "M5"}.get(mode, "M1"),
            "source": _source(source) if source else {}, "core": _empty_core(), "candidates": [],
            "plans_digest": "", "plan": _empty_plan(), "outline_batches": [], "script_batches": [],
            "reviews": [], "exports": [], "archives": [], "created_at": _now(),
            "outline_batch_size": outline_batch_size, "script_batch_size": script_batch_size,
        }
        return self.save(project, conn)

    def list(self):
        with self.transaction() as conn:
            projects = [json.loads(row[0]) for row in conn.execute("SELECT data FROM drama_projects ORDER BY rowid DESC")]
            projects = [project for project in projects if project.get("agent_id", "oa6-1") == self.agent_id]
        return [{key: project[key] for key in ("id", "title", "mode", "stage", "revision", "updated_at")}
                for project in projects]

    def status(self, project_id):
        project = self.get(project_id)
        project["guards"] = {task: check_task(task, project) for task in
                             ("analysis", "candidates", "outline", "script", "review", "export")}
        return project

    def gate_target(self, project_id, gate, plan_id="", conn=None):
        project = self.get(project_id, conn)
        gate = _gate_name(gate)
        core_hash = content_hash(_text(project["core"].get("content"), "核心期待"))
        if project["core"].get("unresolved_conflict"):
            raise ValueError("核心期待存在未解决的冲突，请先明确取舍")
        content = project["core"]["content"]
        if gate == "plan":
            _require_gate(project, "candidates")
            candidate = next((item for item in project["candidates"] if item["id"] == plan_id), None)
            if candidate is None:
                raise ValueError("当前候选中没有这个总体方案")
            content = candidate["content"]
        return {"content": content, "content_hash": content_hash(content), "core_hash": core_hash,
                "generation_revision": project["generation_revision"], "summary": content}

    def apply_approval(self, project_id, gate, target, receipt, plan_id="", conn=None):
        if conn is None:
            with self.transaction() as connection:
                return self.apply_approval(project_id, gate, target, receipt, plan_id, connection)
        gate = _gate_name(gate)
        current = self.gate_target(project_id, gate, plan_id, conn)
        if any(target.get(key) != current[key] for key in ("content_hash", "core_hash", "generation_revision")):
            raise ValueError("确认目标已变化，请重新展示当前版本")
        for key in ("evidence", "challenge_id", "session_id"):
            _text(receipt.get(key), "可信确认回执的 " + key)
        project = self.get(project_id, conn)
        approval = {"kind": "human_confirmation" if gate == "core" else "human_selection",
                    "content_hash": current["content_hash"], "evidence": receipt["evidence"],
                    "receipt": copy.deepcopy(receipt), "at": _now()}
        if gate == "core":
            was_confirmed = bool(project["core"].get("approval"))
            project["core"]["approval"] = approval
            if not was_confirmed:
                project["stage"] = "END" if project["mode"] == "analysis" else "M2A"
        else:
            changed = project["plan"]["content"] != current["content"]
            if project["plan"]["content"] and changed:
                _archive(project, "用户重新选择总体方向")
                _clear_downstream(project)
            project["plan"] = {"id": plan_id, "content": current["content"],
                               "core_hash": current["core_hash"], "selection": approval}
            if changed:
                project["stage"] = "M2B"
        return self.save(project, conn)

    def submit(self, project_id, kind, data, writer_session_id, *, trusted_receipt=None, conn=None):
        if conn is None:
            with self.transaction() as connection:
                return self.submit(project_id, kind, data, writer_session_id,
                                   trusted_receipt=trusted_receipt, conn=connection)
        if not isinstance(data, dict) or any(key in data for key in ("approved", "approval", "selection")):
            raise ValueError("提交内容不能设置人工确认或审核通过状态")
        _text(writer_session_id, "写作会话")
        project = self.get(project_id, conn)
        handlers = {
            "source": self._submit_source, "core": self._submit_core,
            "candidates": self._submit_candidates, "outline_batch": self._submit_outline,
            "script_batch": self._submit_script, "accept_batch": self._accept_batch,
            "restart": self._restart,
        }
        if kind == "review":
            self._submit_review(project, data, writer_session_id, trusted_receipt)
        elif kind in handlers:
            handlers[kind](project, data, writer_session_id)
        else:
            raise ValueError("未知剧本提交操作")
        return self.save(project, conn)

    def _submit_source(self, project, data, writer):
        source = _source(data)
        if source == project["source"]:
            return
        _archive(project, "原始资料更新")
        project.update(source=source, core=_empty_core(), candidates=[], plans_digest="", plan=_empty_plan())
        _clear_downstream(project)
        project["stage"] = {"review": "M4", "export": "M5"}.get(project["mode"], "M1")

    def _submit_core(self, project, data, writer):
        if project["mode"] in {"review", "export"}:
            raise ValueError("仅审核或导出不能扩大为改编任务")
        _text(project["source"].get("content"), "原稿全文")
        content = _text(data.get("content"), "核心期待")
        if (content == project["core"]["content"] and
                bool(data.get("unresolved_conflict")) == project["core"]["unresolved_conflict"]):
            return
        _archive(project, "核心期待更新")
        project.update(core={"content": content, "unresolved_conflict": bool(data.get("unresolved_conflict")),
                             "approval": None}, candidates=[], plans_digest="", plan=_empty_plan())
        _clear_downstream(project)
        project["stage"] = "END" if project["mode"] == "analysis" else "H1"

    def _submit_candidates(self, project, data, writer):
        if project["mode"] not in {"full", "outline"}:
            raise ValueError("本次模式不包含总体改编方案")
        _require_gate(project, "candidates")
        items = data.get("items")
        if not isinstance(items, list) or not items:
            raise ValueError("请先提供可供用户选择的方案")
        candidates = [{"id": _text(item.get("id"), "方案编号"),
                       "content": _text(item.get("content"), "方案内容"),
                       "title": str(item.get("title", ""))} for item in items]
        if len({item["id"] for item in candidates}) != len(candidates):
            raise ValueError("候选方案编号不能重复")
        digest = content_hash(_json(candidates))
        if digest == project["plans_digest"]:
            return
        _archive(project, "总体候选更新")
        project.update(candidates=candidates, plans_digest=digest, plan=_empty_plan(), stage="H2")
        _clear_downstream(project)

    def _submit_outline(self, project, data, writer):
        if project["mode"] not in {"full", "outline"}:
            raise ValueError("本次模式不包含新纲创作")
        fields = {"character_rows": ("original", "new"),
                  "episode_rows": ("original_episodes", "original_outline", "new_episodes", "new_outline")}
        for name, required in fields.items():
            rows = data.get(name)
            if not isinstance(rows, list) or not rows:
                raise ValueError(f"{name} 必须是非空对照数组，字段为 {', '.join(required)}")
            for index, row in enumerate(rows, 1):
                if not isinstance(row, dict) or set(row) != set(required):
                    raise ValueError(f"{name} 第 {index} 行只接受字段 {', '.join(required)}，字段名不能翻译为中文")
                for key in required:
                    _text(row[key], f"{name} 第 {index} 行的 {key}")
                if name == "episode_rows" and any(len(row[key]) > 200 for key in ("original_episodes", "new_episodes")):
                    raise ValueError("episode_rows 集数标签最多 200 个字符")
        self._submit_batch(project, "outline", data, writer)

    def _submit_script(self, project, data, writer):
        if project["mode"] != "full":
            raise ValueError("本次模式不包含正文创作")
        outlines = project["outline_batches"]
        if not outlines or not outlines[-1]["final"] or any(batch["status"] != "accepted" for batch in outlines):
            raise ValueError("先完成新纲的独立审稿和正式验收")
        covered = {episode for batch in outlines for episode in batch["episodes"]}
        if not set(data.get("episodes", [])).issubset(covered):
            raise ValueError("正文集数必须已有正式新纲")
        if not any(item.get("format") == "xlsx" and item.get("content_verified") for item in project["exports"]):
            raise ValueError("先交付已回读核对的新纲对照 Excel")
        self._submit_batch(project, "script", data, writer)
        scripts = project["script_batches"]
        if scripts[0]["episodes"][0] != outlines[0]["episodes"][0]:
            raise ValueError("正文必须从正式新纲的起始集接续，不能跳过前面的集数")
        if scripts[-1]["final"] and {episode for batch in scripts for episode in batch["episodes"]} != covered:
            raise ValueError("最终正文批次必须覆盖全部正式新纲集数，不能提前宣告完成")

    def _submit_batch(self, project, kind, data, writer):
        _require_gate(project, kind)
        episodes = data.get("episodes")
        if (not isinstance(episodes, list) or not episodes or
                any(type(value) is not int or value < 1 for value in episodes) or
                episodes != list(range(episodes[0], episodes[-1] + 1))):
            raise ValueError("批次集数必须是连续且不重复的正整数")
        if len(episodes) > project[kind + "_batch_size"]:
            raise ValueError("本批超出项目设定的批次集数，请按已指定批量拆分")
        batches = project[kind + "_batches"]
        batch_id = data.get("id") or uuid4().hex
        existing = next((batch for batch in batches if batch["id"] == batch_id), None)
        if existing and (existing is not batches[-1] or existing["status"] == "accepted"):
            raise ValueError("已验收或已有下游的稿件不能直接覆盖，请先重做并保留旧版本")
        preceding = batches[:-1] if existing else batches
        if preceding and (preceding[-1]["status"] != "accepted" or preceding[-1]["final"]):
            raise ValueError("必须先验收前批，且不能越过已声明的最终批次")
        if preceding and episodes[0] != preceding[-1]["episodes"][-1] + 1:
            raise ValueError("后批必须接续已验收前批的下一集")
        substance = {"content": _text(data.get("content"), "批次正文"), "episodes": episodes,
                     "continuity": copy.deepcopy(data.get("continuity", {})), "final": bool(data.get("final")),
                     "character_rows": copy.deepcopy(data.get("character_rows", [])),
                     "episode_rows": copy.deepcopy(data.get("episode_rows", []))}
        batch = {**substance, "id": batch_id, "kind": kind, "status": "draft", "writer_session_id": writer,
                 "content_hash": content_hash(_json(substance)), "at": _now(),
                 "generation_revision": project["generation_revision"], "previous_versions": []}
        if existing:
            batch["previous_versions"] = existing.get("previous_versions", []) + [
                {key: value for key, value in existing.items() if key != "previous_versions"}]
            batches[-1] = batch
        else:
            batches.append(batch)
        project["stage"] = "M4"

    def _find_batch(self, project, batch_id):
        if batch_id == "source" and project["mode"] == "review" and project["source"]:
            return project["source"]
        for batch in project["outline_batches"] + project["script_batches"]:
            if batch["id"] == batch_id:
                return batch
        raise ValueError("没有找到当前稿件批次")

    def _submit_review(self, project, data, writer, receipt):
        batch = self._find_batch(project, data.get("batch_id"))
        if not isinstance(receipt, dict) or receipt.get("source") != "plugin_llm":
            raise ValueError("审核必须提供后端独立调用的真实回执")
        if (receipt.get("project_revision") != project["revision"] or
                receipt.get("generation_revision") != project["generation_revision"]):
            raise ValueError("独立审稿期间项目或创作依据版本已变化，请重新审核当前版本")
        reviewer = _text(receipt.get("reviewer_session_id"), "独立审稿会话")
        _text(receipt.get("request_id"), "独立审核调用编号")
        if reviewer == batch["writer_session_id"]:
            raise ValueError("本批起草者不能作为独立审稿者")
        report = _text(data.get("report"), "审核报告")
        if receipt.get("artifact_hash") != batch["content_hash"] or receipt.get("review_hash") != content_hash(report):
            raise ValueError("审核回执与当前稿件或报告不一致")
        if data.get("verdict") not in {"pass", "revise", "block"} or not isinstance(data.get("issues"), list):
            raise ValueError("审核报告需要明确结论和问题清单")
        if data["verdict"] == "pass" and data["issues"]:
            raise ValueError("仍有待解决问题的稿件不能通过审核")
        review = {"id": uuid4().hex, "batch_id": batch["id"], "verdict": data["verdict"],
                  "report": report, "issues": copy.deepcopy(data["issues"]), "receipt": copy.deepcopy(receipt),
                  "artifact_hash": batch["content_hash"], "generation_revision": project["generation_revision"], "at": _now()}
        project["reviews"].append(review)
        if batch["id"] != "source":
            batch["status"] = "reviewed" if data["verdict"] == "pass" else "revision_requested"
        else:
            project["stage"] = "END"

    def _accept_batch(self, project, data, writer):
        batch = self._find_batch(project, data.get("batch_id"))
        if batch["id"] == "source":
            raise ValueError("仅审核原稿不能标记为改写稿验收")
        _require_gate(project, batch["kind"])
        review = next((item for item in reversed(project["reviews"]) if item["batch_id"] == batch["id"]), None)
        if (not review or review["id"] != data.get("review_id") or review["verdict"] != "pass" or
                batch["status"] != "reviewed" or
                review["artifact_hash"] != batch["content_hash"] or
                review["generation_revision"] != project["generation_revision"]):
            raise ValueError("正式验收需要与当前稿件一致且通过的独立审稿记录")
        batch.update(status="accepted", accepted_by=writer, accepted_at=_now(), review_id=review["id"])
        project["stage"] = "M5" if batch["final"] else {"outline": "M2B", "script": "M3"}[batch["kind"]]

    def _restart(self, project, data, writer):
        stages = {"M1": None, "M2A": "candidates", "M2B": "outline", "M3": "script"}
        stage = data.get("stage")
        if set(data) != {"stage", "reason"} or not isinstance(stage, str) or stage not in stages:
            raise ValueError("重做必须明确提供 stage 和 reason；stage 仅接受 M1、M2A、M2B、M3，不接受 scope 等未知字段")
        if stage != "M1":
            modes = {"M2A": {"full", "outline"}, "M2B": {"full", "outline"}, "M3": {"full"}}
            if project["mode"] not in modes[stage]:
                raise ValueError("重做阶段不能扩大当前任务模式")
            _require_gate(project, stages[stage])
        if stage == "M3":
            outlines = project["outline_batches"]
            if (not outlines or not outlines[-1]["final"] or any(batch["status"] != "accepted" for batch in outlines)
                    or not any(item.get("format") == "xlsx" and item.get("content_verified") for item in project["exports"])):
                raise ValueError("重做正文前必须已有全部验收并导出的新纲")
        _archive(project, _text(data.get("reason"), "重做原因"))
        if stage == "M3":
            outline_ids = {batch["id"] for batch in project["outline_batches"]}
            project["script_batches"] = []
            project["reviews"] = [item for item in project["reviews"] if item["batch_id"] in outline_ids]
            project["exports"] = [item for item in project["exports"] if item.get("kind") == "outline"]
        else:
            if stage in {"M1", "M2A"}:
                project.update(candidates=[], plans_digest="", plan=_empty_plan())
            if stage == "M1":
                project["core"] = _empty_core()
            _clear_downstream(project)
        project["stage"] = {"review": "M4", "export": "M5"}.get(project["mode"], stage)

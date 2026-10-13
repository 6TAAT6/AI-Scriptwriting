"""Run from the package root: python3 -m unittest discover -s tests -v."""

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
from guards import check_task, content_hash


def confirmed_state():
    core = "观众等待受冤者证明清白，让迫害者付出代价。"
    plan = "现代家族故事；以不同证据和冲突机制实现同一期待。"
    return {
        "core": {
            "content": core,
            "approval": {
                "kind": "human_confirmation",
                "content_hash": content_hash(core),
                "evidence": "用户确认：沿用这份核心期待。",
            },
        },
        "plan": {
            "content": plan,
            "core_hash": content_hash(core),
            "selection": {
                "kind": "human_selection",
                "content_hash": content_hash(plan),
                "evidence": "用户选择当前方案。",
            },
        },
    }


class ConfirmationGuardTests(unittest.TestCase):
    def test_analysis_can_read_without_confirmation(self):
        self.assertTrue(check_task("analysis", {})["allowed"])

    def test_candidates_need_core_but_not_plan(self):
        self.assertFalse(check_task("candidates", {})["allowed"])
        state = confirmed_state()
        del state["plan"]
        self.assertTrue(check_task("candidates", state)["allowed"])

    def test_outline_and_script_require_selected_plan(self):
        state = confirmed_state()
        del state["plan"]["selection"]
        for task in ("outline", "script"):
            self.assertFalse(check_task(task, state)["allowed"])

    def test_confirmed_project_continues_without_batch_approval(self):
        for task in ("outline", "script"):
            self.assertTrue(check_task(task, confirmed_state())["allowed"])

    def test_user_provided_core_needs_no_repeated_confirmation(self):
        state = confirmed_state()
        state["core"]["approval"]["kind"] = "user_provided"
        self.assertTrue(check_task("outline", state)["allowed"])

    def test_unresolved_core_conflict_blocks_creation(self):
        state = confirmed_state()
        state["core"]["unresolved_conflict"] = True
        self.assertFalse(check_task("candidates", state)["allowed"])

    def test_review_pass_does_not_confirm_core(self):
        state = confirmed_state()
        state["core"]["approval"]["kind"] = "review_passed"
        state["review"] = {"passed": True}
        self.assertFalse(check_task("script", state)["allowed"])

    def test_unconfirmed_core_is_not_bypassed_by_auto_selection(self):
        state = confirmed_state()
        del state["core"]["approval"]
        state["plan"]["selection"].update({
            "kind": "authorized_auto_selection",
            "authorization": {"scope": "plan_selection", "evidence": "用户明确授权代选。"},
        })
        self.assertFalse(check_task("outline", state)["allowed"])

    def test_auto_selection_requires_specific_authorization(self):
        state = confirmed_state()
        selection = state["plan"]["selection"]
        selection["kind"] = "authorized_auto_selection"
        self.assertFalse(check_task("script", state)["allowed"])
        selection["authorization"] = {"scope": "plan_selection", "evidence": "请替我选方案。"}
        self.assertTrue(check_task("script", state)["allowed"])

    def test_core_change_invalidates_approval(self):
        state = confirmed_state()
        state["core"]["content"] = "观众等待失散家人重新团聚。"
        self.assertFalse(check_task("candidates", state)["allowed"])

    def test_reconfirmed_core_still_invalidates_old_plan(self):
        state = confirmed_state()
        state["core"]["content"] = "观众等待失散家人重新团聚。"
        state["core"]["approval"]["content_hash"] = content_hash(state["core"]["content"])
        self.assertTrue(check_task("candidates", state)["allowed"])
        self.assertFalse(check_task("outline", state)["allowed"])

    def test_changed_plan_invalidates_old_selection(self):
        state = confirmed_state()
        state["plan"]["content"] = "另外一套关键关系与世界方向。"
        self.assertFalse(check_task("script", state)["allowed"])

    def test_more_candidates_recommendation_and_preselection_are_not_selection(self):
        for kind in ("more_candidates", "recommended", "preselected"):
            state = confirmed_state()
            state["plan"]["selection"]["kind"] = kind
            self.assertFalse(check_task("outline", state)["allowed"])
            self.assertTrue(check_task("candidates", state)["allowed"])

    def test_pure_review_and_export_do_not_require_creation_gates(self):
        for task in ("review", "export"):
            result = check_task(task, {})
            self.assertTrue(result["allowed"])
            self.assertTrue(any("不能" in note for note in result["notes"]))

    def test_review_or_export_with_rewrite_requires_creation_gates(self):
        for task in ("review", "export"):
            self.assertFalse(check_task(task, {}, rewrites=True)["allowed"])
            self.assertTrue(check_task(task, confirmed_state(), rewrites=True)["allowed"])

    def test_missing_or_empty_evidence_is_not_confirmation(self):
        state = confirmed_state()
        state["core"]["approval"]["evidence"] = " "
        self.assertFalse(check_task("candidates", state)["allowed"])

    def test_guard_does_not_mutate_state_or_invent_gender_changes(self):
        state = confirmed_state()
        original = copy.deepcopy(state)
        self.assertTrue(check_task("script", state)["allowed"])
        self.assertEqual(state, original)
        self.assertNotIn("gender_change", state)

    def test_hash_normalizes_platform_line_endings_only(self):
        self.assertEqual(content_hash("  第一行\r\n第二行\n"), content_hash("第一行\n第二行"))
        self.assertNotEqual(content_hash("核心期待甲"), content_hash("核心期待乙"))

    def test_explicit_core_confirmation_waiver_is_respected(self):
        state = confirmed_state()
        state["core"]["approval"].update({
            "kind": "explicit_waiver",
            "scope": "core_confirmation",
            "evidence": "用户明确要求本次核心期待直接沿用提炼结果，免除等待确认。",
        })
        self.assertTrue(check_task("outline", state)["allowed"])

    def test_waiver_is_bound_to_core_and_cannot_be_plan_authorization(self):
        state = confirmed_state()
        approval = state["core"]["approval"]
        approval.update({"kind": "explicit_waiver", "scope": "plan_selection"})
        self.assertFalse(check_task("outline", state)["allowed"])
        approval["scope"] = "core_confirmation"
        state["core"]["content"] = "另一项未经覆盖的新核心期待。"
        self.assertFalse(check_task("candidates", state)["allowed"])

    def test_malformed_approval_is_blocked(self):
        state = confirmed_state()
        state["core"]["approval"] = "confirmed"
        self.assertFalse(check_task("script", state)["allowed"])

    def test_malformed_json_record_kinds_are_blocked(self):
        state = confirmed_state()
        state["core"]["approval"]["kind"] = ["human_confirmation"]
        state["plan"]["selection"]["kind"] = {"selected": True}
        self.assertFalse(check_task("script", state)["allowed"])


if __name__ == "__main__":
    unittest.main()

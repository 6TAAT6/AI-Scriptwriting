"""保持流式工具调用身份稳定，兼容复用原始索引的网关。"""
from __future__ import annotations

import json


def _complete_arguments(value: str) -> bool:
    try:
        return isinstance(json.loads(value), (dict, list))
    except (TypeError, ValueError):
        return False


class ToolCallAccumulator:
    """原始索引只作路由键；输出槽位独立分配，显式 ID 可恢复交错调用。"""

    def __init__(self):
        self.acc: dict = {}
        self._notified: set[int] = set()
        self._active_slot_by_idx: dict = {}
        self._slot_by_id: dict[str, int] = {}
        self._implicit_slots: set[int] = set()
        self._argument_parts: dict[int, list[str]] = {}

    def _new_slot(self, raw_idx, *, name="") -> int:
        slot = len(self.acc)
        self.acc[slot] = {
            "id": "", "type": "function",
            "function": {"name": name, "arguments": ""}, "extra_content": None,
        }
        self._argument_parts[slot] = []
        self._active_slot_by_idx[raw_idx] = slot
        return slot

    def materialize(self) -> dict:
        for slot, parts in self._argument_parts.items():
            self.acc[slot]["function"]["arguments"] = "".join(parts)
        return self.acc

    def feed(self, tc_delta) -> str | None:
        raw_idx = getattr(tc_delta, "index", None)
        if raw_idx is None:
            raw_idx = 0
        value = getattr(tc_delta, "id", None)
        call_id = str(value) if value is not None else ""
        function = getattr(tc_delta, "function", None)
        name = getattr(function, "name", None) or ""
        slot = self._active_slot_by_idx.get(raw_idx)
        if call_id in self._slot_by_id:
            slot = self._slot_by_id[call_id]
        elif slot is None or (call_id and (
            self.acc[slot]["id"] or slot in self._implicit_slots
            or name and self.acc[slot]["function"]["name"] not in {"", name}
        )):
            slot = self._new_slot(raw_idx)
        self._active_slot_by_idx[raw_idx] = slot
        entry = self.acc[slot]
        if call_id:
            entry["id"] = call_id
            self._slot_by_id[call_id] = slot

        arguments = getattr(function, "arguments", None) or ""
        parts = self._argument_parts[slot]
        accumulated = "".join(parts)
        previous_name = entry["function"]["name"]

        if name and previous_name and name != previous_name:
            # 明确的新名称只能在旧调用完成且没有显式 ID 冲突时开启新调用。
            if not call_id and _complete_arguments(accumulated):
                slot = self._new_slot(raw_idx, name=name)
                entry = self.acc[slot]
                parts = self._argument_parts[slot]
                accumulated = ""
            else:
                raise ValueError("流式工具调用的名称与已有调用身份冲突")

        if arguments and accumulated:
            if arguments.startswith(accumulated):
                # 同一个调用的累计全文或完整重发，不重复追加已经收到的前缀。
                arguments = arguments[len(accumulated):]
            elif _complete_arguments(accumulated) and arguments.lstrip().startswith(("{", "[")):
                if call_id or not _complete_arguments(arguments):
                    raise ValueError("流式工具调用在已完成参数后收到冲突或不完整的新参数")
                # 同一原始索引的完整独立 JSON 才能开启同名调用；新 ID 不能借用。
                slot = self._new_slot(raw_idx, name=name or previous_name)
                self._implicit_slots.add(slot)
                entry = self.acc[slot]
                parts = self._argument_parts[slot]
        if name:
            entry["function"]["name"] = name
        if arguments:
            parts.append(arguments)

        extra = getattr(tc_delta, "extra_content", None)
        if extra is None and hasattr(tc_delta, "model_extra"):
            extra = (tc_delta.model_extra if isinstance(tc_delta.model_extra, dict) else {}).get("extra_content")
        if extra is not None:
            from agent.chat_completion_helpers import _dump_if_model
            entry["extra_content"] = _dump_if_model(extra)
        name = entry["function"]["name"]
        if name and slot not in self._notified:
            self._notified.add(slot)
            return name
        return None

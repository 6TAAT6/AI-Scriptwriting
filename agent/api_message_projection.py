"""在传输规范化之前投影 API 副本，保持原记录与系统提示不变。"""
import logging

logger = logging.getLogger(__name__)
_projection_failures = 0


def projection_failure_count() -> int:
    return _projection_failures


def _record_projection_failure(reason: str) -> None:
    global _projection_failures
    _projection_failures += 1
    logger.warning("API message projection fallback #%d: %s", _projection_failures, reason)


def project_api_messages(messages, source_messages, *, session_id, platform, current_turn_index):
    from hermes_cli.lifecycle import has_hook, invoke_hook

    if not has_hook("transform_api_messages"):
        return messages
    # 分派器为这个变换钩子逐回调隔离参数并快照返回，无须再次复制长历史。
    try:
        results = invoke_hook(
            "transform_api_messages", messages=messages,
            source_messages=source_messages, session_id=session_id,
            platform=platform, current_turn_index=current_turn_index,
        )
    except Exception as exc:  # defensive boundary for third-party dispatchers
        _record_projection_failure(f"hook raised {type(exc).__name__}")
        return messages
    envelopes = [{key: value for key, value in row.items() if key != "content"} for row in messages]
    for result in results:
        if not isinstance(result, dict) or "messages" not in result:
            continue
        proposed = result["messages"]
        valid = isinstance(proposed, list) and len(proposed) == len(messages)
        if valid:
            valid = all(
                isinstance(row, dict)
                and {key: value for key, value in row.items() if key != "content"} == envelope
                and (row.get("content") is None or isinstance(row["content"], (str, list)))
                for row, envelope in zip(proposed, envelopes)
            )
        if valid:
            return proposed
        _record_projection_failure("callback changed message count or non-content envelope")
    return messages

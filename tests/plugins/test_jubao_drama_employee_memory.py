"""员工原生历史工具只查询当前账号，不接受模型改写资料库归属。"""

from contextlib import ExitStack, closing
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.plugins.test_jubao_drama_security import runtime as runtime, scope


@pytest.mark.parametrize("runtime", [True], indirect=True)
def test_employee_inline_history_stays_in_current_account(runtime, monkeypatch):
    """真实中间件与 inline 执行器在 A→B→A 切换时拒绝全局其他 profile。"""
    from agent.inline_tool_executors import INLINE_TOOL_EXECUTORS, InlineToolContext
    from hermes_cli.middleware import run_tool_execution_middleware
    from hermes_cli.profiles import get_profile_dir
    from hermes_state import SessionDB

    homes, _ = runtime
    global_home = Path.home() / ".hermes"
    monkeypatch.setenv("HERMES_HOME", str(global_home))
    foreign = global_home / "profiles" / "foreign"
    foreign.mkdir(parents=True)
    assert get_profile_dir("foreign") == foreign
    canaries = {homes[0]: "account-a-history", homes[1]: "account-b-history", foreign: "foreign-private-history"}

    with ExitStack() as stack:
        databases = {}
        for home, canary in canaries.items():
            database = stack.enter_context(closing(SessionDB(home / "state.db")))
            database.create_session("stored-history", source="cli")
            database.append_message("stored-history", role="user", content="ownershipneedle " + canary)
            databases[home] = database

        for home in (homes[0], homes[1], homes[0]):
            with scope(home):
                agent = SimpleNamespace(session_id="employee-current", _get_session_db_for_recall=lambda: databases[home])
                context = InlineToolContext(effective_task_id="employee-history")

                def search(args):
                    return json.loads(run_tool_execution_middleware(
                        "session_search", args,
                        lambda payload: INLINE_TOOL_EXECUTORS["session_search"](agent, payload, context),
                        session_id=agent.session_id, turn_id="history-turn", tool_call_id="history-call",
                    ))

                for args in (
                    {"query": "ownershipneedle", "profile": "foreign"},
                    {"session_id": "stored-history", "profile": "foreign"},
                    {"session_id": "foreign/stored-history"},
                    {"session_id": "foreign\\stored-history"},
                    {"session_id": 123},
                    {"session_id": []},
                ):
                    blocked = search(args)
                    assert canaries[foreign] not in json.dumps(blocked)
                    assert blocked.get("error"), blocked
                    assert blocked.get("retryable") is False, blocked
                    assert str(global_home) not in json.dumps(blocked)

                for args in (
                    {"query": "ownershipneedle"},
                    {"query": "ownershipneedle", "profile": ""},
                    {"query": "ownershipneedle", "profile": None, "session_id": None},
                    {"session_id": "stored-history"},
                ):
                    found = search(args)
                    assert found.get("success"), found
                    serialized = json.dumps(found)
                    assert canaries[home] in serialized
                    assert all(marker not in serialized for owner, marker in canaries.items() if owner != home)

                # 独立 Worker 的本账号链接包含 default 前缀，回读不能因此被误拦。
                with monkeypatch.context() as worker_env:
                    worker_env.setenv("HERMES_HOME", str(home))
                    current = search({"session_id": "stored-history"})
                    reference = current["link"].removeprefix("@session:")
                    profile, separator, identifier = reference.partition("/")
                    assert separator, current
                    for args in ({"session_id": reference}, {"profile": profile, "session_id": identifier},
                                 {"profile": profile, "query": "ownershipneedle"}):
                        reread = search(args)
                        assert reread.get("success"), reread
                        assert canaries[home] in json.dumps(reread)

                # multiplex 中 default 可能是启动账号，不能把字符串本身视为授权。
                if home != homes[0]:
                    with monkeypatch.context() as worker_env:
                        worker_env.setenv("HERMES_HOME", str(homes[0]))
                        for args in ({"profile": "default", "session_id": "stored-history"},
                                     {"session_id": "default/stored-history"}):
                            blocked = search(args)
                            assert blocked.get("error") and blocked.get("retryable") is False, blocked
                            assert canaries[homes[0]] not in json.dumps(blocked)


@pytest.mark.parametrize("runtime", [True], indirect=True)
def test_employee_context_tools_reach_native_executors(runtime):
    """业务白名单放行后，员工的两个上下文工具必须走到真实 profile 执行器。"""
    from agent.inline_tool_executors import INLINE_TOOL_EXECUTORS, InlineToolContext
    from hermes_cli.middleware import run_tool_execution_middleware
    from hermes_state import SessionDB
    from tools.memory_tool import MemoryStore

    homes, _ = runtime
    for index, home in enumerate((homes[0], homes[1], homes[0])):
        with scope(home):
            store = MemoryStore()
            store.load_from_disk()
            database = SessionDB(home / "state.db")
            database.create_session("employee-context-history", source="cli")
            database.append_message(
                "employee-context-history",
                role="user",
                content=f"employee-context-canary-{index}",
            )
            agent = SimpleNamespace(
                session_id="employee-context-native",
                _get_session_db_for_recall=lambda database=database: database,
                _memory_store=store,
                _memory_manager=None,
            )
            context = InlineToolContext(effective_task_id="employee-context-native", tool_call_id="call")
            try:
                memory = json.loads(run_tool_execution_middleware(
                    "memory",
                    {"action": "add", "content": f"employee-memory-canary-{index}"},
                    lambda payload: INLINE_TOOL_EXECUTORS["memory"](agent, payload, context),
                    session_id=agent.session_id,
                    turn_id="turn",
                    tool_call_id="call",
                ))
                assert memory.get("success") is True, memory

                history = json.loads(run_tool_execution_middleware(
                    "session_search",
                    {"session_id": "employee-context-history"},
                    lambda payload: INLINE_TOOL_EXECUTORS["session_search"](agent, payload, context),
                    session_id=agent.session_id,
                    turn_id="turn",
                    tool_call_id="call",
                ))
                assert history.get("success") is True, history
                assert f"employee-context-canary-{index}" in json.dumps(history, ensure_ascii=False)
            finally:
                database.close()

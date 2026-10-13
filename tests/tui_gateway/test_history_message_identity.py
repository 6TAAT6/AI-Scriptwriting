"""历史展示透传逻辑消息身份，区分压缩副本与用户再次输入。"""

from hermes_state import SessionDB
from tui_gateway import server


def test_display_preserves_durable_identity_across_compaction(tmp_path):
    database = SessionDB(tmp_path / "state.db")
    try:
        database.create_session("identity", source="web")
        original = {"role": "user", "content": "请改编这个故事。\n", "timestamp": 1000.0}
        database.append_messages_batch("identity", [original])
        retained = {**original, "content": original["content"].strip()}
        database.archive_and_compact("identity", [retained])
        repeated = {"role": "user", "content": retained["content"], "timestamp": 2000.0}
        database.append_messages_batch("identity", [repeated])

        history = database.get_messages_as_conversation(
            "identity", include_compacted=True, include_row_ids=True,
        )
        displayed = server._history_to_messages(history)
        assert all(row.get("message_uid") for row in displayed)
        for source, visible in zip(history, displayed):
            assert visible["message_uid"] == source["message_uid"]
        originals = [row for row in displayed if row["timestamp"] == 1000.0]
        assert {row["message_uid"] for row in originals} == {original["message_uid"]}
        later = next(row for row in displayed if row["timestamp"] == 2000.0)
        assert later["message_uid"] != original["message_uid"]
        assert later["text"] == originals[0]["text"]
    finally:
        database.close()

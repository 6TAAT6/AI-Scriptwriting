"""设定库的检索后端；业务模块只依赖 ``StoryMemory`` 接口，不直接连具体存储。

当前实现为账号目录内的 SQLite（条目名命中 + FTS5 trigram）。对话级长期记忆（含 OpenViking）
直接使用 Hermes 自带的记忆提供方：在 profile 的 config.yaml 设置 ``memory.provider: openviking``
即可启用 ``plugins/memory/openviking``，这里不再另建一套适配器。
"""

from __future__ import annotations

from .base import MemoryHit, MemoryRecord, StoryMemory


def story_memory() -> StoryMemory:
    """返回当前账号的检索后端；每次调用按当前 profile 解析，不跨账号缓存连接。"""
    from .sqlite_store import SqliteStoryMemory
    return SqliteStoryMemory()

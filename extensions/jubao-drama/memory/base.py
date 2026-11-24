"""记忆后端的公共数据形状。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class MemoryRecord:
    """可检索的一条创作资料；``scope`` 是创作范围，``key`` 在范围内唯一。"""
    scope: str
    key: str
    kind: str
    title: str
    text: str
    aliases: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class MemoryHit:
    key: str
    kind: str
    title: str
    score: float


class StoryMemory(Protocol):
    """后端只负责索引与召回；正式内容、版本和确认状态由设定库与要求清单的表保存。"""

    name: str

    def upsert(self, record: MemoryRecord) -> None: ...

    def delete(self, scope: str, key: str) -> None: ...

    def search(self, scope: str, query: str, *, kinds: tuple[str, ...] = (), limit: int = 8) -> list[MemoryHit]: ...

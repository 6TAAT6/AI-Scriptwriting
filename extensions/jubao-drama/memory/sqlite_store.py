"""账号目录内的 SQLite 召回：条目名/别名直接命中优先，其余用 FTS5 trigram 片段补充。

trigram 不能匹配两字词，人物名又常是两字，所以名字命中在 Python 中按子串判断；
每个创作范围的条目数量有限（几十到几百条），全量读名字的代价可以接受。
"""

from __future__ import annotations

from contextlib import closing
import json
import re

from plugins.plugin_storage import plugin_db

from .base import MemoryHit, MemoryRecord

_SEPARATOR = re.compile(r"[\s，。！？；：、,.!?;:“”\"'‘’（）()【】\[\]《》<>·…—\-]+")
_MAX_GRAMS = 64


def _tables(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS story_memory_index (scope TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, "
                 "title TEXT NOT NULL, aliases TEXT NOT NULL, PRIMARY KEY(scope,key))")
    conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS story_memory_fts USING fts5("
                 "scope UNINDEXED, key UNINDEXED, kind UNINDEXED, title, aliases, text, tokenize='trigram')")


def _grams(query: str) -> list[str]:
    grams = []
    for chunk in _SEPARATOR.split(query):
        for index in range(max(0, len(chunk) - 2)):
            gram = chunk[index:index + 3]
            if gram not in grams:
                grams.append(gram)
            if len(grams) >= _MAX_GRAMS:
                return grams
    return grams


class SqliteStoryMemory:
    name = "sqlite"

    def upsert(self, record: MemoryRecord) -> None:
        aliases = [alias for alias in record.aliases if isinstance(alias, str) and alias.strip()]
        with closing(plugin_db("jubao-drama")) as conn:
            _tables(conn)
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM story_memory_fts WHERE scope=? AND key=?", (record.scope, record.key))
            conn.execute("INSERT INTO story_memory_fts VALUES (?,?,?,?,?,?)",
                         (record.scope, record.key, record.kind, record.title, " ".join(aliases), record.text))
            conn.execute("INSERT INTO story_memory_index VALUES (?,?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET "
                         "kind=excluded.kind,title=excluded.title,aliases=excluded.aliases",
                         (record.scope, record.key, record.kind, record.title, json.dumps(aliases, ensure_ascii=False)))
            conn.commit()

    def delete(self, scope: str, key: str) -> None:
        with closing(plugin_db("jubao-drama")) as conn:
            _tables(conn)
            conn.execute("DELETE FROM story_memory_fts WHERE scope=? AND key=?", (scope, key))
            conn.execute("DELETE FROM story_memory_index WHERE scope=? AND key=?", (scope, key))
            conn.commit()

    def search(self, scope: str, query: str, *, kinds: tuple[str, ...] = (), limit: int = 8) -> list[MemoryHit]:
        if not isinstance(query, str) or not query.strip() or limit < 1:
            return []
        scores: dict[str, MemoryHit] = {}
        with closing(plugin_db("jubao-drama")) as conn:
            _tables(conn)
            for key, kind, title, raw in conn.execute(
                    "SELECT key,kind,title,aliases FROM story_memory_index WHERE scope=?", (scope,)):
                if kinds and kind not in kinds:
                    continue
                names = [title, *json.loads(raw)]
                hit = max((len(name) for name in names if len(name) >= 2 and name in query), default=0)
                if hit:
                    scores[key] = MemoryHit(key, kind, title, 100.0 + hit)
            grams = _grams(query)
            if grams:
                expression = " OR ".join('"' + gram.replace('"', '""') + '"' for gram in grams)
                rows = conn.execute(
                    "SELECT key,kind,title,bm25(story_memory_fts,0,0,0,4,2,1) FROM story_memory_fts "
                    "WHERE story_memory_fts MATCH ? AND scope=? ORDER BY 4 LIMIT ?",
                    (expression, scope, limit * 3)).fetchall()
                for key, kind, title, rank in rows:
                    if kinds and kind not in kinds or key in scores:
                        continue
                    # bm25 越小越相关；换成正数分值，始终低于名字直接命中。
                    scores[key] = MemoryHit(key, kind, title, min(99.0, -float(rank)))
        return sorted(scores.values(), key=lambda hit: hit.score, reverse=True)[:limit]

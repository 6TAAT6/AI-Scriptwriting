"""模型稿件目录和正文页；完整展示稿仍由交付读取链提供。"""

import hashlib
import json
import re

from .document_evidence import text_statistics


_EPISODE = re.compile(r"第\s*(\d{1,4})(?:\s*[—–\-~至到]\s*(\d{1,4}))?\s*集")
_DIRECTORY_BUDGET = 6000


def content_metadata(content, name):
    # 只提取名称与独立标题上的集号，不把对白里的“下一集”当成已交付内容。
    titles = [name, *(line.strip(" #*【】") for line in content.splitlines() if line.lstrip(" #*【").startswith("第"))]
    labels = list(dict.fromkeys(
        f"第{int(match[1])}—{int(match[2])}集" if match[2] else f"第{int(match[1])}集"
        for title in titles for match in _EPISODE.finditer(title)
    ))
    return {"text_statistics": text_statistics(content), "characters": len(content), "content_sha256": hashlib.sha256(content.encode()).hexdigest(),
            "episode_range": "、".join(labels[:20]) + ("（其余集号见正文）" if len(labels) > 20 else "") if labels else "未识别"}


def document_metadata(document):
    return {key: value for key, value in document.items() if key != "content"} | content_metadata(document["content"], document["name"])


def project_summary(session_id, agent_id, documents, exports):
    return {"id": "agent-" + hashlib.sha256((agent_id + ":" + session_id).encode()).hexdigest()[:24],
            "title": documents[0]["name"] if documents else "创作稿件", "stage": "skill",
            "agent_id": agent_id, "artifacts": documents, "exports": exports}


def _directory_entry(item):
    # 目录只承担找稿与分页，正文和下载回执由 read/export 与完整资料接口提供。
    row = {key: value for key, value in item.items()
           if key in {"id", "name", "kind", "characters", "content_sha256", "episode_range", "text_statistics"}}
    if isinstance(row.get("text_statistics"), dict):
        row["text_statistics"] = {key: value for key, value in row["text_statistics"].items()
                                  if key in {"method", "scope", "total_scope", "source_sha256", "han_characters",
                                             "non_whitespace_characters", "episode_count"}}
    return row


def directory_page(documents, *, offset, total, snapshot_rowid):
    def result(rows):
        end = offset + len(rows)
        more = end < total
        return {"ok": True, "documents": rows,
                "offset": offset, "total": total, "snapshot_rowid": snapshot_rowid, "has_more": end < total,
                "coverage": {"start_offset": offset, "end_offset": end, "complete": offset == 0 and end == total},
                "coverage_complete": offset == 0 and end == total,
                "next_offset": end if more else None, "order": "newest_first",
                "next_call": {"action": "list", "offset": end, "snapshot_rowid": snapshot_rowid} if more else None,
                "next": ("目录尚未读完。继续调用 next_call，不要重复 action=list 的第一页；未逐页覆盖到末页前不能声称完整查询或确认最旧稿件。"
                         if more else "已到目录末页；只有从 offset=0 沿同一 snapshot_rowid 连续读到本页，才完成全部目录查询。")}

    selected = []
    for document in map(_directory_entry, documents):
        candidate = result([*selected, document])
        if selected and len(json.dumps(candidate, ensure_ascii=False, indent=2)) > _DIRECTORY_BUDGET:
            break
        selected.append(document)
    return result(selected)


def document_page(document, args):
    start, size = args.get("start_char", 0), args.get("max_chars", 12000)
    if type(start) is not int or start < 0 or type(size) is not int or not 1000 <= size <= 20000:
        raise ValueError("起始字符必须为非负整数，单段读取范围为 1,000 至 20,000 个字符")
    content = document["content"]
    metadata = document_metadata(document)
    expected = args.get("content_sha256")
    if expected is not None and expected != metadata["content_sha256"]:
        raise ValueError("稿件内容已变化，请从第一段重新读取，不能拼接不同版本")
    if start > len(content):
        raise ValueError("起始位置超出稿件字符总数")
    end = min(len(content), start + size)
    scope = {"start_char": start, "end_char": end, "characters": len(content),
             "content_sha256": metadata["content_sha256"], "hash_target": "stored_document_text"}
    return {"document": {**metadata, "content": content[start:end]}, **scope,
            "source_scope": scope, "has_more": end < len(content),
            "next_start_char": end if end < len(content) else None,
            "next": "本页正文仅覆盖 start_char 到 end_char；has_more 为 true 时携带 content_sha256 按 next_start_char 继续。必须读完相关正文，不把单页当作全文。"}

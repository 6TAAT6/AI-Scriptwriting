#!/usr/bin/env python3
"""Build structural screenplay mechanism cards from the local IMDb cache.

The generated cards are structural summaries only. They intentionally avoid
copying screenplay dialogue or full scene text.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STC_TYPES = [
    "鬼怪屋",
    "金羊毛",
    "如愿以偿",
    "麻烦家伙",
    "变迁仪式",
    "伙伴之情",
    "推理侦探",
    "愚者成功",
    "被制度化",
    "超级英雄",
]

BEATS = [
    ("opening_image", "开场画面", 1, 0.01, "展示改变前的世界、主角缺陷和影片情绪底色"),
    ("theme_stated", "主题呈现", 2, 0.05, "抛出主角暂时听不懂的主题问题"),
    ("set_up", "铺垫", 3, 0.10, "建立旧世界、人物关系、缺失和即将被打破的秩序"),
    ("catalyst", "催化剂", 4, 0.12, "不可忽视的事件打断旧生活"),
    ("debate", "争论", 5, 0.20, "主角抗拒、权衡或误用旧方法"),
    ("break_into_two", "第二幕衔接点", 6, 0.25, "主角进入反题世界，旧生活无法恢复"),
    ("b_story", "B故事", 7, 0.30, "主题关系出现，提供第三幕精神钥匙"),
    ("fun_and_games", "娱乐游戏", 8, 0.40, "兑现类型承诺，展示新世界规则"),
    ("midpoint", "中点", 9, 0.50, "伪胜利或伪失败，赌注提高，故事从探索转向承担后果"),
    ("bad_guys_close_in", "坏人逼近", 10, 0.62, "外部压力和内部缺陷夹击，旧方法开始反噬"),
    ("all_is_lost", "一无所有", 11, 0.75, "主角失去最关键的目标、关系、身份或信念"),
    ("dark_night_of_the_soul", "灵魂黑夜", 12, 0.80, "主角面对错误信念，理解主题代价"),
    ("break_into_three", "第三幕衔接点", 13, 0.85, "A/B故事融合，新解决方案出现"),
    ("finale", "终局", 14, 0.92, "主角用新自我完成最终行动"),
    ("final_image", "终场画面", 15, 0.99, "展示改变后的世界，与开场形成对照"),
]

L3_BEATS = [
    "opening_image",
    "catalyst",
    "break_into_two",
    "b_story",
    "fun_and_games",
    "midpoint",
    "bad_guys_close_in",
    "all_is_lost",
    "break_into_three",
    "final_image",
]

TYPE_KEYWORDS: list[tuple[str, list[str]]] = [
    ("超级英雄", ["Batman", "Dark_Knight", "Avengers", "Spider", "Superman", "Matrix", "Incredibles", "V_for_Vendetta", "Star_Wars"]),
    ("推理侦探", ["Se7en", "Silence", "Prisoners", "Chinatown", "Rear_Window", "Memento", "Usual_Suspects", "Memories_of_Murder", "Gone_Girl", "Shutter_Island", "Sixth_Sense", "Vertigo"]),
    ("鬼怪屋", ["Alien", "Jaws", "Psycho", "Shining", "Exorcist", "Jurassic_Park", "Pan", "Donnie_Darko"]),
    ("金羊毛", ["Lord_of_the_Rings", "Raiders", "Indiana", "Saving_Private_Ryan", "1917", "Martian", "Interstellar", "Finding_Nemo", "Wizard_of_Oz", "Road", "Top_Gun", "Dune"]),
    ("伙伴之情", ["Before_Sunrise", "Green_Book", "Toy_Story", "Casablanca", "Her", "Titanic", "La_La_Land", "Amelie", "Eternal_Sunshine", "How_to_Train"]),
    ("被制度化", ["Shawshank", "Godfather", "Goodfellas", "Casino", "Departed", "Whiplash", "Network", "Spotlight", "Parasite", "Cuckoos_Nest", "Full_Metal_Jacket", "Wall_Street"]),
    ("变迁仪式", ["Father", "Beautiful_Mind", "Inside_Out", "Million_Dollar_Baby", "Raging_Bull", "Dead_Poets", "Pursuit_of_Happyness", "Forrest_Gump", "Klaus"]),
    ("愚者成功", ["Forrest_Gump", "Amelie", "Truman_Show", "Catch_Me_If_You_Can", "Grand_Budapest", "Singin", "Deadpool"]),
    ("如愿以偿", ["Groundhog_Day", "Back_to_the_Future", "Your_Name", "Eternal_Sunshine", "Big", "Being_John"]),
    ("麻烦家伙", ["Die_Hard", "Terminator", "Bourne", "Mad_Max", "Fury_Road", "Blood_Diamond", "Revenant", "Rush", "Ford_v_Ferrari", "Hacksaw"]),
]

TAG_TO_TYPE = {
    "悬疑/惊悚": "推理侦探",
    "犯罪/黑帮": "被制度化",
    "动作/冒险": "金羊毛",
    "科幻/设定": "超级英雄",
    "爱情/亲密关系": "伙伴之情",
    "亲情/治愈/成长": "变迁仪式",
    "职场/制度/黑色幽默": "被制度化",
}

SCENE_HEADING_RE = re.compile(
    r"^\s*(?:\d+\s+)?(?:INT\.|EXT\.|INT/EXT\.|I/E\.|INT\s*--|EXT\s*--)\s+.+",
    re.IGNORECASE,
)

ACTION_PATTERNS: list[tuple[str, list[str]]] = [
    ("进入/离开", [" enter", " enters", " arrive", " arrives", " leave", " leaves", " walk", " walks", " step", " steps"]),
    ("逼问/谈判", [" ask", " asks", " question", " interrogat", " demand", " argue", " insists", " negotiate", " confront"]),
    ("暴力/危险", [" shoot", " fires", " gun", " blood", " dead", " kill", " attack", " scream", " explosion", " punch", " knife"]),
    ("隐藏/发现", [" discover", " find", " finds", " reveal", " opens", " watches", " sees", " secret", " hidden", " clue"]),
    ("追逐/移动", [" run", " runs", " chase", " drives", " car", " escape", " follows", " hurry", " train"]),
    ("选择/承诺", [" decide", " refuses", " agrees", " promise", " signs", " chooses", " choice", " accepts"]),
    ("关系/亲密", [" kisses", " family", " father", " mother", " son", " daughter", " wife", " husband", " friend"]),
    ("制度/规则", [" court", " police", " prison", " office", " bank", " hospital", " meeting", " trial", " board"]),
]


@dataclass(frozen=True)
class SourceRow:
    film_no: str
    title: str
    source_file: str
    cache_file: str
    tags: list[str]
    dimensions: list[str]
    chars: int
    lines: int
    text_path: Path
    sha256_16: str


def clean_title(raw: str) -> tuple[str, str]:
    match = re.match(r"^(\d{3})[_：: -]*(.+)$", raw)
    if not match:
        return "000", raw
    return match.group(1), match.group(2)


def split_semicolon(value: str) -> list[str]:
    return [item.strip() for item in re.split(r"[;；]", value or "") if item.strip()]


def load_sources(manifest: Path, cache_root: Path, min_chars: int) -> tuple[list[SourceRow], list[dict[str, Any]]]:
    usable: list[SourceRow] = []
    excluded: list[dict[str, Any]] = []
    with manifest.open("r", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            title = row["title"]
            film_no, _ = clean_title(title)
            chars = int(row.get("chars") or 0)
            reason = ""
            if row.get("source_type") != "pdf_script":
                reason = "source_type_not_pdf_script"
            elif chars < min_chars:
                reason = "low_text_chars"
            text_path = cache_root / row["cache_file"]
            if not reason and not text_path.exists():
                reason = "missing_text_cache"
            if reason:
                excluded.append({
                    "title": title,
                    "source_file": row.get("source_file", ""),
                    "cache_file": row.get("cache_file", ""),
                    "source_type": row.get("source_type", ""),
                    "chars": chars,
                    "reason": reason,
                })
                continue
            usable.append(SourceRow(
                film_no=film_no,
                title=title,
                source_file=row["source_file"],
                cache_file=row["cache_file"],
                tags=split_semicolon(row.get("tags", "")),
                dimensions=split_semicolon(row.get("learning_dimensions", "")),
                chars=chars,
                lines=int(row.get("lines") or 0),
                text_path=text_path,
                sha256_16=row.get("sha256_16", ""),
            ))
    return usable, excluded


def read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8", errors="ignore").splitlines()


def classify_stc_type(source: SourceRow) -> tuple[str, list[str]]:
    hay = " ".join([source.title, source.source_file, *source.tags, *source.dimensions])
    scores = {name: 0 for name in STC_TYPES}
    for tag in source.tags:
        mapped = TAG_TO_TYPE.get(tag)
        if mapped:
            scores[mapped] += 4
    for stc_type, keywords in TYPE_KEYWORDS:
        for keyword in keywords:
            if keyword.lower() in hay.lower():
                scores[stc_type] += 6
    if "信息差" in hay or "真相揭示" in hay:
        scores["推理侦探"] += 2
    if "制度" in hay or "群戏权力" in hay:
        scores["被制度化"] += 2
    if "人物弧光" in hay or "结尾情感兑现" in hay:
        scores["变迁仪式"] += 2
    if "类型爽点" in hay or "动作" in hay:
        scores["金羊毛"] += 1
    ordered = sorted(scores.items(), key=lambda item: (-item[1], STC_TYPES.index(item[0])))
    primary = ordered[0][0] if ordered and ordered[0][1] > 0 else "麻烦家伙"
    candidates = [name for name, score in ordered if score > 0][:3]
    if primary not in candidates:
        candidates.insert(0, primary)
    return primary, candidates


def slug(value: str) -> str:
    value = value.lower().replace("故事", "story")
    value = re.sub(r"[^a-z0-9_\u4e00-\u9fff]+", "_", value)
    return value.strip("_") or "item"


def line_window(lines: list[str], pct: float, radius: int = 18) -> tuple[int, int, list[str]]:
    if not lines:
        return 1, 1, []
    center = max(0, min(len(lines) - 1, int(len(lines) * pct)))
    start = max(0, center - radius)
    end = min(len(lines), center + radius + 1)
    return start + 1, end, lines[start:end]


def scene_heading_from_window(window: list[str], fallback: str) -> str:
    for line in window:
        cleaned = " ".join(line.strip().split())
        if not cleaned:
            continue
        if SCENE_HEADING_RE.match(cleaned):
            return truncate(cleaned, 90)
    for line in window:
        cleaned = " ".join(line.strip().split())
        if cleaned and not looks_like_dialogue_name(cleaned):
            return truncate(cleaned, 90)
    return fallback


def scene_block(lines: list[str], scene: dict[str, Any], max_lines: int = 80) -> list[str]:
    start = max(1, int(scene.get("line_start", 1))) - 1
    end = max(start + 1, min(len(lines), int(scene.get("line_end", start + 1))))
    return lines[start : min(end, start + max_lines)]


def action_profile(lines: list[str], heading: str) -> dict[str, Any]:
    text_lines = []
    names: dict[str, int] = {}
    for raw in lines:
        cleaned = " ".join(raw.strip().split())
        if not cleaned or SCENE_HEADING_RE.match(cleaned):
            continue
        if looks_like_dialogue_name(cleaned):
            if 2 <= len(cleaned) <= 24:
                names[cleaned.title()] = names.get(cleaned.title(), 0) + 1
            continue
        text_lines.append(cleaned.lower())
    hay = " " + " ".join(text_lines[:60]) + " "
    actions = []
    for label, patterns in ACTION_PATTERNS:
        if any(pattern in hay for pattern in patterns):
            actions.append(label)
    if not actions:
        actions = ["目标受阻", "关系变化"]
    top_names = [name for name, _count in sorted(names.items(), key=lambda item: (-item[1], item[0]))[:4]]
    if not top_names:
        top_names = infer_names_from_heading(heading)
    return {
        "actions": actions[:4],
        "characters": top_names[:4],
        "location": infer_location(heading),
    }


def infer_names_from_heading(heading: str) -> list[str]:
    words = re.findall(r"[A-Z][A-Z'_-]{2,}", heading)
    ignored = {"INT", "EXT", "DAY", "NIGHT", "CONTINUOUS", "MORNING", "EVENING", "LATER", "ROOM", "HOUSE", "OFFICE"}
    names = [word.replace("_", " ").title() for word in words if word not in ignored]
    return names[:3]


def infer_location(heading: str) -> str:
    cleaned = re.sub(r"^\s*(?:\d+\s+)?(?:INT\.|EXT\.|INT/EXT\.|I/E\.|INT\s*--|EXT\s*--)\s*", "", heading, flags=re.I)
    cleaned = re.split(r"\s+--\s+|\s+-\s+", cleaned)[0]
    return truncate(cleaned or heading, 42)


def profile_phrase(profile: dict[str, Any]) -> str:
    actions = "、".join(profile.get("actions") or ["目标受阻"])
    chars = "、".join(profile.get("characters") or ["主要人物"])
    location = profile.get("location") or "该场景空间"
    return f"地点/空间：{location}；参与者提示：{chars}；可见动作类型：{actions}"


def looks_like_dialogue_name(line: str) -> bool:
    stripped = line.strip()
    return bool(stripped) and stripped.isupper() and len(stripped.split()) <= 4


def truncate(value: str, limit: int) -> str:
    value = " ".join(value.strip().split())
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def parse_scenes(lines: list[str]) -> list[dict[str, Any]]:
    headings: list[tuple[int, str]] = []
    for idx, line in enumerate(lines, start=1):
        cleaned = " ".join(line.strip().split())
        if SCENE_HEADING_RE.match(cleaned):
            headings.append((idx, truncate(cleaned, 120)))
    if len(headings) < 10:
        headings.extend(fallback_headings(lines, existing={idx for idx, _ in headings}))
    headings = sorted({idx: heading for idx, heading in headings}.items())
    scenes: list[dict[str, Any]] = []
    for pos, (line_no, heading) in enumerate(headings):
        next_line = headings[pos + 1][0] - 1 if pos + 1 < len(headings) else len(lines)
        if next_line < line_no:
            next_line = line_no
        scenes.append({
            "line_start": line_no,
            "line_end": next_line,
            "heading": heading,
            "pct": line_no / max(len(lines), 1),
        })
    return scenes


def fallback_headings(lines: list[str], existing: set[int]) -> list[tuple[int, str]]:
    results: list[tuple[int, str]] = []
    numbered_re = re.compile(r"^\s*\d{1,4}\s+.+\s+\d{1,4}\s*$")
    uppercase_re = re.compile(r"^[A-Z0-9][A-Z0-9 '\-:/.]{8,}$")
    for idx, line in enumerate(lines, start=1):
        if idx in existing:
            continue
        cleaned = " ".join(line.strip().split())
        if numbered_re.match(cleaned) or (uppercase_re.match(cleaned) and len(cleaned.split()) >= 3):
            results.append((idx, truncate(cleaned, 120)))
        if len(results) >= 160:
            break
    return results


def choose_scene_for_pct(scenes: list[dict[str, Any]], pct: float, used: set[int]) -> dict[str, Any]:
    if not scenes:
        line = max(1, int(pct * 100))
        return {"line_start": line, "line_end": line, "heading": f"Approximate structural position {pct:.0%}", "pct": pct}
    ordered = sorted(enumerate(scenes), key=lambda item: (abs(item[1]["pct"] - pct), item[0] in used))
    for idx, scene in ordered:
        if idx not in used:
            used.add(idx)
            return scene
    idx, scene = ordered[0]
    used.add(idx)
    return scene


def beat_summary_for(source: SourceRow, primary_type: str) -> dict[str, str]:
    summary: dict[str, str] = {}
    for key, name, _order, _pct, function in BEATS:
        summary[key] = f"{name}承担《{source.title}》的{function}，主类型按“{primary_type}”判断。"
    return summary


def make_l1(source: SourceRow, lines: list[str], primary: str, candidates: list[str]) -> dict[str, Any]:
    source_quality = {
        "chars": source.chars,
        "lines": len(lines),
        "sha256_16": source.sha256_16,
        "usable_for_l2_l3": True,
    }
    return {
        "id": f"film_{source.film_no}",
        "detail": "l1",
        "source_title": source.title,
        "source_file": source.source_file,
        "cache_file": source.cache_file,
        "stc_type_primary": primary,
        "stc_type_candidates": candidates,
        "genre_tags": source.tags,
        "logline_pattern": f"当旧世界被催化事件打破，主角被迫进入“{primary}”结构的反题世界，并在外部目标中完成主题变化。",
        "protagonist_arc": "从开场的错误信念、停滞或缺失，走向终局中能够承担代价的新自我。",
        "theme_question": "主角必须学会什么，才配完成最后行动？",
        "a_story": "外部目标线：由催化剂推动，经过中点加重，在终局完成类型承诺。",
        "b_story": "主题关系线：提供主角理解主题、改变方法和进入第三幕的精神钥匙。",
        "opening_final_image_pair": "开场画面呈现旧我和旧世界；终场画面呈现新我和改变后的世界。",
        "beat_summary": beat_summary_for(source, primary),
        "source_quality": source_quality,
    }


def make_l2(source: SourceRow, lines: list[str], primary: str) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []
    for key, name, order, pct, function in BEATS:
        start, end, window = line_window(lines, pct)
        heading = scene_heading_from_window(window, f"{name}附近的结构位置")
        profile = action_profile(window, heading)
        cards.append({
            "id": f"beat_{source.film_no}_{key}",
            "detail": "l2",
            "film_id": f"film_{source.film_no}",
            "source_title": source.title,
            "beat_name": name,
            "beat_order": order,
            "approximate_position": f"{round(pct * 100)}%",
            "story_function": function,
            "visible_event": f"在“{heading}”附近，以{profile_phrase(profile)}来完成{function}。",
            "character_change": f"该节拍应让参与者围绕{('、'.join(profile['actions']))}改变目标、压力、关系或自我认知。",
            "theme_pressure": f"按“{primary}”类型检查：这些动作是否把主题问题压到可见行动上，而不是只停留在说明。",
            "transferable_pattern": f"把{function}迁移到新故事时，保留节拍功能，替换人物、行业、冲突物件和场景空间。",
            "use_for": f"{name}设计、结构诊断、同类电影参考、救猫咪节拍改写",
            "source_ref": {
                "cache_file": source.cache_file,
                "line_start": start,
                "line_end": end,
                "scene_hint": heading,
            },
        })
    return cards


def make_l3(source: SourceRow, lines: list[str], scenes: list[dict[str, Any]], primary: str) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []
    beat_by_key = {key: (name, pct, function) for key, name, _order, pct, function in BEATS}
    used: set[int] = set()
    for scene_order, beat_key in enumerate(L3_BEATS, start=1):
        beat_name, pct, function = beat_by_key[beat_key]
        scene = choose_scene_for_pct(scenes, pct, used)
        heading = scene["heading"]
        profile = action_profile(scene_block(lines, scene), heading)
        actions = "、".join(profile["actions"])
        characters = "、".join(profile["characters"] or ["主要人物"])
        location = profile["location"]
        cards.append({
            "id": f"scene_{source.film_no}_{scene_order:02d}",
            "detail": "l3",
            "film_id": f"film_{source.film_no}",
            "source_title": source.title,
            "scene_order": scene_order,
            "scene_heading": heading,
            "linked_beat": beat_name,
            "scene_function": function,
            "scene_goal": f"在{location}中用{actions}推动“{beat_name}”功能，让{primary}类型的外部目标或主题压力变成可拍行动。",
            "pressure_source": f"{infer_pressure(primary, heading)} 本场可见压力信号：{actions}。",
            "power_relation": f"{characters}之间至少有一方掌握资源、规则、信息、暴力或情感债；另一方必须通过{actions}应对。",
            "information_gap": infer_information_gap(profile),
            "escalation_pattern": f"从{profile['actions'][0]}开始，逐步升级到身份、关系、代价或世界规则变化。",
            "reversal": f"场景结束时，{characters}对目标、关系或规则的理解必须因{actions}而改变。",
            "character_state_change": f"记录人物进入场景时想维持什么，离开场景时又因{actions}失去或获得什么。",
            "transferable_mechanism": f"保留{beat_name}的结构功能、{actions}的压力链和{location}的空间约束，替换具体剧情、人物姓名、行业和对白。",
            "originality_guardrail": "不要复制原片剧情、台词或场面调度；只迁移结构位置、压力源和反转功能。",
            "source_ref": {
                "cache_file": source.cache_file,
                "line_start": scene["line_start"],
                "line_end": scene["line_end"],
            },
        })
    return cards


def infer_pressure(primary: str, heading: str) -> str:
    low = heading.lower()
    if any(word in low for word in ["court", "police", "prison", "office", "bank", "hospital"]):
        return "制度规则、职业权力或公共空间压力。"
    if any(word in low for word in ["house", "home", "room", "apartment", "kitchen"]):
        return "亲密关系、家庭空间或私人秘密压力。"
    if any(word in low for word in ["car", "street", "road", "train", "ship", "space"]):
        return "移动空间、时间限制或逃离/追逐压力。"
    return {
        "推理侦探": "线索缺失、误导、嫌疑变化和真相代价。",
        "被制度化": "组织规则、身份绑定、奖惩系统和自由代价。",
        "金羊毛": "任务目标、路途阻碍、团队裂缝和奖品失真。",
        "伙伴之情": "互补缺失、关系旧账、信任测试和分离代价。",
        "鬼怪屋": "封闭空间、越界原罪、怪物规则和逃离代价。",
        "超级英雄": "能力代价、公众误解、责任选择和镜像反派。",
        "变迁仪式": "不可逆失去、错误抵抗、接受真相和新生活方式。",
        "愚者成功": "低估、精英规则、荒唐制度和弱点反转。",
        "如愿以偿": "愿望规则、错误欲望、短暂满足和关系反噬。",
        "麻烦家伙": "突发危机、资源压缩、旧方法失效和主动反击。",
    }.get(primary, "外部目标、人物关系和主题压力。")


def infer_information_gap(profile: dict[str, Any]) -> str:
    actions = set(profile.get("actions") or [])
    if "隐藏/发现" in actions:
        return "信息差来自线索、秘密或误判的揭开；迁移时要明确观众、主角、对手分别知道什么。"
    if "逼问/谈判" in actions:
        return "信息差来自问答双方掌握的筹码不同；迁移时让每轮对话改变对方策略。"
    if "制度/规则" in actions:
        return "信息差来自制度规则和个人处境的不对称；迁移时让规则本身制造压力。"
    if "关系/亲密" in actions:
        return "信息差来自关系旧账、未说出口的欲望或误解；迁移时让亲密关系改变行动选择。"
    return "检查观众、主角、对手三方是否知道不同事实；若信息相同，应改成选择压力或价值观冲突。"


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for record in records:
            fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-root", default=os.environ.get("MOVIE_SKILL_CACHE_ROOT"), required=os.environ.get("MOVIE_SKILL_CACHE_ROOT") is None, help="Path to the local screenplay cache root (or set MOVIE_SKILL_CACHE_ROOT).")
    parser.add_argument("--output-dir", default=str(Path(__file__).resolve().parents[1] / "assets" / "library" / "_generated-cards"))
    parser.add_argument("--min-chars", type=int, default=1000)
    args = parser.parse_args()

    cache_root = Path(args.cache_root).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    manifest = cache_root / "_gpts_material_cache" / "source_manifest.csv"
    sources, excluded = load_sources(manifest, cache_root, args.min_chars)

    l1: list[dict[str, Any]] = []
    l2: list[dict[str, Any]] = []
    l3: list[dict[str, Any]] = []
    scene_counts: dict[str, int] = {}
    type_counts: dict[str, int] = {name: 0 for name in STC_TYPES}

    for source in sources:
        lines = read_lines(source.text_path)
        primary, candidates = classify_stc_type(source)
        type_counts[primary] += 1
        scenes = parse_scenes(lines)
        scene_counts[source.title] = len(scenes)
        l1.append(make_l1(source, lines, primary, candidates))
        l2.extend(make_l2(source, lines, primary))
        l3.extend(make_l3(source, lines, scenes, primary))

    files = {
        "film_structure_cards": output_dir / "film-structure-cards.jsonl",
        "beat_case_cards": output_dir / "beat-case-cards.jsonl",
        "scene_mechanism_cards": output_dir / "scene-mechanism-cards.jsonl",
    }
    write_jsonl(files["film_structure_cards"], l1)
    write_jsonl(files["beat_case_cards"], l2)
    write_jsonl(files["scene_mechanism_cards"], l3)

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_manifest": str(manifest),
        "cache_root": str(cache_root),
        "min_chars": args.min_chars,
        "source_counts": {
            "usable_pdf_scripts": len(sources),
            "excluded": len(excluded),
            "excluded_episode_transcripts": sum(1 for item in excluded if item["reason"] == "source_type_not_pdf_script"),
            "excluded_low_text_chars": sum(1 for item in excluded if item["reason"] == "low_text_chars"),
        },
        "card_counts": {
            "l1_films": len(l1),
            "l2_beats": len(l2),
            "l3_scenes": len(l3),
        },
        "target_counts": {
            "l1_films": 160,
            "l2_beats": 2400,
            "l3_scenes": 1600,
        },
        "stc_type_counts": {key: value for key, value in type_counts.items() if value},
        "excluded_sources": excluded,
        "scene_detection": {
            "min_detected_scenes": min(scene_counts.values()) if scene_counts else 0,
            "max_detected_scenes": max(scene_counts.values()) if scene_counts else 0,
            "films_with_under_10_detected_scenes": [
                {"title": title, "scene_count": count}
                for title, count in sorted(scene_counts.items())
                if count < 10
            ],
        },
        "files": {
            name: {
                "path": str(path),
                "sha256": sha256_file(path),
            }
            for name, path in files.items()
        },
        "notes": [
            "Cards are structural summaries only; full screenplay text is not bundled.",
            "The index uses Save the Cat ten story types and fifteen beats as the primary framework.",
            "Episode transcripts and low-text film caches are excluded by rule.",
        ],
    }
    write_json(output_dir / "index-summary.json", summary)
    print(json.dumps(summary["card_counts"], ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

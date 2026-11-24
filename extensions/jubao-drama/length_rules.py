"""从用户原话中确定性地识别篇幅与全剧集数要求，作为要求清单模型提取的兜底。

正式版的正则合同只认得“每集至少N字 / 每集A-B字”等少数写法：近三周 517 条带字数要求的员工消息
只识别出 13%（“每集1000字左右”“一集700-800字”“每一集1200字左右”“不能低于850字”都漏掉），
每集字数落在要求范围内的只有 18%。重构版改由模型提取要求清单，模型偶尔漏提或提取失败时，
这里按员工的真实写法补上，保证字数和全剧集数一定成为可核验的硬指标。
"""

from __future__ import annotations

import re

_NUM = r"(\d{2,5}|[零〇一二两三四五六七八九十百千]{1,6})"
_DIGITS = dict(zip("〇零一二两三四五六七八九", (0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9)))
# 剧本正文每集的常见篇幅在 300—5000 字之间；更小的数是台词、动作行、环境描写或某段文字的上限，不是整集篇幅。
_EPISODE_MAX = 5000
_SUBJECT = re.compile(r"每集|每一集|一集|单集|各集|本集|这集|这一集|每个剧本|每一个剧本|每篇|剧本正文|正文|字数")
_OUTLINE = re.compile(r"大纲|集纲|梗概|故事线|简介")
_WHOLE = re.compile(r"全文|总共|一共|总字数|合计|全部加起来")
_LINE_LEVEL = re.compile(r"台词|对白|动作|环境|场景描写|画面|△|一句|每句|换行|人名条|字幕")


def chinese_number(text: str) -> int | None:
    if text.isascii() and text.isdigit():
        return int(text)
    total = digit = 0
    last_unit = 1
    for char in text:
        if char in _DIGITS:
            digit = _DIGITS[char]
        elif char in "十百千":
            unit = {"十": 10, "百": 100, "千": 1000}[char]
            total += (digit or 1) * unit
            digit, last_unit = 0, unit
        else:
            return None
    # “一千二”“八百五”是口语省略写法，末位数字按上一位单位的十分之一计。
    if digit and last_unit >= 100 and not re.search(r"[零〇]", text):
        return total + digit * last_unit // 10
    return total + digit


def _clauses(text: str):
    for line in (text or "").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(("△", ">", "@file:")) or re.match(r"^[^\s：:（(]{1,12}[（(][^）)]{0,12}[）)]?[：:]", stripped):
            continue
        for clause in re.split(r"(?<=[。！？!?；;])", stripped):
            if clause.strip():
                yield clause.strip()


_UNIT = r"\s*(?:个)?(?:汉)?的?字"


def _bounds(part: str, counted: bool):
    """返回 {low, high, explicit}；“N字左右”按 ±15% 换算，与要求清单提取口径一致。counted 表示所在句已说明是字数。"""
    tail = r"(?:个)?(?:汉)?(?:字|一集|每集)" + (r"|(?:左右|之间)|(?=[，,。；;\s]|$)" if counted else "")
    for match in re.finditer(rf"{_NUM}\s*(?:个)?(?:汉)?字?\s*[-—–－~～到至]\s*{_NUM}\s*(?:{tail})", part):
        a, b = chinese_number(match[1]), chinese_number(match[2])
        if a and b and a <= b:
            return {"low": a, "high": b, "explicit": True}
    low = high = None
    for match in re.finditer(rf"(?:不少于|不低于|低于|至少|最少|最低|起码|少于){_NUM}(?:{_UNIT})?|{_NUM}{_UNIT}(?:以上|起)", part):
        value = chinese_number(match[1] or match[2])
        if value and value >= 50 and (match[2] or "字" in match[0] or counted or value >= 300):
            low = value
    for match in re.finditer(rf"(?:超过|最多|至多|上限){_NUM}(?:{_UNIT})?|{_NUM}{_UNIT}(?:以内|之内|以下)", part):
        value = chinese_number(match[1] or match[2])
        if value and value >= 50 and (match[2] or "字" in match[0] or counted or value >= 300):
            high = value
    if low is not None or high is not None:
        return {"low": low, "high": high, "explicit": True}
    approx = re.search(rf"{_NUM}{_UNIT}(?:左右|上下|前后)?|字数[^0-9零〇一二两三四五六七八九十百千。，,；;]{{0,6}}{_NUM}|(?:约|大约|大概){_NUM}{_UNIT}", part)
    value = chinese_number(next(group for group in approx.groups() if group)) if approx else None
    if value and value >= 50:
        return {"low": round(value * 0.85), "high": round(value * 1.15), "explicit": False}
    return None


def _target(part: str, value: int, previous: str = "", clause: str = "") -> str | None:
    """篇幅要求管哪类稿件：紧挨数字前写明“大纲/剧本”的按写明的；否则按量级判断。

    正式版数据里剧本正文每集要求几乎都在 500 字以上，分集大纲每集多在 100—400 字；“改编后的剧本为47集，
    每集1000字左右”出现在要大纲的消息里，管的仍是剧本正文。
    """
    named = list(re.finditer(r"(大纲|集纲|梗概|故事线|剧本|正文)[^，,。；;]{0,8}?(?:\d|[一二两三四五六七八九十百千])", part))
    if named:
        return "outline" if _OUTLINE.search(named[-1][1]) else "script"
    # “续写大纲为47集，每集500字左右”“改编后的剧本为47集，每集1000字左右”：前一分句定义的稿件就是这里的“每集”。
    defined = re.search(r"(大纲|集纲|梗概|剧本|正文)[^，,。；;]{0,6}?(?:为|共|是|一共|总共)\s*(?:\d{1,3}|[一二两三四五六七八九十百]{1,4})\s*集", previous)
    if defined:
        return "outline" if _OUTLINE.search(defined[1]) else "script"
    if value > 450:
        return "script"
    has_outline, has_script = bool(_OUTLINE.search(clause)), bool(re.search(r"剧本|正文", clause))
    if value < 300:
        # 三百字以下只可能是每集大纲篇幅；本句没谈大纲时（“这段内容控制在200字以内”）不是每集指标。
        return "outline" if has_outline else None
    # 300—450 字两类都有：本句只提到一类时按那一类，都提到时按大纲（剧本正文很少要求这么短）。
    return "script" if has_script and not has_outline or not has_outline else "outline"


def _clause_limit(clause: str):
    if "字" not in clause or re.search(r"每十集|十集", clause):
        return []
    counted = bool(re.search(r"字数", clause))
    merged = {}
    parts = [part.strip() for part in re.split(r"[，,]", clause) if part.strip()]
    for index, part in enumerate(parts):
        previous = parts[index - 1] if index else ""
        # “允许有100字的浮动空间”是容差，不是另一项篇幅要求。
        if re.search(r"浮动|误差|上下浮|偏差", part):
            continue
        if _LINE_LEVEL.search(part) and not re.search(r"每集|每一集|一集|单集|每一个剧本|字数", part):
            continue
        if not (_SUBJECT.search(part) or counted or re.search(r"字(?:左右|以上|以内|之内|之间|上下)|超过|低于|少于|至少|最多", part)):
            continue
        found = _bounds(part, counted)
        if not found:
            continue
        target = _target(part, next(v for v in (found["high"], found["low"]) if v is not None), previous, clause)
        if target is None:
            continue
        row = merged.setdefault(target, {"low": None, "high": None, "explicit_low": False, "explicit_high": False})
        # 同一句里明确的上下限优先于“左右”换算出的区间（“850字左右，不许低于700字”取700—977）。
        for side in ("low", "high"):
            if found[side] is not None and (found["explicit"] or not row["explicit_" + side]):
                if row["explicit_" + side] and found["explicit"] and row[side] is not None:
                    continue  # 同一句先给出的明确区间是目标，后面的“绝对不超过”只是更宽的底线
                row[side], row["explicit_" + side] = found[side], found["explicit"]
    results = []
    for target, row in merged.items():
        values = [v for v in (row["low"], row["high"]) if v is not None]
        whole = bool(_WHOLE.search(clause)) and not re.search(r"每集|每一集|一集|单集", clause)
        floor = 50 if target == "outline" else 300
        if not values or any(v < floor or v > (_EPISODE_MAX * 4 if whole else _EPISODE_MAX) for v in values):
            continue
        if row["low"] is not None and row["high"] is not None and row["low"] > row["high"]:
            continue
        metric = "han_characters" if re.search(r"汉字|中文字", clause) and not re.search(r"含标点|包括标点|包含标点", clause) else "non_whitespace_characters"
        # 指名某一集的字数只管本轮；“每集”“以后”这类总括说法本作品之后都适用。
        lifetime = "turn" if (re.search(r"第\s*(?:\d{1,4}|[一二两三四五六七八九十百]{1,5})\s*集|这一?集|这两集|这几集", clause)
                              and not re.search(r"每集|每一集|一集|单集|以后|后续|之后|所有|开始|往后", clause)) else "standing"
        results.append({"quote": clause, "lifetime": lifetime, "constraint": {
            "kind": "min_words", "metric": metric, "unit": "document" if whole else "per_episode",
            "minimum": row["low"], "maximum": row["high"], "target": target}})
    return results


def word_limits(text: str) -> list[dict]:
    """识别篇幅要求，返回 [{quote, lifetime, constraint}]；剧本正文与大纲各取最后一个有效要求，避免同一条消息给出互相冲突的指标。"""
    latest = {}
    for clause in _clauses(text):
        for row in _clause_limit(clause):
            latest[row["constraint"]["target"]] = row
    return list(latest.values())


_EP = r"(\d{1,3}|[一二两三四五六七八九十百]{1,4})"
_SERIES = re.compile(
    rf"(?:改编后的剧本为|剧本为|全剧|全剧共|总共|一共|共计|整部剧(?:总共|一共)?|整部剧共|总集数(?:为|是)?)\s*{_NUM}\s*集"
    rf"|第\s*{_NUM}\s*集(?:为|是|作为|就是)\s*(?:全剧)?大结局|大结局(?:大约|大概)?(?:在|是)\s*第?\s*{_NUM}\s*集(?:左右)?"
    rf"|{_NUM}\s*集(?:才是|是)(?:大)?结局|这是\s*{_NUM}\s*集的大纲"
    # “撰写第43-47集全剧大结局”“第40集至第47集（全剧大结局）”：区间末集就是结局集。
    rf"|第?\s*(?:\d{{1,3}}|[一二两三四五六七八九十百]{{1,4}})\s*集?\s*[-—–~～到至]\s*第?\s*{_EP}\s*集\s*[（(]?(?:的)?(?:全剧)?(?:最终)?大结局")


def series_length(text: str) -> dict | None:
    """全剧总集数（大结局所在集）；分批交付时用来判断未到结局的集不能写成大结局。"""
    found = None
    for clause in _clauses(text):
        for match in _SERIES.finditer(clause):
            value = chinese_number(next(group for group in match.groups() if group))
            if value and 3 <= value <= 300:
                found = {"quote": clause, "constraint": {"kind": "series_length", "total": value}}
    return found


_NO_NOVEL = re.compile(r"(?:不要|别|避免|去掉|去除|杜绝|祛除|减少|删掉|删去|不能有|不许|不能出现|不得出现|不要出现|更正)[^。\n]{0,10}(?:小说化|小说式|文学化)")


def prose_rule(text: str) -> dict | None:
    """“不要小说化描写”（正式版 25 位员工提过 98 次）：记为可逐行核验的文风指标。"""
    for clause in _clauses(text):
        if _NO_NOVEL.search(clause):
            return {"quote": clause, "constraint": {"kind": "prose_style", "rule": "no_novelistic"}}
    return None

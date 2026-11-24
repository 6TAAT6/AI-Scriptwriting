"""目标市场：同一部作品是写给中国观众还是北美观众，决定题材、世界观与本土化方向。

正式版近两周数据：启用 GM3.1、地区为北美且用户没有要求任何奇幻时，30% 的会话输出中式修仙元素；用户要的是
西方奇幻（狼人、吸血鬼等）时这一比例达 56%—86%。不启用 Agent 时同类会话只有 0—5%。用户的地区设置常停留在
默认的“中国”，而原话写着“对标海外付费短剧”，因此市场同时依据创作设置与用户原话判断，并按创作范围记住，
后续“继续写”之类的消息不会把它丢掉。
"""

from __future__ import annotations

from contextlib import closing
import json
import re
import time

from plugins.plugin_storage import plugin_db

from .document_evidence import _EPISODE_HEADING

_SETTINGS = re.compile(r"\n【本轮创作设置】\n([^\n]+)")
_USER_BODY = "\n\n【用户本轮消息】\n"
_NORTH_AMERICA_TEXT = re.compile(r"海外|欧美|北美|美国|美式|英美|西方|出海|ReelShort|DramaBox|英文短剧|去本土化|去中国化")
_CHINA_TEXT = re.compile(r"国内市场|国内观众|中国市场|国产短剧(?:市场|平台)")
_NORTH_AMERICA_NEGATION = re.compile(r"(?:不要|不需要|不想要|拒绝|排除|去掉|取消|不是|非)[^。！？!?,，]{0,12}(?:海外|欧美|北美|美国|美式|英美|西方|出海|ReelShort|DramaBox|英文短剧)")
_EASTERN_FANTASY = re.compile(r"修仙|修真|玄幻|仙侠|东方奇幻|中式奇幻|古风|武侠|宗门|中国神话|山海经")
_NEGATION = re.compile(r"(?:不要|不能|不得|禁止|别|避免|去掉|去除|没有|不含|不带|拒绝)[^，。,；;\n]{0,6}$")
# 正式版近三周 212 个北美/海外项目会话（用户未要求东方奇幻）的输出中：玄幻腔 80%、中式称谓 70%、中式礼俗 67%、
# 龙王战神类 46%、修仙武侠 42%、中式俗语 35% 的会话出现过。只收在北美语境里几乎不会正当出现的词，
# “夫人、少爷、跪下”这类译文里也常见的词不收，交给独立审稿按语境判断。
TERM_GROUPS = (
    ("修仙武侠", re.compile(r"修仙|修真|仙尊|仙界|仙门|灵根|灵力|灵气|宗门|魔尊|渡劫|飞升|法宝|丹药|修为|筑基|金丹|元婴|神识|仙侠|仙帝|"
                        r"灵兽|师尊|掌门|宗主|道友|功法|御剑|结丹|化神|内力|真气|轻功|门派|丹田|经脉"),
     "奇幻题材改用西方体系（狼人族群、吸血鬼家族、女巫议会、血契与诅咒），现实题材改为专业能力或家族企业"),
    ("玄幻腔修辞", re.compile(r"威压|神格|本源|蝼蚁|神魂|至尊|神威|神级|降维打击|等级压制|气运|天道|血脉之力|血脉压制|封神|神祇之力"),
     "删掉网文式的力量等级与神性修辞，用具体动作、表情和台词表现压迫感；不升级世界、不新增神性身份"),
    ("中式称谓", re.compile(r"长姐|大哥|二哥|三哥|四哥|二叔|三叔|大伯|婶婶|嫂子|弟妹|老太君|姨娘|姨太太|嫡女|庶女|丫鬟|主母|正室|侧室|妾室|通房"),
     "称呼改用名字或 Mr./Mrs./Dad/Mom/sis 等西式称呼，不按排行称呼"),
    ("中式礼俗制度", re.compile(r"磕头|祠堂|族谱|列祖列宗|九族|株连|满门抄斩|彩礼|聘礼|拜堂|冲喜|守孝|户口|编制|高考|春节|中秋|红包|民国|军阀|督军|少帅|大帅"),
     "改为北美的制度与习俗：婚前协议、信托与遗嘱、董事会、监护权听证、感恩节/圣诞节、毕业舞会等"),
    ("中式人设命名", re.compile(r"[\u4e00-\u9fff]氏(?:财团|集团|家族|企业)|龙王|战神|兵王|神医|赘婿"),
     "龙王/战神/兵王→隐藏身份的富豪继承人或退役特种兵，神医→天才外科医生，赘婿→婚前协议下被看不起的丈夫，公司与家族用西式名称"),
    ("中式俗语", re.compile(r"狗仗人势|不知天高地厚|有眼不识泰山|癞蛤蟆想吃天鹅肉|吃里扒外|丧家之犬|飞上枝头变凤凰|班门弄斧|狗眼看人低|一人得道鸡犬升天"),
     "台词改为北美口语表达，不用中式俗语和成语"),
)
XIANXIA_TERMS = re.compile("|".join(pattern.pattern for _, pattern, _ in TERM_GROUPS))


_MAPPING = re.compile(r"(?:替换|转换|转变|重塑|改)(?:为|成)|→|->|=>")
_REMOVED_SOURCE = re.compile(r"(?:剥离|删除|删掉|不用|不使用|不采用|去除|去掉|避免|不要|不写|不出现)(?:(?!但|却|仍|保留|采用|加入)[^，,。；;\n])*")


def _table(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS creative_markets (scope_id TEXT PRIMARY KEY, market TEXT NOT NULL, "
                 "eastern_fantasy INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL)")


def _parts(user_message: str) -> tuple[dict, str]:
    if not isinstance(user_message, str):
        return {}, ""
    control, body = (user_message.split(_USER_BODY, 1) if _USER_BODY in user_message else ("", user_message))
    body = body.split("\n\n--- Attached Context ---", 1)[0]
    match = _SETTINGS.search(control)
    try:
        settings = json.loads(match[1]) if match else {}
    except ValueError:
        settings = {}
    return (settings if isinstance(settings, dict) else {}), body


def asks_eastern_fantasy(text: str) -> bool:
    """用户原话明确要求东方奇幻（“不要修仙”这类否定不算）。"""
    return any(not _NEGATION.search(text[:match.start()]) for match in _EASTERN_FANTASY.finditer(text or ""))


def observe(scope_id: str, user_message: str) -> None:
    settings, body = _parts(user_message)
    region = str(settings.get("region") or "")
    rejected_north_america = bool(_NORTH_AMERICA_NEGATION.search(body))
    north_america = ((region in {"北美", "欧美"} or settings.get("target_market") == "North America"
                      or bool(_NORTH_AMERICA_TEXT.search(body))) and not rejected_north_america)
    china = bool(_CHINA_TEXT.search(body))
    fantasy = asks_eastern_fantasy(body)
    with closing(plugin_db("jubao-drama")) as conn:
        _table(conn)
        row = conn.execute("SELECT market, eastern_fantasy FROM creative_markets WHERE scope_id=?", (scope_id,)).fetchone()
        market = "north_america" if north_america else "china" if china or (row is None and region == "中国") else (row[0] if row else None)
        if market is None:
            return
        allowed = int(fantasy or bool(row and row[1]))
        conn.execute("INSERT INTO creative_markets VALUES (?,?,?,?) ON CONFLICT(scope_id) DO UPDATE SET market=excluded.market, "
                     "eastern_fantasy=excluded.eastern_fantasy, updated_at=excluded.updated_at", (scope_id, market, allowed, time.time()))
        conn.commit()


def market_for(scope_id: str) -> tuple[str | None, bool]:
    with closing(plugin_db("jubao-drama")) as conn:
        _table(conn)
        row = conn.execute("SELECT market, eastern_fantasy FROM creative_markets WHERE scope_id=?", (scope_id,)).fetchone()
    return (row[0], bool(row[1])) if row else (None, False)


NORTH_AMERICA_RULES = (
    "四、目标市场：北美（海外付费短剧 / AI 漫剧）\n"
    "- 称呼用名字或 Mr. / Mrs. / Dad / Mom 等，不用长姐、大哥、二叔等排行称呼；公司与家族用西式名称，不写“X氏财团”；不出现民国、军阀、宅斗、"
    "磕头、祠堂、族谱、株连九族、彩礼等中式背景与礼俗；台词用北美口语，不用“有眼不识泰山”“丧家之犬”这类中式俗语。\n"
    "- 西方奇幻也不写成网文玄幻：不用威压、神格、本源、至尊、蝼蚁、血脉压制等力量等级修辞，冲突规模保持在已建立的范围，不升级成神性身份或更大世界。\n"
    "- 题材按北美观众：霸总 / 亿万富豪言情（隐藏身份的富豪丈夫、契约婚姻、替身新娘）、真假千金、大女主复仇（被背叛的妻子、前夫追悔）、"
    "破镜重圆、隐婚怀孕与萌宝、黑帮与暗黑言情、家庭悬疑与心理惊悚；用户要奇幻时只用西方体系（狼人族群与 Alpha / Luna、吸血鬼、女巫、精灵等）。\n"
    "- 未经用户明确要求，不使用中式修仙、玄幻、武侠元素（修仙、宗门、灵根、渡劫、丹药、法宝、仙尊、龙王、战神等）；改编国产剧本时把这些设定换成北美等价物"
    "（龙王 / 战神→隐藏身份的富豪继承人或退役特种兵，赘婿→婚前协议下被看不起的丈夫，宗门→家族企业，彩礼→婚前协议），或改为现实设定。\n"
    "- 人名、地名、机构、节日、饮食、法律与社会关系用北美语境；中文只是表达语言，不是故事世界。"
)
CHINA_RULES = (
    "四、目标市场：中国\n"
    "- 按用户指定的题材创作；现实、都市、言情题材不加入修仙、玄幻、异能、系统等超自然体系，用户明确要求时才写玄幻、修仙或武侠。"
)


def render(scope_id: str) -> str:
    market, fantasy = market_for(scope_id)
    if market == "north_america":
        return NORTH_AMERICA_RULES + ("\n- 用户已明确要求东方奇幻元素，可按其要求使用，但人物与社会语境仍按北美。" if fantasy else "")
    if market == "china":
        return CHINA_RULES
    return ""


def mismatch(scope_id: str, text: str, kind: str = "script") -> list[dict]:
    """北美项目稿件中的中式元素，按类别返回 [{group, terms, fix}]。

    用户明确要求东方奇幻时不查修仙与玄幻两类（称谓、礼俗、俗语仍按北美查）；分析稿会讨论原剧设定，不查。
    """
    market, fantasy = market_for(scope_id)
    if market != "north_america" or kind not in {"script", "outline", "novel"}:
        return []
    body = text or ""
    preamble = ""
    if kind == "outline" and (heading := _EPISODE_HEADING.search(body)):
        # 只排除前言明确要删除的旧元素；肯定设定和分集正文仍必须受检。
        preamble, body = body[:heading.start()], body[heading.start():]

    def clean_clauses(value, *, remove_explicit_sources=False):
        # 映射先剥离旧值，再处理否定说明；否则“不要把旧词改成宗门”会连目标一起删掉。
        clauses = []
        for clause in re.split(r"[，,。；;\n]", value):
            if mapping := _MAPPING.search(clause):
                source = re.search(r"将|把", clause[:mapping.start()])
                clause = (clause[:source.start()] if source else "") + clause[mapping.end():]
            elif remove_explicit_sources:
                clause = _REMOVED_SOURCE.sub("", clause)
            clauses.append(clause)
        return "\n".join(clauses)

    # 映射只排除旧值，目标仍受检；“原剧/对应”等泛化用语不能让整行逃过检查。
    body = clean_clauses(preamble, remove_explicit_sources=True) + "\n" + clean_clauses(body)
    groups, total = [], 0
    for name, pattern, fix in TERM_GROUPS:
        if fantasy and name in {"修仙武侠", "玄幻腔修辞"}:
            continue
        found = pattern.findall(body)
        if found:
            total += len(found)
            groups.append({"group": name, "terms": list(dict.fromkeys(found))[:6], "fix": fix})
    distinct = sum(len(group["terms"]) for group in groups)
    return groups if distinct >= 2 or total >= 3 else []


# ----- 参考资料取用：北美项目不让华语题材库把故事拉回中式玄幻 -----
# GM3.1 规则里早已写有“不预设修仙玄幻”，正式版仍有 30% 的北美会话写出修仙元素：模型读到 33k 字全是华语与日漫的
# 题材卡、传统武术招式库后，文字规则压不住。北美项目读这些文件时由系统改读北美题材库，或在内容前标注取用边界。
_REDIRECT = {"pattern-library/02.md": "references/pattern-library/north-america.md"}
_BLOCKED = {"martial-arts-library/02.md": "传统武术招式模板（武侠、内功、轻功）不适用于北美项目；打戏改读 martial-arts-library/03.md 的现代格斗与冷兵器部分。"}
_NOTES = {
    "naming-library.md": "北美项目：本库例子多为华语短剧剧名（战神、龙王、赘婿等），只借命名机制；剧名与人物名按北美题材取，参考 pattern-library/north-america.md。",
    "framework/09.md": "北美项目：C6 武侠/仙侠模块不适用，除非用户明确要求东方奇幻。",
    "dialogue.md": "北美项目：本文件示例是中文语境的台词，只借技法；台词写成北美人会说的口语，不用中式俗语、成语与排行称呼。",
    "pattern-library/03.md": "北美项目：通用规律区只借节奏、钩子与结构，不借世界观元素。",
    "pattern-library/index.md": "北美项目：题材卡读 pattern-library/north-america.md，不读 02.md 的华语 DNA 卡。",
}


def _matched(path, table):
    return next((key for key in table if path == key or path.endswith("/" + key)), None)


def tool_execution(tool_name, args, next_call, *, session_id="", **_kwargs):
    if tool_name != "skill_view" or not isinstance(args, dict) or not isinstance(args.get("file_path"), str) or not session_id:
        return next_call(args)
    path = args["file_path"].strip().lstrip("./")
    try:
        from .creative_scope import scope_for
        market, fantasy = market_for(scope_for(session_id))
    except Exception:
        return next_call(args)
    if market != "north_america" or fantasy:
        return next_call(args)
    if key := _matched(path, _BLOCKED):
        return json.dumps({"success": False, "error": _BLOCKED[key], "file": args["file_path"]}, ensure_ascii=False)
    note = None
    if key := _matched(path, _REDIRECT):
        args = {**args, "file_path": _REDIRECT[key]}
        note = "目标市场为北美：华语题材 DNA 卡（02.md）不适用，已改为读取北美题材库。"
    elif key := _matched(path, _NOTES):
        note = _NOTES[key]
    result = next_call(args)
    if not note:
        return result
    try:
        data = json.loads(result) if isinstance(result, str) else None
    except ValueError:
        data = None
    if isinstance(data, dict) and isinstance(data.get("content"), str):
        data["content"] = f"【{note}】\n\n" + data["content"]
        return json.dumps(data, ensure_ascii=False)
    return result

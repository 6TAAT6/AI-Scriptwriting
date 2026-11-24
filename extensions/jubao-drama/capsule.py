"""创作胶囊：每轮把要求清单、设定库和连续性附加到当前用户消息，压缩后也不会丢失。

胶囊由 pre_llm_call 返回，只作用于本次请求，不写入会话历史；同时在后台提取本轮
用户原话中的新要求，供后续轮次使用。
"""

from __future__ import annotations

import logging
import re

from . import ledger, market, story_bible
from .creative_scope import bind, project_from_message, scope_for

_LOGGER = logging.getLogger(__name__)
_USER_BODY = "\n\n【用户本轮消息】\n"
# 以下三句是产品默认措辞；所选主 Agent 在能力目录另设默认篇幅或双字数报告时，只替换这几句（见 _agent_rules）。
_PRODUCT_LENGTH_RULE = "用户没有给出字数时，剧本正文按产品默认每集1000—1200个汉字写，优先于 Agent 规则文档里的默认字数。\n"
_PRODUCT_PLAN_EXAMPLE = "1000—1500时1150、1000—1200时1060"
_NO_EPISODE_COUNTS = "、不逐集复述字数。\n"
_DUAL_COUNTS = ("；剧本正文保存后另起一行，按保存或核验回执 statistics.episodes 报告各集汉字数（han_characters）与净字数"
                "（non_whitespace_characters，不含集标题），写成“字数：第1集 汉字1452／净字1688；第2集 …”，不估算、不罗列其他字段。\n")

_PREFLIGHT_RULES = (
    "【首稿前置分配｜仅主会话】复杂创作任务（多集、改编、带附件或已有设定）动笔前最多调用一次原生 "
    "delegate_task，给最多两个只读叶子并行分析：第一路检查人物动机、因果和证据链，第二路检查结构节奏、"
    "连续性、格式和用户硬性要求，并按 host_constraints 为本轮每集给出场次、动作、对白和OS的篇幅预算。"
    "预算保留原始 metric，计入场头、人物行、角色名、字幕与标点等适用项目；双边区间的规划目标取下限加区间宽度的30%（" + _PRODUCT_PLAN_EXAMPLE + "）；各份额之和不超过规划目标且不能低于下限。写到规划篇幅后完成本集必需剧情即收束，不追加重复总结或钩子说明。"
    "两个任务使用同一份当前用户原话、已读取资料和当前设定快照，不能互相等待。"
    "每个子任务只返回结构化 JSON findings（verdict、issues、must_preserve、suggestions），不写稿、不保存、不导出、"
    "不调用 drama_submit、drama_review、drama_confirm、drama_agent_document(save/check/export)、image_generate、"
    "clarify 或 delegate_task。子代理完成回传后，主会话吸收两路 findings，再唯一生成首稿；主会话只保存一次，"
    "随后只对同一 document_id 做一次 check。子代理回传不得触发第二次保存、审稿或返修。简单问答、只读、单纯导出和"
    "已经有明确返修问题的回合不启动前置分配。"
)
_CHILD_RULES = (
    "【只读子代理边界】你当前是主会话委派的只读分析器，只能读取父任务明确提供的资料并返回结构化 findings。"
    "不得调用 delegate_task、drama_submit、drama_review、drama_confirm、drama_agent_document(save/check/export)、"
    "image_generate、clarify，不得修改设定、要求、项目或任何稿件，不得生成可直接交付的完整正文。"
    "只报告 verdict、issues、must_preserve、suggestions；不能声称已保存、已审核或已导出。"
)
_RULES = (
    "【使用规则】\n"
    "1. 优先级：用户本轮原话 > 要求清单 > 设定库 > Agent 规则与参考文档的默认做法。规则文档里的默认节奏、集数、字数、语言、"
    "自检报告和生成前问询都不能替换用户的明确要求；自检在心里完成，不输出给用户。"
    "但当前 Agent 规则中明确的人工确认节点（如 OA6.1 的核心期待确认与方案选择）照常执行，用户明确免除时才跳过。\n"
    "2. 只做用户本轮要求的事：要大纲交大纲，要第3集只写第3集，只改结尾就只改结尾，不顺带推进下一阶段或改动未要求的部分。\n"
    "3. 本轮要分多批、分别保存多份稿件时，动笔前用 todo_list 一次列出每一批，全部完成后再更新一次；只交付一份稿件时不用 todo_list。"
    "交付前在心里对照用户本轮原话和要求清单逐项核对稿件，回复里只简要点出没做到的项及原因，不笼统声称“已按要求完成”。\n"
    "4. 要求清单是用户亲口提出的要求，交付前逐条对照，新话优先于旧条目；清单只由用户维护，你不能自行增删。"
    "带【硬指标】的字数逐集遵守：动笔前按区间规划每场篇幅，双边区间先按下限加区间宽度30%的目标写作，目标保持在用户区间内；超出上限删减重复动作与说明性台词，不足下限补具体动作与冲突，不灌水；以核验工具的统计为准。"
    "子代理 findings 仅是建议，不得覆盖原始用户要求或 host_constraints 数字合同。首稿动笔前按第二路预算分配每集场次、"
    "动作、对白与OS，保持原始 metric 与适用范围；不得只写泛化的‘字’而丢掉汉字/非空白字符口径，也不把规划数冒充真实统计。"
    "附件与有效显式要求冲突时沿用显式要求，在问题说明中保留双方来源，不自行把附件升级为系统硬要求。"
    + _PRODUCT_LENGTH_RULE +
    "5. 设定库是本作品的权威设定，与历史对话、压缩摘要或你的记忆冲突时以设定库为准；没有建立的事实保持未知，不编造。"
    "只用已建立的世界规则、人物身份与能力、人物关系和关键物件推进剧情；确需新的核心设定时先用 drama_story_bible(action=\"propose\") 提交，"
    "用户确认前不写进正文，被拒绝就沿用现有设定。次要人物、地点、文风和备注用 record 直接记录；“最新末态”由系统在每次交付后自动整理，无需你记录。"
    "设定库为空时照常创作，首次交付后系统会整理待确认的核心设定，无需你代为提交。\n"
    "6. 用户要求学习或沿用其格式、规范、文风时，先完整读取用户给出的样稿或说明，把可执行的格式规则逐条整理好，"
    "用 drama_requirements(action=\"detail\", detail=…) 附到用户这条格式要求上（长期要求会带到用户以后的新作品），之后每轮按它执行；"
    "不要再另存一份到设定库或其他 Agent 的项目工具。\n"
    "7. 判断进度与下一步建议以“当前进度”和用户原话为准，不编造进度。\n"
    "8. 用户给出集纲、大纲、卡点或指定剧情时，逐集照写给定的事件、顺序、人物关系和人设，不增删关键情节；集尾停在用户给的卡点，"
    "不在卡点之后续写新情节。用户要求统一修改某种写法（称呼、用词、格式）时，检查全部相关稿件逐处改完，回复里说明改了几处。\n"
    "9. 交付稿件：大纲、正文、分析等稿件直接在回复中从标题开始完整写出（用户实时看到生成过程），写完立即调用 "
    "drama_agent_document(action=\"save\", kind=…, name=…, from_reply=true) 保存（OA6.1 项目阶段用 drama_submit 并传 from_reply=true），不在工具参数里重复正文；"
    "用户一次要多集时，在同一段回复里按集连续写完全部要求的集数，再保存一次，名称写实际集数范围（如“第05—09集 剧本正文”）；"
    "不要只写一部分就结束本轮，也不要先存单集再把同一集连同后面几集重写一遍。剧本、大纲等不同类型分开保存。"
    "进度说明、核验结论和建议放在保存之后，保存后不再复述全文。不要把正文写进代码或其他工具。"
    "核验未通过时按回执最多定向返修一次：多集稿件只在回复中重写未达标的那几集（系统会替换进整批稿件），"
    "沿用原名称保存，不整批重写。仍不通过则保留稿件，说明未达标项并结束本轮，不自动重启自查。\n"
    "10. 回复只写用户需要看的内容：交接摘要、版本号、“推荐调用”、内部模块名、自检报告、工具回执字段（如 content_verified、document_id）属于内部记录，不输出给用户。"
    "稿件之后的说明（含返修说明）不超过 3—5 行短句，用一层列表或一段话写改了什么，不写多级嵌套列表、不在列表项之间空行" + _NO_EPISODE_COUNTS +
    "11. 只有某技能的完整规则已经出现在当前可用的 skill_view 结果里，才直接复用；兄弟技能名称列表不等于其正文，"
    "各已选技能必须分别完整加载。规则被压缩或截断后先重新完整读取，不根据历史摘要声称已读全；"
    "用户上传的资料用 drama_material_import 一次读较大篇幅，不要分很多小段反复读取。\n"
    "以上是背景资料与规则；本轮要做的事以上方【用户本轮消息】为准。"
)


def _agent_rules(profile, length) -> str:
    """产品默认会话原样返回规则；所选主 Agent 另设默认篇幅或双字数报告时只替换对应句子。"""
    rules = _RULES
    if profile.get("default_script_length"):
        rules = rules.replace(_PRODUCT_LENGTH_RULE,
                              f"用户没有给出字数时，剧本正文按当前 Agent 默认每集{length['minimum']}—{length['maximum']}个汉字写。\n")
    if profile.get("length_report") == "han_and_net":
        rules = rules.replace(_NO_EPISODE_COUNTS, _DUAL_COUNTS)
    return rules


def _agent_preflight(profile, length) -> str:
    """规划目标示例换成本 Agent 的默认区间（下限加区间宽度30%），避免子任务照着产品默认的1060分配预算。"""
    if not profile.get("default_script_length"):
        return _PREFLIGHT_RULES
    target = round(length["minimum"] + (length["maximum"] - length["minimum"]) * 0.3)
    return _PREFLIGHT_RULES.replace(_PRODUCT_PLAN_EXAMPLE, f"{length['minimum']}—{length['maximum']}时{target}、1000—1500时1150")


def _body(user_message) -> str:
    if not isinstance(user_message, str):
        return ""
    body = user_message.split(_USER_BODY, 1)[1] if _USER_BODY in user_message else user_message
    return body.split("\n\n--- Attached Context ---", 1)[0]


def _creative(session_id) -> bool:
    from .capability_selection import creative_session
    return creative_session(session_id)


def _preflight_needed(body: str) -> bool:
    if not isinstance(body, str) or not body.strip():
        return False
    if re.search(r"只(?:读|分析|审核|检查)|仅(?:读|分析|审核|检查)|导出已有|不要改写|只改结尾", body):
        return False
    # 判断是否需要改稿与请求直接改稿不同；不因礼貌请求带“吗”就排除。
    request = body.split("\n\n@file:", 1)[0].strip()
    if re.fullmatch(r"[^。！？?\n]*(?:需要|应该|是否|要不要|该不该)[^。！？?\n]*(?:修改|重写|完善)[^。！？?\n]*(?:吗|么|[？?])[？?]?", request):
        return False
    targeted_edit = re.search(r"改(?:为|成)|替换(?:为|成)|错别字|标点", body)
    preserve_rest = re.search(r"(?:其他|其余)(?:内容|文字|部分)?(?:都)?(?:保持原样|保持不变|一字不动|不动)", body)
    if targeted_edit and preserve_rest:
        return False
    if not re.search(r"(?:写|生成|输出|创作|改编|续写|扩写|重写|修改|完善|整理)", body):
        return False
    if not re.search(r"(?:剧本|正文|大纲|梗概|方案|原稿|第\s*[0-9一二三四五六七八九十百千两〇零]+\s*集|附件|设定)", body):
        return False
    return bool(re.search(r"(?:第\s*[0-9一二三四五六七八九十百千两〇零]+\s*(?:—|-|至|到)\s*|多集|改编|附件|原稿|大纲|梗概|当前设定|已有设定)", body))


class CreativeCapsule:
    def __init__(self, llm):
        self.llm = llm

    def pre_llm_call(self, *, user_message="", session_id="", turn_id="", conversation_history=None, **_kwargs):
        if not session_id:
            return None
        try:
            return self._context(user_message, session_id, turn_id, conversation_history or [])
        except Exception as exc:
            # 胶囊失败不能阻断创作；记录后按原上下文继续。
            _LOGGER.warning("创作胶囊生成失败（session=%s）: %s", session_id, exc, exc_info=True)
            return None

    def _context(self, user_message, session_id, turn_id, history):
        from agent.delegation_context import is_delegated_child_context
        if is_delegated_child_context():
            return {"context": _CHILD_RULES}
        bind(session_id, project_from_message(user_message))
        from .agent_profiles import active_profile, own_protocol
        if own_protocol(session_id):
            # 自带完整协议的 Agent（Vee）只按其规则原文执行：要求清单、设定库、进度、保存与子任务规则都不叠加。
            return None
        scope = scope_for(session_id)
        creative = _creative(session_id)
        # 长期要求属于账号，只在创作对话中生效；普通问答不因它们注入创作胶囊。
        has_requirements = any(not item["lasting"] for item in ledger.list_requirements(scope))
        has_bible = bool(story_bible.list_entries(scope))
        if not (creative or has_requirements or has_bible):
            return None
        ledger.wait_pending(scope)
        # 原生完成通知延续已有用户任务，不能使本轮集数、字数等条款过期。
        from .task_requirement_extract import source_for_turn
        source = source_for_turn(user_message, history, turn_id)
        if source is not None:
            market.observe(scope, user_message)
            if turn_id:
                ledger.begin_turn(scope, turn_id)
                if creative or has_requirements:
                    ledger.schedule_extraction(self.llm, scope, session_id, turn_id, source["original_text"])
        body = _body(user_message)
        profile = active_profile(session_id)
        length = ledger.default_script_length(session_id)
        requirements = ledger.render(scope, default_length=length)
        # 要求提取在后台进行；首稿不能等待它，也不能只看到“用户未指定时”的默认区间。
        # 将当前用户原话中可确定的篇幅合同直接放进本轮胶囊，主会话据此控制首稿长度。
        from .length_rules import word_limits
        explicit_lengths = word_limits(body)
        if explicit_lengths:
            lines = ["本轮宿主篇幅合同（来自当前用户原话，优先于默认值；首稿直接按此收束）："]
            for row in explicit_lengths:
                constraint = row["constraint"]
                metric = constraint.get("metric") or "non_whitespace_characters"
                unit = "汉字" if metric == "han_characters" else "非空白字符"
                low, high = constraint.get("minimum"), constraint.get("maximum")
                target = f"{low}—{high}" if low is not None and high is not None else f"至少{low}" if low is not None else f"最多{high}"
                lines.append(f"- {row['quote']}：每集{target}{unit}；写到区间内即收束，不追加重复解释或额外钩子。")
            requirements = requirements + "\n\n" + "\n".join(lines)
        bible = story_bible.render(scope, body)
        from . import progress
        current = progress.render(session_id) if creative else ""
        parts = ["【创作胶囊｜宿主每轮提供，内容优先于历史摘要】"]
        parts.append("一、要求清单\n" + (requirements or "（暂无已记录的要求；本轮用户原话中的要求会在下一轮起列入。）"))
        parts.append("二、设定库\n" + (bible or "（设定库为空。）"))
        parts.append("三、当前进度（已保存稿件，最新在前）\n" + (current or "（本对话还没有保存稿件。）"))
        market_rules = market.render(scope)
        if market_rules:
            parts.append(market_rules)
        parts.append(_agent_rules(profile, length))
        from .capability_selection import active_skills
        if "content-compliance" in active_skills(session_id):
            parts.append(
                "【已启用：巨豹 skill · 漫剧剧本内容合规审核规范】"
                "本轮涉及审核、创作或改稿时，严格使用该技能完整规范，规范中的条件与待核验参考也须保留。"
                "尚未加载、被截断或压缩后全文不可用时，先单独完整读取 jubao-drama:jubao-skill-content-compliance。"
                "用户请求审核时，风险等级、原文位置、条款、整改建议、实际已审范围与待核验项是应交付的审核报告，"
                "不受通用隐藏内部自检的默认文案限制。只给片段不得判全剧通过，未知不得算通过；不保证平台过审。"
                "仅审核不擅自改写原稿，报告与被审原稿分开；用户未要求报告时按规范约束相关创作并说明必要风险。"
            )
        if source is not None and _preflight_needed(_body(user_message)):
            parts.append(_agent_preflight(profile, length))
        return {"context": "\n\n".join(parts)}

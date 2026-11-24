"""只解析宿主证明的用户原文；不把附件、技能默认值或语义猜测变成硬指标。"""
import hashlib
import json
from pathlib import Path
import re

from agent.context_references import context_reference_original, parse_context_references

_NUMBER = r'(?:\d{1,6}|[零〇一二三四五六七八九十百千两]{1,8})'
_STUDIO_BODY = '\n\n【用户本轮消息】\n'
_SETTING_KINDS = ('target_market', 'script_language', 'dialogue_language', 'prompt_language')
_CELL = r'(?<![A-Za-z0-9])[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?(?![A-Za-z0-9])'
_EDIT_ACTION = r'(?:修订|修正|微调|调整|润色|优化|完善|修改|重写|改写|改)'
# 扩充/输出/推进/精修/精简/丰富是员工要稿时的常用说法（“将每集正文扩充到1000字”“继续输出第9集和第10集的剧本正文”）。
_CREATIVE_ACTION = rf'(?:{_EDIT_ACTION}|续写|扩写|扩充|输出|推进|精修|精简|丰富|完成(?![了的])|展开|改编|编写|写出|创作|生成|整理|列出|给出|给我|(?:只|先)给|(?:先|请|直接)出|(?<!\w)出|写)'
_DRAFT_TARGET = r'(?:每一?集(?:的)?(?:正文|剧本|内容|大纲|集纲)|下一批|(?<!第)\d{1,4}\s*[-—–~～到至]\s*\d{1,4}\s*集|剧本|短剧|正文|大纲|细纲|集纲|梗概|人设|人物小传|小说|故事|分镜|提示词|方案|方向|场景示例|短场景|稿件|原稿|前稿|上稿|上一稿|这集|这一集|第[^。！？\n]{0,12}集)'
# 员工常把集数说在前面：“第三集在这个基础上扩充至1000字左右”“第7集全都重写”；“修改得很好”这类评价不算。
_TARGET_FIRST_ACTION = r'(?:扩充|扩写|续写|重写|改写|精简|精修|润色|修改|修订|调整|丰富)(?![得的过了好])'
_DELIVERY_KIND = re.compile(r'剧本正文|正文剧本|正文|分集大纲|集纲|故事梗概|梗概|大纲|人物小传|人设|人物分析|方案|方向|分镜|提示词|小说|短剧|剧本')
_OUTPUT_KINDS = {'剧本正文':'script', '正文剧本':'script', '正文':'script', '剧本':'script',
                 '分集大纲':'outline', '集纲':'outline', '故事梗概':'outline', '梗概':'outline', '大纲':'outline',
                 '人物小传':'analysis', '人设':'analysis', '人物分析':'analysis', '方案':'analysis', '方向':'analysis',
                 '分镜':'document', '提示词':'document', '小说':'novel', '短剧':'script'}


def number(value):
    if value.isascii() and value.isdecimal():
        return int(value)
    total = digit = 0
    digits = {c: i for i, c in enumerate('零一二三四五六七八九')}
    digits.update({'〇': 0, '两': 2})
    for char in value:
        if char in digits:
            digit = digits[char]
        else:
            total += (digit or 1) * {'十': 10, '百': 100, '千': 1000}[char]
            digit = 0
    return total + digit


def episode_range(text):
    ranges = list(re.finditer(rf'第?\s*({_NUMBER})\s*(?:集\s*)?[—–－\-~至到]\s*第?\s*({_NUMBER})\s*集', text))
    if ranges:
        start, end = map(number, ranges[-1].groups())
        return [start, end] if 0 < start <= end else None
    singles = list(re.finditer(rf'第\s*({_NUMBER})\s*集', text))
    if singles:
        value = number(singles[-1][1])
        return [value, value] if value > 0 else None
    match = re.search(rf'前\s*({_NUMBER})\s*集', text)
    return [1, number(match[1])] if match and number(match[1]) > 0 else None


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(row['text'] for row in content if isinstance(row, dict) and
                         row.get('type') in {'text', 'input_text'} and isinstance(row.get('text'), str))
    return ''



def _final_delegation_notice(row, identifier):
    metadata = row.get("display_metadata")
    return (row.get("role") == "user" and row.get("display_kind") == "async_delegation_complete"
            and isinstance(metadata, dict) and metadata.get("delegation_id") == identifier
            and metadata.get("notification_category") != "diagnostic"
            and not str(metadata.get("delivery_notice") or "").startswith("task_failure:"))


def source_for_delegation_completion(user_message, history, session_id, turn_id):
    """原生终态通知只恢复真实 spawn 对应的用户要求；诊断与子结果不授予创作权限。"""
    if not isinstance(history, list):
        return None
    rows = [row for row in history if isinstance(row, dict)]
    if not rows:
        return None
    notification = rows[-1]
    metadata = notification.get("display_metadata")
    identifier = metadata.get("delegation_id") if isinstance(metadata, dict) else None
    if (not isinstance(identifier, str) or not identifier or not _final_delegation_notice(notification, identifier)
            or _text(user_message) != _text(notification.get("content"))):
        return None
    if any(_final_delegation_notice(row, identifier) for row in rows[:-1]):
        return None
    from contextlib import closing
    from hermes_constants import get_hermes_home
    from hermes_state import SessionDB
    path = get_hermes_home() / "state.db"
    if not path.is_file():
        return None
    with closing(SessionDB(path, read_only=True)) as database:
        if not database._read_one("SELECT name FROM sqlite_master WHERE name='async_delegations'"):
            return None
        record = database._read_one(
            "SELECT parent_session_id,state FROM async_delegations WHERE delegation_id=?", (identifier,))
        lineage = database._resume_lineage_ids(session_id)
        # origin_session_id 是传输层唤醒地址；持久化 parent_session_id 才是发起会话。
        if not record or record[0] not in lineage or record[1] != "completed":
            return None
        source = _delegation_source(rows[:-1], identifier, turn_id)
        if source is None:
            # 旧附件没有来源侧车；只有原生数据库行可证明 Web 来源，内存历史不能自报该证明。
            origins = {identifier: (database.get_session(identifier) or {}).get("source") for identifier in lineage}
            persisted = [{**row, "_row_id": row["id"], "_session_source": origins.get(row.get("session_id"))}
                         for row in database.get_messages(session_id, include_ancestors=True, include_compacted=True)]
            current_uid = notification.get("message_uid")
            current_row = notification.get("_row_id")
            persisted = [row for row in persisted if not (
                ((current_uid and row.get("message_uid") == current_uid)
                 or (current_row and row.get("_row_id") == current_row))
                and _final_delegation_notice(row, identifier) and _text(row.get("content")) == _text(user_message))]
            if any(_final_delegation_notice(row, identifier) for row in persisted):
                return None
            source = _delegation_source(persisted, identifier, turn_id, allow_legacy=True)
            live_humans = [row for row in rows[:-1] if row.get("role") == "user"
                           and not row.get("display_kind") and not row.get("_compressed_summary")]
            if source and live_humans:
                latest = live_humans[-1]
                same_identity = ((source.get("message_uid") and latest.get("message_uid") == source["message_uid"])
                                 or (source.get("message_row_id") and latest.get("_row_id") == source["message_row_id"]))
                if not same_identity or hashlib.sha256(_text(latest.get("content")).encode()).hexdigest() != source["input_sha256"]:
                    return None
    return ({**source, "delegation_id": identifier, "origin": "delegation_completion_user_turn"}
            if source else None)


def _delegation_source(rows, identifier, turn_id, *, allow_legacy=False):
    """以成对 spawn/回执定位授权用户；任何后续真实用户消息都使旧任务过期。"""
    def decoded(value):
        try:
            return json.loads(value) if isinstance(value, str) else value
        except (TypeError, ValueError):
            return None

    calls = {}
    dispatched_at = None
    for index, row in enumerate(rows):
        if row.get("role") == "assistant":
            values = decoded(row.get("tool_calls"))
            for call in values if isinstance(values, list) else []:
                function = call.get("function") if isinstance(call, dict) else None
                if not isinstance(function, dict) or function.get("name") != "delegate_task" or not call.get("id"):
                    continue
                args = decoded(function.get("arguments"))
                if isinstance(args, dict) and args.get("action", "spawn") == "spawn":
                    calls[call["id"]] = index
        elif row.get("role") == "tool" and row.get("tool_name") == "delegate_task":
            call_index = calls.pop(row.get("tool_call_id"), None)
            payload = decoded(row.get("content"))
            if call_index is None or not isinstance(payload, dict):
                continue
            units = payload.get("units") or []
            ids = {unit.get("delegation_id") for unit in units if isinstance(unit, dict)}
            ids.add(payload.get("delegation_id"))
            if payload.get("status") == "dispatched" and payload.get("mode") == "background" and identifier in ids:
                dispatched_at = call_index
    if dispatched_at is None:
        return None
    # 后续人类消息（包括停止/取消）优先；只允许完成当前仍有效的委派请求。
    humans = [i for i, row in enumerate(rows) if row.get("role") == "user"
              and not row.get("display_kind") and not row.get("_compressed_summary")]
    if not humans or humans[-1] > dispatched_at:
        return None
    original_index = humans[-1]
    source = source_for_turn(rows[original_index].get("content"), rows[:original_index + 1], turn_id, allow_legacy=allow_legacy)
    return source


def _legacy_binary_original(text, row):
    """仅恢复已落盘Web旧包装；固定二进制提示不含附件正文，不能兼容自由文本展开。"""
    from hermes_constants import get_hermes_home
    marker = '\n\n--- Attached Context ---\n\n'
    if (row.get('_session_source') != 'web' or type(row.get('_row_id')) is not int
            or row.get('display_metadata') or not text.startswith('【本轮语言偏好】\n')
            or text.count(marker) != 1 or '\n--- Context Warnings ---' in text):
        return None
    original, attached = text.split(marker, 1)
    if original.count(_STUDIO_BODY) != 1:
        return None
    header, body = original.split(_STUDIO_BODY, 1)
    if '\n【本轮创作能力】\n' not in header:
        return None
    refs = parse_context_references(body)
    blocks = attached.split('\n\n')
    if not refs or len(refs) > 16 or len(blocks) != len(refs):
        return None
    for ref, block in zip(refs, blocks):
        if ref.kind != 'file' or ref.line_start is not None or ref.line_end is not None:
            return None
        target = Path(ref.target)
        try:
            relative = target.relative_to(get_hermes_home())
        except ValueError:
            return None
        if (not target.is_absolute() or len(relative.parts) < 2 or relative.parts[0] not in {'attachments', 'workspace'}
                or any(part in {'.', '..'} or part.startswith('.') for part in relative.parts)):
            return None
        pattern = (re.escape(f'📎 {ref.raw} (') + r'[A-Za-z0-9.+_-]+/[A-Za-z0-9.+_-]+, (?:\d+(?:\.\d+)? [KMGT]?B|unknown size)'
                   + re.escape(f') — binary file, not inlined as text. It is available on disk at `{target}`. '
                               'Use your tools to work with it (read or convert it, extract its text, or view/render it as needed); '
                               'do not tell the user the file type is unsupported.'))
        if not re.fullmatch(pattern, block):
            return None
    return original


def source_for_turn(user_message, history, turn_id, *, allow_legacy=False):
    """只核对宿主当前user行，不从数据库猜最近一个同文消息。"""
    incoming = _text(user_message)
    if not incoming.strip() or not isinstance(history, list):
        return None
    latest = next((row for row in reversed(history) if isinstance(row, dict) and row.get('role') == 'user'), None)
    if (not latest or latest.get('_compressed_summary') or latest.get('display_kind')
            or incoming.lstrip().startswith(('[System:', '[CONTEXT', '[ASYNC', '[Your active task list'))):
        return None
    staged = _text(latest.get('content'))
    original = context_reference_original(latest.get('content'), latest.get('display_metadata'))
    if original == '' or incoming not in {staged, original}:
        return None
    legacy_provenance = None
    if original is None and '--- Attached Context ---' in staged:
        original = _legacy_binary_original(staged, latest) if allow_legacy else None
        if original is None:
            return None
        legacy_provenance = {'kind': 'studio_binary_reference_v1', 'message_row_id': latest['_row_id'],
                             'stored_message_sha256': hashlib.sha256(staged.encode()).hexdigest(),
                             'original_prefix_sha256': hashlib.sha256(original.encode()).hexdigest()}
    authored = original if original is not None else incoming
    wrapper = {}
    if authored.startswith('【本轮语言偏好】\n') and _STUDIO_BODY in authored:
        header, authored = authored.split(_STUDIO_BODY, 1)
        match = re.search(r'\n【本轮创作设置】\n([^\n]+)', header)
        if match:
            try:
                value = json.loads(match[1])
            except ValueError:
                value = None
            if isinstance(value, dict):
                wrapper = {k: v for k, v in value.items() if k in {'region', 'language', *_SETTING_KINDS} and isinstance(v, str)}
    return {'turn_id': turn_id, 'text_sha256': hashlib.sha256(authored.encode()).hexdigest(),
            'input_sha256': hashlib.sha256(incoming.encode()).hexdigest(), 'original_text': authored,
            'message_uid': latest.get('message_uid'), 'message_row_id': latest.get('_row_id'),
            'origin': 'runtime_user_hook', 'wrapper_settings': wrapper,
            **({'legacy_provenance': legacy_provenance} if legacy_provenance else {})}


def _clauses(body):
    """围栏、引用行与角色对白是资料；命名约束中的引号内容仍保留。"""
    fence = None
    for line in body.splitlines():
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            if fence is None:
                fence = marker[1]
            elif marker[1][0] == fence[0] and len(marker[1]) >= len(fence):
                fence = None
            continue
        if fence or line.lstrip().startswith(('>', '△', '@file:')):
            continue
        if re.match(r'^(?:角色|人物)[^：:]{0,12}[：:]', line.strip()):
            continue
        for clause in re.split(r'(?<=[。！？!?；;])\s*|\n', line):
            clause = clause.strip()
            if clause and not re.match(r'^(?:例如|示例|举例|原文|引用|附件内容)[：:]', clause):
                yield clause


def _scope(clause, turn=False):
    return {'lifetime': 'turn' if turn or re.search(r'本轮|本次|这次|这一轮', clause) else 'conversation',
            'episodes': episode_range(clause), 'document_id': None}


def _language(text):
    if re.search(r'双语|中英', text):
        return '中英双语'
    if re.search(r'中文|简体', text):
        return '中文'
    if re.search(r'英文|英语|en-US', text, re.I):
        return '英文'
    return None


def starts_new_task(text):
    """仅明确的人类任务切换清除旧条款，引用和否定不触发切换。"""
    return any(re.match(r'^(?:请|现在|我们)?(?:开始新任务|新任务[：:，,]|换个故事|换一个故事|另一个项目[：:，,]|重新开一部|上个任务结束|上一任务结束)', clause)
               for clause in _clauses(text))


def cancelled_delivery_plan(text):
    """只识别用户直接暂停旧创作要求；引用、解释和世界设定的取消另行处理。"""
    pattern = r'^(?:(?:请|先|现在|本轮|这次)\s*)*(?:不要|不用|不再)(?:再)?(?:按照|按|沿用|遵循)(?:我)?(?:之前|以前|此前|上次|上一轮)(?:的)?(?:(?:创作|交付|字数|付费卡点|卡点|节奏|集数|格式)(?:和|及|、|与)?)*要求'
    return next((fragment.strip() for clause in _clauses(text) for fragment in re.split(r'[，,]', clause)
                 if re.match(pattern, fragment.strip())), None)


def _delivery_text(text):
    """参考对象不成为交付目标；明确先做的阶段优先于随后扩写计划。"""
    without_references = re.sub(
        r'(?:根据|基于|参考|按照|对照|结合)[^，,。；;\n]{0,60}?(?:分集大纲|大纲|集纲|剧本|正文|原稿|前稿|方案|设定|资料|附件)', '', text)
    fragments = [part.strip() for part in re.split(r'[，,。；;\n]', without_references) if part.strip()]
    actions = [part for part in fragments if re.search(_CREATIVE_ACTION, part) and _DELIVERY_KIND.search(part)]
    first = next((part for part in actions if re.search(r'(?:^|现在|本轮)\s*先', part)), None)
    if first:
        first_kinds = {_OUTPUT_KINDS[item[0]] for item in _DELIVERY_KIND.finditer(first)}
        current = []
        for part in actions:
            kinds = {_OUTPUT_KINDS[item[0]] for item in _DELIVERY_KIND.finditer(part)}
            compatible = bool(kinds & first_kinds) or kinds | first_kinds <= {'outline','analysis'}
            if re.match(r'(?:之后|随后|然后|再|等)', part) and not compatible:
                break
            if compatible:
                current.append(part)
        return '，'.join(current)
    return '，'.join(actions) if actions else without_references


def _output_kind(text):
    if re.search(r'\banalysis\s*类型|类型\s*(?:为|是|[：:=])\s*analysis\b', text, re.I):
        return 'analysis'
    target = _delivery_text(text)
    matches = list(_DELIVERY_KIND.finditer(target))
    if not matches:
        return 'script'
    # 人设和故事梗概可以是一份提纲；短场景示例不会把方向分析变成整篇正文。
    kinds = {_OUTPUT_KINDS[item[0]] for item in matches}
    if kinds <= {'analysis','outline'}:
        return 'outline' if 'outline' in kinds else 'analysis'
    return _OUTPUT_KINDS[matches[-1][0]]


def _market(value):
    return 'North America' if re.fullmatch(r'北美(?:市场|受众)?|North America', value.strip(), re.I) else value


def _setting_facts(clause, known_names):
    """仅把用户明示的设定按主体拆开，局部纠正不能抹掉另一个人物或通用限制。"""
    facts = []
    for fragment in re.split(r'[，,]', clause):
        fragment = fragment.strip()
        if not fragment:
            continue
        if (re.search(r'世界|设定|规模|位面|神性身份|力量等级', fragment)
                and re.search(r'保持.*规模|不能扩大|不要扩大|不得扩大|越写越大|不(?:再)?扩展|不新增|不要新增', fragment)):
            facts.append(('semantic', 'world_scale', fragment, False))
            continue
        if re.search(r'不要越写越大|不要扩大|不得扩大', fragment):
            facts.append(('semantic', 'world_scale', fragment, False))
            continue
        if re.match(r'^(?:也)?(?:不能|不要|不得|不允许|禁止)', fragment):
            facts.append(('forbidden_mechanism', None, fragment, False))
            continue
        replacing = bool(re.search(r'改为|改成|换成|换为|调整为|不再使用', fragment))
        if re.search(r'(?:地点|世界范围|故事范围|场景范围|活动范围)\s*(?:只有|仅限|为|是|改为|限定在)', fragment):
            facts.append(('world', 'location', fragment, True))
            continue
        if re.search(r'故事世界|世界观|世界设定|架空世界|兽人世界|故事背景|时代背景|古代欧洲|不是现代|主题|题材', fragment) or re.search(r'(?:换成|换为|改成|改为|调整为)\s*(?:现代|现实|家庭|职场|悬疑|玄幻|奇幻|科幻|都市|历史|古装|喜剧|爱情|恐怖|战争|冒险|校园|犯罪)', fragment):
            subject = 'theme' if re.match(r'主题', fragment) else 'setting'
            facts.append(('world', subject, fragment, replacing))
            continue
        if re.match(r'不存在|世界中没有|世界里没有', fragment):
            facts.append(('world', 'mechanisms', fragment, True))
            continue
        instruction = re.search(r'人物名|角色名|固定|锁定|字数|语言|市场|受众', fragment)
        character = None if instruction else re.match(r'^(?P<declaration>(?:主角|角色|人物|同伴)\s*)?(?P<names>[\u4e00-\u9fffA-Za-z·与和及、]{1,48}?)(改为|改成|调整为|不是|并非|是|为)(.+)', fragment)
        if character:
            names = re.split(r'[与和及、]', character['names'])
            # 不能从任意“是/为”语句猜人物；后续无角色提示词的纠正只认已知姓名。
            if not character['declaration']:
                recognized = [name for name in names if name in known_names]
                if not recognized:
                    if re.search(r'(?:不是|并非)[^。！？]{0,30}(?:血亲|亲属|血统|家人|父亲|母亲|兄弟|姐妹)', fragment):
                        facts.append(('semantic', None, fragment, False))
                    continue
                if len(recognized) != len(names):
                    facts.append(('semantic', None, fragment, False))
                names = recognized
            known_names.update(names)
            for name in names:
                facts.append(('world', 'character:' + name, fragment, True))
    return facts


def _source_cells(direct):
    """核对范围与创作依据分别记录；未点名工作表时不猜默认表。"""
    cells = list(dict.fromkeys(re.findall(_CELL, direct))) if re.search(r'表格|单元格|Excel|excel|工作表', direct) else []
    result = {'requested_cells': cells}
    sheet = re.search(r'[“「\"]([^”」\"\n]+)[”」\"]\s*工作表|工作表\s*[“「\"]([^”」\"\n]+)[”」\"]', direct)
    if sheet:
        result['sheet'] = sheet[1] or sheet[2]
    basis = []
    quotes = []
    for fragment in re.split(r'[，,。；;\n]', direct):
        referenced = re.findall(_CELL, fragment)
        if referenced and re.search(r'替换(?:后)?剧情|替换后分集梗概|只以|仅以|作为.*依据', fragment):
            basis.extend(referenced)
            quotes.append(fragment.strip())
    if basis:
        result.update(basis_cells=list(dict.fromkeys(basis)), basis_quote='；'.join(quotes))
    return result


def _authored_request(body):
    from .capability_selection import _COMMAND, _COMMAND_BOUNDARY, _COMMAND_QUESTION
    # 旧客户端的直接能力指令只剥离已识别的名称，保留其后的真实写作要求。
    text = body
    while match := _COMMAND.match(text):
        tail = text[match.end():]
        if not _COMMAND_BOUNDARY.match(tail) or _COMMAND_QUESTION.search(tail.lstrip(' ，,:：')):
            break
        text = tail.lstrip(' ，,:：。.!！;；\n')
    for reference in parse_context_references(text):
        if reference.kind == 'file':
            text = text.replace(reference.raw, '')
    return text.strip()


def _read_only_intent(direct, *, question_only, exclusive_read):
    """只读来自请求动作或明确禁写，不由交付说明里的“检查/统计”等词触发。"""
    if question_only or exclusive_read:
        return True
    from .plain_documents import _delivery_requested
    if _delivery_requested(direct):
        # 禁止重新创作仍可明确交付已有正文；真正只读或禁导出由上层/交付解析拒绝。
        return False
    if re.search(r'(?:不|不要|不能|无需|禁止|不得)(?:再|重新)?(?:写稿|改稿|改写正文|重写正文|生成新稿|生成新集|保存(?:新)?稿件|保存新稿|另存|导出)', direct):
        return True
    prefix=r'(?:^|[。；;，,\n])\s*(?:(?:请|帮我|现在|本轮|本次|这轮|这一轮|先|再|重新|只|仅|做|实际)\s*)*'
    read_action=r'(?:只读|读取|阅读|回读|读完|查看|核对|核查|比对|检查|统计|分析|评估|审稿|解释|说明|记录(?:这些|这个|以下|上述))'
    return bool(re.search(prefix+read_action,direct))


def extract(source, previous_task, *, known_names=(), selected_agent=''):
    body = source['original_text']
    clauses = list(_clauses(body))
    direct = '\n'.join(clauses)
    operations = []
    pending = []
    known_names = set(known_names)

    def add(kind, value, quote, *, cancel=False, turn=False, origin='user_text', replace=False, subject=None):
        operations.append({'kind': kind, 'value': value, 'scope': _scope(quote, turn),
                           'quote': quote, 'action': 'cancel' if cancel else 'set', 'origin': origin,
                           'replace': replace, 'subject': subject})

    # GUI已保存的选择属于结构化用户设置，不能把包装段其它产品规则当要求。
    settings = source.get('wrapper_settings', {})
    for key in _SETTING_KINDS:
        if key in settings:
            add(key, _market(settings[key]) if key == 'target_market' else settings[key], f'{key}={settings[key]}', origin='studio_settings')
    if settings.get('region') and not settings.get('target_market'):
        add('target_market', _market(settings['region']), 'region=' + settings['region'], origin='studio_settings')
    if settings.get('language') and (language := _language(settings['language'])):
        add('dialogue_language', language, 'language=' + settings['language'], origin='studio_settings')
        if language == '中文':
            add('script_language', '简体中文', 'language=' + settings['language'], origin='studio_settings')

    affirmative = re.sub(rf'(?:不要|不能|不必|无需|禁止|不得|不)(?:再|重新)?{_CREATIVE_ACTION}[^。！？;；\n]*', '', direct)
    # 已选主 Agent 的“完整改编”是入口动作；先交付原作分析，不把附件或质疑提升为新阶段授权。
    from .agent_profiles import CAPABILITIES
    short_adaptation = bool(re.fullmatch(r'(?:请\s*)?完整改编[。！!\s]*', _authored_request(body)))
    creative = bool(re.search(rf'{_CREATIVE_ACTION}(?:完|好|一份|一下|下)?[^。！？\n]{{0,60}}{_DRAFT_TARGET}', affirmative)
                    or re.search(rf'(?:把|将){_DRAFT_TARGET}[^。！？\n]{{0,12}}{_EDIT_ACTION}', affirmative)
                    or re.search(rf'{_DRAFT_TARGET}[^。！？\n]{{0,12}}?{_TARGET_FIRST_ACTION}', affirmative)
                    # “你给的版本太中国修仙了……重新生成”“重新生成一版”：句末的重新生成就是要新稿。
                    or re.search(r'(?:重新|再)(?:生成|写|出|创作)(?:一版|一遍|一份|一下)?[。！!\s]*(?:$|\n)', affirmative)
                    or short_adaptation)
    question_only = bool(re.search(r'^(?:请(?:问)?)?(?:怎么|如何|为什么|解释|说明|教我)', affirmative.strip()))
    if question_only:
        creative = False
    continuation = bool(re.fullmatch(r'(?:请)?继续(?:写|下一集|上一任务|下一批)?[。！!\s]*', direct))
    # 系统建议卡片“按当前进度继续写下一批 3—4 集……”里“继续”不在句首，同样是要稿件。
    numbered_continuation = bool(re.search(rf'(?<![不别勿])(?<!不要|不用|暂停|停止)(?:继续|接着)(?:写|生成|输出|创作|撰写)?'
                                           rf'(?:第\s*{_NUMBER}\s*集|下一集|下一批|后面|后续)', affirmative))
    continuation = continuation or numbered_continuation
    if continuation:
        creative = creative or numbered_continuation or bool(previous_task.get('creative'))
    exclusive_read = bool(re.search(r'(?:^|[。；;\n])\s*(?:(?:本轮|本次|现在|请)\s*)?(?:只读|仅(?:做)?(?:核对|核查|比对|读取)|只(?:做)?(?:核对|核查|比对|读取))', direct))
    explicit_change = bool(re.search(rf'(?:^|[。；;，,\n])\s*(?:(?:请|然后|随后|再|读完后|阅读后|本轮|现在)\s*)*(?:再)?{_CREATIVE_ACTION}(?=第|这|该|正文|稿件|剧本|大纲|小说|前稿|原稿)', affirmative))
    if exclusive_read and not explicit_change:
        creative = False
    read_only = not creative and _read_only_intent(direct,question_only=question_only,exclusive_read=exclusive_read)
    output_kind = None
    if creative:
        output_kind = 'analysis' if short_adaptation else _output_kind(affirmative)
    elif read_only and re.search(r'分析|评估|审稿', direct):
        output_kind = 'analysis'
    if continuation and not re.search(r'大纲|集纲|梗概|人设|剧本|正文|小说|分镜|提示词|改编方向|analysis|方案', direct):
        output_kind = previous_task.get('output_kind') or output_kind
    delivery = _delivery_text(affirmative) if creative else direct
    requested_range = episode_range(delivery)
    target_quote = None
    if creative:
        # 肯定的创作动作决定交付目标；后文引用旧集或否定旧范围不能改写本轮目标。
        target_actions = list(re.finditer(
            rf'(?:{_CREATIVE_ACTION}|继续|接着)[^。；;，,\n]{{0,24}}?'
            rf'(?:第|前)?\s*{_NUMBER}(?:\s*(?:集\s*)?[—–－\-~至到]\s*第?\s*{_NUMBER})?\s*集', delivery))
        if target_actions:
            target_quote = target_actions[-1][0]
            requested_range = episode_range(target_quote)
    edit_range = None
    edit_marker = rf'(?:只|仅){_EDIT_ACTION}|只动'
    edit_clause = next((c for c in clauses if re.search(edit_marker, c)), None)
    if creative and edit_clause:
        # 修改目标只取肯定的“只改”片段，后面的“第1、2集不要动”仍完整保留作锁定依据。
        target_clause = re.search(rf'(?:{edit_marker})[^，,。；;]+', edit_clause)[0]
        pair = re.search(rf'第\s*({_NUMBER})\s*集\s*(?:第)?\s*({_NUMBER})\s*场', target_clause)
        scenes = [f'{number(pair[1])}-{number(pair[2])}'] if pair else re.findall(r'\b\d+-\d+场?', target_clause)
        edit_range = {'episodes': episode_range(target_clause), 'scenes': [s.removesuffix('场') for s in scenes], 'cells': []}
        if re.search(r'结尾|收尾|末尾',target_clause):edit_range['part']='ending'
        requested_range = edit_range['episodes']
        add('edit_range', edit_range, edit_clause, turn=True)
        operations[-1]['scope']['episodes'] = requested_range
    cell_source = _source_cells(direct)
    cells = cell_source['requested_cells']
    if creative and requested_range and not edit_range:
        add('episode_range', requested_range, target_quote or next((c for c in reversed(clauses) if episode_range(c)), direct), turn=True)
        operations[-1]['scope']['episodes'] = requested_range
    if creative and output_kind:
        add('output_kind', output_kind, next((c for c in clauses if re.search(_CREATIVE_ACTION, c)), direct), turn=True)

    for clause in clauses:
        if re.match(r'^(?:请)?(?:解释|说明|分析|评价|翻译|引用|复述|举例|例如|假如|如果)', clause) or re.search(r'是什么|什么意思|是否|能否|[？?]', clause):
            continue
        if not creative and re.search(r'不要(?:再|重新)?(?:写剧本|改写正文|修改要求|保存|导出)|只读', clause):
            continue
        operation_start = len(operations)
        cancelled = bool(re.match(r'^(?:请)?(?:取消|撤销|去掉|不再要求|解除)', clause))
        if cancelled:
            if re.search(r'字数|每集.*(?:字|字符)', clause):
                add('min_words', None, clause, cancel=True)
            elif re.search(r'锁名|名称锁|人物名.*(?:固定|锁)|固定.*(?:人物|船名)', clause):
                add('locked_names', None, clause, cancel=True)
            elif re.search(r'对白语言|台词语言|提示词语言|剧本语言|正文语言|目标市场|世界设定', clause):
                kinds = [('dialogue_language', '对白语言|台词语言'), ('prompt_language', '提示词语言'),
                         ('script_language', '剧本语言|正文语言'), ('target_market', '目标市场'), ('world', '世界设定')]
                for kind, marker in kinds:
                    if re.search(marker, clause):
                        add(kind, None, clause, cancel=True)
            elif re.search(r'禁止|禁用|不要|不得|不能', clause):
                target = re.sub(r'^(?:请)?(?:取消|撤销|去掉|不再要求|解除)(?:关于|对)?', '', clause)
                target = re.sub(r'(?:的)?(?:要求|限制|设定|规定)[。.!！]?$', '', target)
                add('forbidden_mechanism', target, clause, cancel=True)
            elif re.search(r'原稿|附件|资料|读取要求', clause):
                add('source_read', None, clause, cancel=True)
            else:
                pending.append({'quote': clause, 'reason': '取消对象不唯一，未清除已有要求'})
            continue
        numeric_text = re.sub(r'“[^”]*”|「[^」]*」|"[^"\n]*"|`[^`\n]*`', '', clause)
        count_range = episode_range(numeric_text) or requested_range or previous_task.get('episode_range')
        per_episode = bool(re.search(r'每集|各集', numeric_text))
        single_episode = count_range and count_range[0] == count_range[1]
        count_subject = rf'(?:每集|各集|本集|正文|第\s*{_NUMBER}\s*集)'
        numeric = re.search(rf'{count_subject}[^。！？]{{0,22}}?(?:不少于|不低于|至少|最低|>=)\s*({_NUMBER})\s*(?:个)?(?:汉字|字|字符)', numeric_text)
        bounds = re.search(rf'{count_subject}[^。！？]{{0,18}}?({_NUMBER})\s*[—–－\-~至到]\s*({_NUMBER})\s*(?:个)?(?:汉字|字|字符)', numeric_text)
        maximum = re.search(rf'{count_subject}[^。！？]{{0,22}}?(?:不超过|最多|至多|上限(?:为|是)?|<=)\s*({_NUMBER})\s*(?:个)?(?:汉字|字|字符)', numeric_text)
        if (per_episode or single_episode) and (numeric or bounds or maximum):
            value = {'minimum': number(numeric[1] if numeric else bounds[1]) if numeric or bounds else 0,
                     'metric': 'non_whitespace_characters' if re.search(r'非空白|含标点|不含空格', clause) else 'han_characters',
                     'metric_source': 'explicit' if re.search(r'汉字|非空白|含标点|不含空格', clause) else 'default', 'unit': 'per_episode'}
            if bounds:
                value['maximum'] = number(bounds[2])
            elif maximum:
                value['maximum'] = number(maximum[1])
            if value.get('maximum', value['minimum']) > 0 and value.get('maximum', value['minimum']) >= value['minimum']:
                add('min_words', value, clause)
                if not per_episode:
                    operations[-1]['scope']['episodes'] = count_range
        market = re.search(r'(?:目标市场|目标受众|受众|target_market)\s*(?:[：:=]|是|为)\s*([^。；;，,]+)', clause)
        if market:
            value = market[1].strip()
            add('target_market', 'North America' if re.fullmatch(r'北美(?:市场|受众)?|North America', value, re.I) else value, clause)
        for kind, prefix in [('script_language', r'剧本语言|正文语言|script_language'), ('dialogue_language', r'对白语言|对白|台词语言|dialogue_language'), ('prompt_language', r'生成提示词语言|图片提示词语言|视频提示词语言|提示词语言|prompt_language')]:
            match = re.search(rf'(?:{prefix})\s*(?:[：:=]|仅|只用|使用|用|是|为)\s*(.+)', clause)
            if match and (language := _language(match[1])):
                add(kind, '简体中文' if kind == 'script_language' and language == '中文' else language, clause)
        theme_change = bool(re.search(r'(?:换成|换为|改成|改为|调整为)\s*(?:现实|家庭|职场|悬疑|玄幻|奇幻|科幻|都市|历史|古装|喜剧|爱情|恐怖|战争|冒险|校园|犯罪)', clause))
        for kind, subject, quote, replacing in _setting_facts(clause, known_names):
            add(kind, quote, quote, replace=replacing, subject=subject)
        for fragment in re.split(r'[，,]', clause):
            fragment = fragment.strip()
            if (not theme_change and re.match(r'^(?:请)?(?:不要|禁止|不得|不能|不允许)', fragment)
                    and not re.search(r'写剧本|修改|重写|保存|生成|导出|越写越大', fragment)):
                add('forbidden_mechanism', fragment, fragment)
        lock = re.search(r'(?:人物名|角色名|船名|名称)\s*(?:固定为|锁定为|必须保持|保持为)\s*(.+)', clause)
        if lock:
            names = re.findall(r'[“「"]([^”」"]+)[”」"]', lock[1]) or [x.strip(' 。') for x in re.split(r'[、，,]', lock[1]) if x.strip(' 。')]
            add('locked_names', names, clause)
            known_names.update(names)
        if len(operations) == operation_start and re.search(r'必须|不得|不要|保持|要求|约定|擅长|能力分工|始终|没有秘密身份|每集|每十集|固定|只能|人物关系|人物性格|角色关系|叙事|题材|风格|设定|希望|侧重|突出|围绕|(?:主角|角色|人物)[^。！？]{0,20}(?:是|为|没有|只有)', clause):
            # 不确定规则仍有原句出处，交给语义审稿，不凭关键词宣布满足或违规。
            deliverable = bool(re.search(_CREATIVE_ACTION, clause) and _DELIVERY_KIND.search(_delivery_text(clause)))
            add('semantic', clause, clause, turn=deliverable, subject='requested_deliverable' if deliverable else None)
    if creative or read_only:
        source_scope = {'lifetime': 'turn' if re.search(r'仅本轮|仅本次|只在本轮|只在本次', direct) else 'conversation',
                        'episodes': None, 'document_id': None}
        for ref in parse_context_references(body):
            if ref.kind == 'file':
                add('source_read', {'path': ref.target, **cell_source}, ref.raw)
                operations[-1]['scope'] = dict(source_scope)
        for identifier in re.findall(r'(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])', body):
            if re.search(r'稿件|文档|正文', direct):
                add('source_read', {'source_id': identifier, **cell_source}, identifier)
                operations[-1]['scope'] = dict(source_scope)
    if creative:
        authored = _authored_request(body)
        if len(authored) <= 8000:
            add('semantic', authored, authored, turn=True, subject='current_user_request')
        else:
            pending.append({'quote': '', 'reason': '用户本轮原文超过8000字，完整总体要求尚未纳入语义核验，不得把截断片段当作完整要求'})
    correction_only = not creative and bool(re.search(r'记录.*(?:修正|纠正|修改)|(?:修正|纠正).*记录|本轮不要改稿', direct))
    task = {'creative': creative, 'read_only': read_only, 'output_kind': output_kind,
            'episode_range': requested_range, 'edit_range': edit_range, 'source_query': body if creative or read_only else '',
            'requested_cells': cells, 'correction_only': correction_only}
    return operations, task, pending

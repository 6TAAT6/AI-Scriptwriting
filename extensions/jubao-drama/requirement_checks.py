"""从稿件与来源回执核对客观要求；未证实的语义要求交给独立审核。"""

from collections import Counter, defaultdict
import hashlib
import re

from .document_evidence import _counts, _EPISODE_HEADING, episode_span
from .manuscript_text import visible_manuscript


# 公开回执和质量检查共用集标题与正文口径；质量检查不沿用20集展示上限。
_HEADING = _EPISODE_HEADING
_SCENE = re.compile(r'(?m)^[\t #*]*(\d{1,4})[-—.](\d{1,4})(?:场)?[.．、]?(?=[\t :：]|$)[^\n]*(?:\n|$)')
_DIGITS = dict(zip('〇零一二三四五六七八九两', (0,0,1,2,3,4,5,6,7,8,9,2)))


def _number(text):
    if text.isascii() and text.isdigit():
        return int(text)
    total = digit = 0
    for char in text:
        if char in _DIGITS:
            digit = _DIGITS[char]
        elif char in '十百千':
            total += (digit or 1) * {'十':10,'百':100,'千':1000}[char]
            digit = 0
        else:
            return None
    return total + digit


def _episodes(content):
    visible, offsets = visible_manuscript(content)
    headings = list(_HEADING.finditer(visible))
    rows = []
    for index, heading in enumerate(headings):
        visible_end = headings[index+1].start() if index+1 < len(headings) else len(visible)
        start = offsets[heading.start()]
        end = offsets[visible_end] if visible_end < len(offsets) else len(content)
        body_start, body_end = episode_span(visible, headings, index)
        rows.append({'episode_number':_number(heading[1]),'start':start,'end':end,
                     'body':visible[body_start:body_end], 'text':content[start:end]})
    return rows


# 剧本集的标志：场次号（1-1、第1场）、动作行（△）或连续的“人物：台词”行；【剧情脉络】这类大纲栏目不算台词。
_SCENE_MARK = re.compile(r'(?m)^[\t #*>]*(?:\d{1,3}\s*[-—–]\s*\d{1,3}(?!\d)|第\s*\d{1,3}\s*场|[△▲])')
_SCRIPT_DIALOGUE = re.compile(r'(?m)^[\t ]*[^\s：:（(△▲【\[*#>\-]{1,12}(?:[（(][^）)\n]{0,24}[）)])?[\t ]*[：:][\t ]*\S')


def script_like(body):
    return bool(_SCENE_MARK.search(body) or len(_SCRIPT_DIALOGUE.findall(body)) >= 3)


def _script_episodes(episodes):
    """剧本稿件里混入的分集大纲不按剧本正文核验。

    员工要“完整改编剧本”时，模型常把项目档案、全剧分集大纲和前几集剧本写在同一份稿件里一起保存
    （重放《十年劫》：80 条每集几十字的大纲被按剧本 900—1100 字核验，返修三次、耗时十分钟）。
    有场次、动作行或连续台词的集才是剧本集；整份稿件没有一集符合时维持原判，格式不规范的剧本照常核验。
    """
    scripted = [row for row in episodes if script_like(row['body'])]
    return scripted or episodes


def _range(value):
    if (not isinstance(value, (list,tuple)) or len(value)!=2
            or any(type(n) is not int for n in value) or not 0 < value[0] <= value[1] <= 9999):
        return None
    return set(range(value[0],value[1]+1))


def _result(requirement, status, actual=None, target=None, issues=None, evidence=None):
    problems = [{**issue,'requirement_id':requirement.get('id'),'kind':requirement.get('kind')}
                for issue in issues or []]
    return {'requirement_id':requirement.get('id'),'kind':requirement.get('kind'),'status':status,
            'actual':actual,'target':target,'evidence':evidence or {},'issues':problems}


# 员工本轮明说不动的集（“第6集保持不变”“第4集和第5集现有的修改内容不变”“第6集一字不改”）。2026-11-19 测试版：
# 用户要求“第6集保持不变”，长期“每集1000—1200字”仍要求删第6集，模型照删后语义审稿又判违反“不变”。
# 中间不跨逗号：“重写第6集，其他不变”里的第6集正是要改的集。
_KEEP_NUMBER = r'[0-9一二三四五六七八九十百零〇两]{1,4}'
_KEEP = re.compile(rf'第\s*({_KEEP_NUMBER})\s*集?((?:\s*[、和与及跟]\s*第?\s*{_KEEP_NUMBER}\s*集?)*)'
                   r'[^。；;！!？?\n，,]{0,12}?(?:保持不变|维持不变|保持原样|保留原样|原样保留|一字不改|不要动|别动|不动|不变|不改|不要改)')


def kept_episodes(text):
    kept = set()
    for match in _KEEP.finditer(text or ''):
        for value in (match[1], *re.findall(_KEEP_NUMBER, match[2] or '')):
            if number := _number(value):
                kept.add(number)
    return kept


def _word_check(req, content, episodes, requirements, requested, kept=frozenset()):
    value = req.get('value') or {}
    if not isinstance(value,dict):
        return _result(req,'unverified',issues=[{'code':'invalid_word_contract'}])
    metric = value.get('metric')
    minimum,maximum = value.get('minimum'),value.get('maximum')
    if (metric not in {'han_characters','non_whitespace_characters'}
            or minimum is not None and (type(minimum) is not int or minimum < 0)
            or maximum is not None and (type(maximum) is not int or maximum < 0)
            or minimum is None and maximum is None
            or minimum is not None and maximum is not None and minimum > maximum):
        return _result(req,'unverified',target=value,issues=[{'code':'unresolved_word_metric_or_limit'}])
    selected = _range((req.get('scope') or {}).get('episodes'))
    overrides=set()
    if value.get('unit')=='per_episode':
        for other in requirements:
            if other.get('kind')=='min_words' and other.get('status','active')=='active':
                narrower=_range((other.get('scope') or {}).get('episodes'))
                if narrower and (selected is None or narrower < selected):
                    overrides.update(narrower)
    if requested is not None:
        # 本轮只交付或只修改指定集数时，长期字数要求只核对这些集；未改动的集保持原样，不因旧稿判不达标。
        selected = set(requested) if selected is None else selected & requested
    if kept and value.get('unit') == 'per_episode':
        selected = (selected if selected is not None else {row['episode_number'] for row in episodes}) - kept
        if not selected and episodes:
            return _result(req, 'pass', [], value, evidence={'kept_unchanged': sorted(kept),
                                                            'scope': '本轮核对的集均由用户要求保持不变，不按通用字数要求改动'})
    # 每集段数（非空行）一并给出：模型按比例增删段落比按字数估算准（重放中按字数返修常在超长与不足之间来回）。
    # 句数供大纲这类每集只有一两段的稿件按句增删。
    targets = [{'episode':row['episode_number'],'actual':_counts(row['body'])[metric],
                'lines':sum(1 for line in row['body'].splitlines() if line.strip()),
                'sentences':len(re.findall(r'[。！？!?…]+', row['body']))}
               for row in episodes if (selected is None or row['episode_number'] in selected) and row['episode_number'] not in overrides]
    if value.get('unit') not in {'per_episode','document','whole_document'}:
        return _result(req,'unverified',target=value,issues=[{'code':'unresolved_word_unit'}])
    if value.get('unit') != 'per_episode':
        targets = [{'actual':_counts(content)[metric]}]
    if not targets:
        # 本次核对的集（全部集，或只交付/只修改的那几集）都由更具体的局部字数要求覆盖时，通用要求视为已由局部要求核验。
        covered = selected if selected is not None else {row['episode_number'] for row in episodes}
        if episodes and overrides and covered and covered <= overrides:
            return _result(req,'pass',[],value,evidence={'superseded_by_scoped_requirements':sorted(overrides),
                                                       'scope':'本次提交的目标集按其明确局部字数要求核验，通用要求保留于其他集'})
        return _result(req,'unverified',target=value,issues=[{'code':'no_recognized_target_body'}])
    issues=[]
    if value.get('unit') == 'per_episode' and selected is not None:
        missing=selected-overrides-{item['episode'] for item in targets}
        if missing:issues.append({'code':'missing_scoped_episodes','episodes':sorted(missing)})
    for item in targets:
        count=item['actual']
        # 用户明确的区间是严格边界；“约/左右”的容差只在 length_rules 解析时写入合同。
        if minimum is not None and count < minimum:
            issues.append({**item,'code':'below_minimum','target':minimum,'difference':minimum-count})
        if maximum is not None and count > maximum:
            issues.append({**item,'code':'above_maximum','target':maximum,'difference':count-maximum})
    return _result(req,'fail' if issues else 'pass',targets,value,issues,
                   {'metric':metric,'metric_source':value.get('metric_source','explicit'),
                    'scope':'每集正文排除集标题，包含场头、人物、动作与对白；全文指标覆盖完整输入'})


_FINALE = re.compile(r'大结局|全剧终|全剧完|全文完|（完）|\(完\)|剧终|THE\s*END|完结篇', re.I)


def _outline_finale_for_episode(text, number):
    """结局标记只约束当前集；明确留待后续揭晓的预告不算已经完结。"""
    for finale in _FINALE.finditer(text):
        prefix = text[:finale.start()]
        suffix = text[finale.end():]
        if finale.group() == '大结局' and (
                re.search(r'(?:留待|等待|等到|直到|待)$', prefix) and re.match(r'揭晓|揭幕|揭开|解答', suffix)
                or re.search(r'(?:为|给)$', prefix) and re.match(r'铺垫|蓄势', suffix)
                or re.match(r'前夜|之前|前夕', suffix)):
            continue
        numbers = list(re.finditer(r'第\s*([0-9]{1,4}|[〇零一二两三四五六七八九十百千]{1,8})\s*集', prefix))
        if not numbers:
            return True
        current = _number(numbers[-1].group(1))
        if current == number:
            return True
    return False


def _series_check(req, episodes, kind):
    """全剧共N集时，第N集之前不能写成结局，也不能出现超过N的集数（正式版三位员工都遇到过“47集的剧35集就大结局”）。"""
    total = (req.get('value') or {}).get('total')
    if type(total) is not int or kind not in {'script','outline','novel'}:
        return _result(req,'pass',evidence={'scope':'只核对剧本、大纲与小说的集数'})
    issues = []
    for row in episodes:
        number = row['episode_number']
        if number is None:
            continue
        lines = [line for line in row['text'].splitlines() if line.strip()]
        # 只看集标题与集尾几行：正文中人物提到“大结局”不算。分集大纲常在同一
        # 段落后附带“第38—47集卡点 / 第47集大结局”的规划元数据；这种行不属于
        # 当前集，只有出现当前集号的结局标记才算提前收尾。
        if kind == 'outline':
            ends_here = any(_outline_finale_for_episode(line, number) for line in lines[:1] + lines[-6:])
        else:
            ends_here = bool(_FINALE.search('\n'.join(lines[:1] + lines[-3:])))
        if number > total:
            issues.append({'code':'beyond_series_end','episode':number,'target':total})
        elif number < total and ends_here:
            issues.append({'code':'premature_finale','episode':number,'target':total})
    return _result(req,'fail' if issues else 'pass',[row['episode_number'] for row in episodes],total,issues)


_NOVEL = re.compile(r'如同|仿佛|宛如|犹如|好似|宛若|恍若|空气中(?:弥漫|充斥|凝固)|眼底(?:掠过|闪过|划过|浮现|翻涌)|'
                    r'眸(?:中|底|光)(?:闪过|掠过|翻涌|一沉|一暗)|心(?:中|底|头)(?:一沉|一紧|一颤|一震|暗想|涌起|泛起|翻涌)|'
                    r'一丝(?:不易察觉|难以察觉|复杂|深沉|异样)')
_DIALOGUE_LINE = re.compile(r'^\s*[^\s△▲【（(：:]{1,12}(?:[（(][^）)]{0,20}[）)])?\s*[：:]')


def _prose_check(req, episodes, kind):
    """用户要求不要小说化时，逐行找出动作、环境行里的比喻与心理描写；台词里的说法不算。"""
    if kind != 'script':
        return _result(req,'pass',evidence={'scope':'只核对剧本正文'})
    issues = []
    for row in episodes:
        lines = [line.strip() for line in row['body'].splitlines() if line.strip() and not _DIALOGUE_LINE.match(line)]
        hits = [(line, match.group(0)) for line in lines for match in _NOVEL.finditer(line)]
        if len(hits) >= 2:
            issues.append({'code':'novelistic_prose','episode':row['episode_number'],'terms':[term for _, term in hits][:6],
                           'lines':[line[:60] for line, _ in hits][:3]})
    return _result(req,'fail' if issues else 'pass',None,'no_novelistic',issues)


_ENDING = re.compile(r'(?:[。！？!?…」”’）)\]】~—.*＊]|全剧终|剧终|本集完|未完待续|待续|完|END|end|黑屏|切黑|定格)\s*$')


def _complete_ending_check(episodes, kind):
    """稿件最后一集停在句子中间（模型输出被截断）时判不完整；只看最后一集，标题行与场头不算结尾。"""
    if kind != 'script' or not episodes:
        return None
    lines = [line.strip() for line in episodes[-1]['body'].splitlines() if line.strip()]
    if len(lines) < 3 or _ENDING.search(lines[-1]) or _SCENE.match(lines[-1] + '\n'):
        return None
    requirement = {'id': 'builtin:complete-ending', 'kind': 'complete_ending'}
    return _result(requirement, 'fail', lines[-1][-20:], 'complete_ending',
                   [{'code': 'truncated_ending', 'episode': episodes[-1]['episode_number'], 'tail': lines[-1][-20:]}])


def merge_revised_episodes(base, revised):
    """返修时只重写了部分集（含补上上一稿缺的集）：按集号替换或插入到上一稿，其余集保持原文。

    返回合并后的全文；修订稿重写了上一稿的全部集、或无法识别集号时返回 None（按修订稿原样保存）。
    """
    old, new = _episodes(base or ''), _episodes(revised or '')
    old_numbers = [row['episode_number'] for row in old]
    new_numbers = [row['episode_number'] for row in new]
    if (not new or not old or None in old_numbers or None in new_numbers or len(set(old_numbers)) != len(old_numbers)
            or len(set(new_numbers)) != len(new_numbers) or not set(old_numbers) - set(new_numbers)):
        return None
    pieces = {row['episode_number']: base[row['start']:row['end']].rstrip() for row in old}
    pieces.update({row['episode_number']: revised[row['start']:row['end']].rstrip() for row in new})
    head = base[:old[0]['start']]
    tail_end = old[-1]['end']
    return (head + '\n\n'.join(pieces[number] for number in sorted(pieces)) + base[tail_end:]).strip() + '\n'


def _episode_check(req, episodes):
    expected = _range(req.get('value'))
    actual = [row['episode_number'] for row in episodes]
    if expected is None:
        return _result(req,'unverified',actual,req.get('value'),[{'code':'invalid_episode_range'}])
    duplicates = [number for number,count in Counter(actual).items() if count > 1]
    issues=[]
    for code,values in [('missing_episodes',sorted(expected-set(actual))),
                        ('unexpected_episodes',sorted(set(actual)-expected)),('duplicate_episodes',duplicates)]:
        if values:issues.append({'code':code,'episodes':values})
    if actual and actual != sorted(actual):issues.append({'code':'episode_order','episodes':actual})
    return _result(req,'fail' if issues else 'pass',actual,sorted(expected),issues)


def _kind_check(req, kind):
    expected=req.get('value')
    if not isinstance(expected,str):
        return _result(req,'unverified',kind,expected,[{'code':'invalid_output_kind'}])
    return _result(req,'pass' if kind==expected else 'fail',kind,expected,
                   [] if kind==expected else [{'code':'output_kind_mismatch','actual':kind,'target':expected}],
                   {'scope':'交付类型字段；是否为合格正文仍需独立语义审核'})


def _same_owner(record, contract):
    return (isinstance(record,dict) and bool(contract.get('home_key')) and bool(contract.get('session_id'))
            and record.get('home_key')==contract['home_key'] and record.get('session_id')==contract['session_id'])


def ending_boundaries(content, value):
    """用户只授权结尾；宿主保守边界不扩大为整场或整集，也不拆开一个完整段落。"""
    allowed=_range(value.get('episodes'))
    if value.get('part')!='ending' or allowed is None:return []
    boundaries=[]
    for episode in _episodes(content):
        if episode['episode_number'] not in allowed:continue
        text=episode['text'];visible,offsets=visible_manuscript(text)
        heading=_HEADING.search(visible)
        if not heading:return []
        body_start=heading.end();body_end=len(visible.rstrip())
        visible_body=body_end-body_start
        scenes=list(_SCENE.finditer(visible))
        lower=max(body_start+(visible_body*4+4)//5,scenes[-1].end() if scenes else body_start)
        # 空行分隔段落；无空行的常见剧本及HTML按独立显示行保留动作/对白单元。
        pattern=r'[^\n]+(?:\n(?!\n)[^\n]+)*' if '\n\n' in visible else r'(?m)^[^\n]+'
        paragraphs=[match for match in re.finditer(pattern,visible) if match[0].strip() and match.start()>=lower]
        paragraphs=paragraphs[-4:]
        if not paragraphs or paragraphs[-1].end()<body_end:
            boundaries.append({'episode':episode['episode_number'],'origin':'host_boundary','status':'unresolved',
                               'reason':'末尾完整段落超过可见正文末20%或无法确定完整结尾，需要明确允许扩大范围。'})
            continue
        start=offsets[paragraphs[0].start()]
        prefix=text[:start]
        boundaries.append({'episode':episode['episode_number'],'origin':'host_boundary','status':'resolved',
                           'rule':'最多4个末尾非空段落，位于最后一场且不超过可见正文末20%；段落之前原文逐字保留。',
                           'start_char':start,'start_line':prefix.count('\n')+1,'locked_prefix_lines':prefix.count('\n'),
                           'locked_prefix_sha256':hashlib.sha256(prefix.encode()).hexdigest(),
                           'locked_prefix':prefix,'original_ending':text[start:],
                           'paragraph_count':len(paragraphs),'visible_body_characters':visible_body,
                           'editable_characters':body_end-paragraphs[0].start()})
    return boundaries


def _ending_check(value,old,candidate):
    boundaries=ending_boundaries(old,value)
    if not boundaries or any(row['status']!='resolved' for row in boundaries):
        return 'unverified',[{'code':'ending_boundary_unresolved'}],boundaries
    issues=[]
    for boundary in boundaries:
        text=candidate.get(boundary['episode'],'')
        if not text.startswith(boundary['locked_prefix']):
            issues.append({'code':'changed_before_ending_boundary','episode':boundary['episode'],
                           'start_line':boundary['start_line'],'locked_prefix_sha256':boundary['locked_prefix_sha256']})
        elif not text[boundary['start_char']:].strip():
            issues.append({'code':'ending_removed','episode':boundary['episode']})
    return 'fail' if issues else 'pass',issues,boundaries


def _edit_check(req, content, contract, baseline):
    if not _same_owner(baseline,contract) or not isinstance(baseline.get('content'),str):
        return _result(req,'unverified',issues=[{'code':'missing_or_foreign_baseline'}])
    old=baseline['content'];digest=hashlib.sha256(old.encode()).hexdigest()
    if baseline.get('content_sha256') and baseline['content_sha256'] != digest:
        return _result(req,'unverified',issues=[{'code':'baseline_hash_mismatch'}])
    requested_doc=(req.get('scope') or {}).get('document_id')
    if requested_doc and baseline.get('document_id')!=requested_doc:
        return _result(req,'unverified',issues=[{'code':'baseline_document_mismatch'}])
    value=req.get('value') or {};allowed=_range(value.get('episodes')) if isinstance(value,dict) else None
    if allowed is None:
        return _result(req,'unverified',issues=[{'code':'unresolved_edit_range'}])
    before,after=_episodes(old),_episodes(content)
    if not before or not after or any(count>1 for rows in [before,after] for count in Counter(r['episode_number'] for r in rows).values()):
        return _result(req,'unverified',issues=[{'code':'ambiguous_baseline_episode_structure'}])
    source={r['episode_number']:r['text'] for r in before};candidate={r['episode_number']:r['text'] for r in after}
    target_only=(set(candidate)==allowed and allowed<set(source)
                 and [row['episode_number'] for row in after]==[row['episode_number'] for row in before if row['episode_number'] in allowed]
                 and not content[:after[0]['start']].strip())
    if target_only:
        # 独立保存目标集不会改写旧版本；组装仅用于检查，范围外仍取原稿原字节。
        parts=[old[:before[0]['start']]]
        for row in before:
            text=candidate.get(row['episode_number'],row['text'])
            if row['text'].endswith('\n') and not text.endswith('\n'):text+='\n'
            parts.append(text)
        content=''.join(parts);after=_episodes(content)
        candidate={row['episode_number']:row['text'] for row in after}
    issues=[{'code':'changed_outside_edit_range','episode':number}
            for number in sorted(set(source)|set(candidate)) if number not in allowed and source.get(number)!=candidate.get(number)]
    if [row['episode_number'] for row in before] != [row['episode_number'] for row in after]:
        issues.append({'code':'episode_sequence_changed_during_edit',
                       'actual':[row['episode_number'] for row in after],
                       'target':[row['episode_number'] for row in before]})
    for number in sorted(set(source)^set(candidate)):
        if number in allowed:issues.append({'code':'episode_added_or_removed_during_edit','episode':number})
    if old[:before[0]['start']] != content[:after[0]['start']]:issues.append({'code':'changed_outside_edit_range','part':'preamble'})
    scenes=value.get('scenes') or []
    if scenes:
        # 以实际场头切片，只替换允许场的正文；其余字节必须完全一致。
        masks=[]
        for text in [old,content]:
            visible, offsets = visible_manuscript(text)
            found=list(_SCENE.finditer(visible));parts=[];cursor=0;seen=set()
            for index,match in enumerate(found):
                label=f'{int(match[1])}-{int(match[2])}'
                if label not in scenes:continue
                visible_end=found[index+1].start() if index+1<len(found) else len(visible)
                following_episode=_HEADING.search(visible,match.end())
                if following_episode:visible_end=min(visible_end,following_episode.start())
                start=offsets[match.start()]
                end=offsets[visible_end] if visible_end<len(offsets) else len(text)
                parts.extend([text[cursor:start],f'\x00允许场:{label}\x00']);cursor=end;seen.add(label)
            parts.append(text[cursor:]);masks.append((''.join(parts),seen))
        if any(seen!=set(scenes) for _,seen in masks):
            return _result(req,'fail' if issues else 'unverified',issues=[*issues,{'code':'missing_requested_scene','scenes':scenes}])
        if masks[0][0]!=masks[1][0]:issues.append({'code':'changed_outside_scene_range','scenes':scenes})
    ending_status='pass';boundaries=[]
    if value.get('part')=='ending':
        ending_status,ending_issues,boundaries=_ending_check(value,old,candidate)
        issues.extend(ending_issues)
    result_status='fail' if any(i['code']!='ending_boundary_unresolved' for i in issues) else ending_status
    return _result(req,result_status,target=value,issues=issues,
                   evidence={'baseline_document_id':baseline.get('document_id'),'baseline_sha256':digest,
                             'ending_boundaries':boundaries,
                             'delivery_mode':'target_only' if target_only else 'full_document',
                             'preserved_episodes':sorted(set(source)-allowed) if target_only else [],
                             'comparison':'范围外原文字节相等，不自动去空白或重排'})


def _cells(ranges):
    selected=set()
    for value in ranges:
        match=re.fullmatch(r'\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6}))?',str(value))
        if not match:return None
        def column(text):
            result=0
            for char in text.upper():result=result*26+ord(char)-64
            return result
        left,top=column(match[1]),int(match[2]);right,bottom=column(match[3] or match[1]),int(match[4] or match[2])
        if right<left or bottom<top or right>16384 or bottom>1048576 or len(selected)+(right-left+1)*(bottom-top+1)>200000:return None
        for x in range(left,right+1):
            letters='';number=x
            while number:number,remainder=divmod(number-1,26);letters=chr(65+remainder)+letters
            selected.update(f'{letters}{y}' for y in range(top,bottom+1))
    return selected


def _read_check(req, contract, evidence):
    value=req.get('value') or {}
    if not isinstance(value,dict) or not any(value.get(k) for k in ['path','source_id','document_id']):
        return _result(req,'unverified',issues=[{'code':'unresolved_source_identity'}])
    ranges=value.get('requested_cells') or ([value['range']] if value.get('range') else [])
    grouped=defaultdict(list)
    for row in evidence or []:
        if not _same_owner(row,contract):continue
        if value.get('path') and row.get('path')!=value['path']:continue
        doc=value.get('document_id') or value.get('source_id')
        if doc and doc not in {row.get('document_id'),row.get('source_id')}:continue
        if value.get('sheet') and row.get('sheet')!=value['sheet']:continue
        if row.get('coverage_complete') is not True:continue
        digest=row.get('file_sha256') or row.get('content_sha256')
        if not isinstance(digest,str) or not re.fullmatch(r'[a-f0-9]{64}',digest):continue
        if any(value.get(key) and row.get(key)!=value[key] for key in ['file_sha256','content_sha256']):continue
        # 不同矩形的内容摘要自然不同；单元格页用同一文件摘要与工作表确认版本。
        version=(row.get('file_sha256'),row.get('sheet')) if ranges else (digest,row.get('content_sha256'),row.get('sheet'))
        if ranges and not row.get('file_sha256'):continue
        if not ranges and row.get('cells') is not None:continue
        grouped[version].append(row)
    if ranges:
        expected=_cells(ranges if isinstance(ranges,list) else [ranges])
        if expected is None or not expected:
            return _result(req,'unverified',issues=[{'code':'invalid_source_cell_range'}])
        best=set()
        for group in grouped.values():
            actual={str(cell.get('cell','')).upper().replace('$','') for row in group for cell in row.get('cells',[]) if isinstance(cell,dict)}
            if len(actual&expected)>len(best&expected):best=actual
            if expected<=actual:return _result(req,'pass',{'covered_cells':sorted(expected)},value,
                                              evidence={'file_sha256':group[0].get('file_sha256'),'sheet':group[0].get('sheet')})
        return _result(req,'unverified',{'covered_cells':sorted(best&expected)},value,
                       [{'code':'source_read_incomplete','missing_cells':sorted(expected-best)}])
    for group in grouped.values():
        total=group[0].get('characters');cursor=0
        if type(total) is not int or total<0:continue
        intervals=sorted((row.get('start_char'),row.get('end_char')) for row in group
                         if type(row.get('start_char')) is int and type(row.get('end_char')) is int and row.get('characters')==total)
        for start,end in intervals:
            if start<0 or end<start or start>cursor:break
            cursor=max(cursor,end)
        if cursor>=total:return _result(req,'pass',{'covered_characters':total},value)
    return _result(req,'unverified',target=value,issues=[{'code':'source_read_not_proven'}])


def check_draft(content, kind, contract, baseline=None, read_evidence=None):
    """不执行IO、不修改合同、原文或稿件；调用方提供已验证来源的快照和回执。"""
    if not isinstance(content,str) or not isinstance(contract,dict):
        return {'status':'unverified','checks':[],'issues':[{'code':'invalid_draft_or_contract'}],
                'semantic_requirements':[],'statistics':{}}
    source=content.replace('\r\n','\n').replace('\r','\n');episodes=_episodes(source)
    if kind=='script':
        episodes=_script_episodes(episodes)
    visible,_=visible_manuscript(source)
    statistics={'method':'unicode_han_and_non_whitespace_v1','scope':'全文及全部识别集正文，不截断分集明细',
                'source_sha256':hashlib.sha256(source.encode()).hexdigest(),**_counts(visible),
                'text_scope':'HTML按可见正文统计，原始稿件摘要不去标签',
                'episode_count':len(episodes),'episodes_truncated':False,
                'episodes':[{'episode_number':row['episode_number'],**_counts(row['body'])} for row in episodes]}
    checks=[];semantic=[]
    task=contract.get('current_task') or {}
    requested=_range((task.get('edit_range') or {}).get('episodes') or task.get('episode_range'))
    kept=kept_episodes((contract.get('source') or {}).get('original_text'))
    dispatch={'min_words':lambda req:_word_check(req,visible,episodes,contract.get('active_requirements',[]),requested,kept),
              'episode_range':lambda req:_episode_check(req,episodes),
              'output_kind':lambda req:_kind_check(req,kind),
              'edit_range':lambda req:_edit_check(req,content,contract,baseline),
              'source_read':lambda req:_read_check(req,contract,read_evidence),
              'series_length':lambda req:_series_check(req,episodes,kind),
              'prose_style':lambda req:_prose_check(req,episodes,kind)}
    for requirement in contract.get('active_requirements',[]):
        if not isinstance(requirement,dict) or requirement.get('status','active')!='active':continue
        scoped=_range((requirement.get('scope') or {}).get('episodes'))
        if requested is not None and scoped is not None and not scoped.intersection(requested):
            checks.append(_result(requirement,'pass',evidence={'scope':'该要求保留于其他集，本轮没有改写或交付其适用集数'}))
            continue
        handler=dispatch.get(requirement.get('kind'))
        if handler:checks.append(handler(requirement))
        else:
            semantic.append(requirement)
            checks.append(_result(requirement,'unverified',target=requirement.get('value'),issues=[{'code':'independent_semantic_review_required'}]))
    ending=_complete_ending_check(episodes,kind)
    if ending:checks.append(ending)
    issues=[issue for check in checks for issue in check['issues']]
    status='fail' if any(check['status']=='fail' for check in checks) else 'unverified' if not checks or any(check['status']=='unverified' for check in checks) else 'pass'
    return {'status':status,'checks':checks,'issues':issues,'semantic_requirements':semantic,'statistics':statistics}

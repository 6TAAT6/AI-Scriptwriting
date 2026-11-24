"""仅以当前轮真实稿件工具证据控制窄只读核查，不替模型执行或改写历史。"""
from dataclasses import dataclass, field
import json
from threading import RLock

from hermes_constants import hermes_home_key

from .capability_selection import document_owner
from .document_execution_evidence import begin_turn, record, snapshot

_TOOL = 'drama_agent_document'
_MAX_STALLED = 3
_LOCK = RLock()
_TURNS = {}
_STARTING = {}
_LABELS = {'directory': '本轮完整稿件目录查询', 'full_read': '本轮目标稿件全文读取'}
_REASONS = {
    'target_unresolved': '尚不能唯一确定要读取的稿件',
    'tool_failed': '读取工具未成功完成，已停止自动要求继续',
    'no_progress': '连续调用没有增加有效读取范围，已停止自动要求继续',
    'request_budget': '原生执行预算已要求停止工具调用',
    'unsupported_transport': '当前模型接口无法可靠指定已有稿件工具',
    'tool_unavailable': '当前会话没有可用的稿件读取工具',
    'cancelled': '本轮核查已取消',
}


@dataclass
class _Turn:
    plan: dict
    sessions: set = field(default_factory=set)
    seen: set = field(default_factory=set)
    requests: set = field(default_factory=set)
    progress: object = None
    stalled: int = 0
    terminal_reason: str | None = None


def _key(session_id, turn_id):
    if not all(isinstance(value, str) and value and len(value) <= 512 for value in (session_id, turn_id)):
        return None
    return hermes_home_key(), session_id, turn_id


def _current(session_id, turn_id):
    key = _key(session_id, turn_id)
    if key is None:
        return None
    state = _TURNS.get(key)
    if state is None:
        # 原生压缩会在同一轮更换session；只迁移受既有读取边界认可的唯一账本。
        candidates = [(old, item) for old, item in _TURNS.items() if old[0] == key[0] and old[2] == turn_id]
        if not candidates:
            return None
        try:
            owner = document_owner(session_id)
        except PermissionError:
            return None
        from .agent_documents import _reading_scope
        scope = _reading_scope(session_id, owner)
        candidates = [(old, item) for old, item in candidates
                      if (session_id in item.sessions or old[1] in scope) and item.plan['owner'] == owner]
        if len(candidates) != 1:
            return None
        old, state = candidates[0]
        if session_id not in state.sessions:
            state.sessions.add(session_id)
            state.plan['session_id'] = session_id
            _TURNS[key] = _TURNS.pop(old)
    try:
        if document_owner(session_id) != state.plan['owner']:
            return None
    except PermissionError:
        return None
    return state


def pre_llm_call(*, user_message='', session_id='', turn_id='', **_kwargs):
    key = _key(session_id, turn_id)
    if key is None:
        return
    generation = object()
    with _LOCK:
        _STARTING[key[:2]] = (turn_id, generation)
        # 新用户轮替换本会话旧状态；其他profile/会话不能借用本轮证据。
        for existing in list(_TURNS):
            if existing[:2] == key[:2]:
                _TURNS.pop(existing)
    plan = begin_turn(user_message, session_id)
    with _LOCK:
        if _STARTING.get(key[:2]) != (turn_id, generation):
            return
        _STARTING.pop(key[:2], None)
        if plan:
            _TURNS[key] = _Turn(plan, sessions={session_id})


def _observe(state, tool_name, args, result, status, tool_call_id):
    if tool_name != _TOOL or not isinstance(tool_call_id, str) or not tool_call_id:
        return
    if status != 'ok':
        if tool_call_id in state.seen:
            # 晚到的失败状态否决此前transform观察，不能继续使用该调用完成的证据。
            if isinstance(args, dict) and args.get('action') == 'list':
                state.plan['directory']['complete'] = False
            else:
                state.plan['read'].update(complete=False, facts=None)
        state.terminal_reason = 'cancelled' if status == 'cancelled' else 'tool_failed'
        return
    if tool_call_id in state.seen or state.terminal_reason:
        return
    state.seen.add(tool_call_id)
    record(state.plan, tool_name, args, result, status)


def post_tool_call(*, tool_name='', args=None, result=None, status='ok', session_id='', turn_id='', tool_call_id='', **_kwargs):
    with _LOCK:
        state = _current(session_id, turn_id)
        if state:
            _observe(state, tool_name, args, result, status, tool_call_id)


def pre_tool_call(*, tool_name='', args=None, session_id='', turn_id='', **_kwargs):
    with _LOCK:
        state = _current(session_id, turn_id)
        if state and tool_name == _TOOL and (not isinstance(args, dict) or args.get('action') not in {'read', 'list'}):
            state.terminal_reason = 'tool_failed'
            return {'action': 'block', 'message': '用户本轮明确只读核查，不能保存或导出稿件。请报告实际已读取的事实和未完成项。'}


def transform_tool_result(*, tool_name='', args=None, result=None, status='ok', session_id='', turn_id='', tool_call_id='', **_kwargs):
    with _LOCK:
        state = _current(session_id, turn_id)
        if state is None or tool_name != _TOOL:
            return None
        # registry与inline执行器的post/transform顺序不同；同call_id只记一次真实结果。
        _observe(state, tool_name, args, result, status, tool_call_id)
        try:
            payload = json.loads(result) if isinstance(result, str) else result
        except (TypeError, ValueError):
            return None
        if not isinstance(payload, dict):
            return None
        view = snapshot(state.plan)
        pending = [_LABELS[item] for item in view['missing']]
        reason = state.terminal_reason or view['terminal_reason']
        progress = {'complete': view['complete'], 'pending': pending,
                    'next_call': None if state.terminal_reason else view['next_call'],
                    'instruction': ('继续使用本轮下一项真实工具调用；目录元数据不等于正文已读。未完成项不能宣称已完成。'
                                    if view['missing'] else '本轮要求的读取范围已有真实证据；只按实际统计回答。')}
        if reason:
            progress['limitation'] = _REASONS.get(reason, '本轮核查仍有未完成项')
        assert len(json.dumps(progress, ensure_ascii=False)) <= 2000
        return json.dumps({**payload, 'execution_evidence': progress}, ensure_ascii=False)


def llm_request(request, *, session_id='', turn_id='', api_request_id='', api_mode='', **_kwargs):
    if not isinstance(request, dict):
        return None
    with _LOCK:
        state = _current(session_id, turn_id)
        if state is None or state.terminal_reason:
            return None
        view = snapshot(state.plan)
        if view['complete'] or not view['next_call']:
            return None
        if request.get('tool_choice') == 'none':
            state.terminal_reason = 'request_budget'
            return None
        tools = request.get('tools') or []
        if not any(isinstance(row, dict) and (row.get('name') == _TOOL or isinstance(row.get('function'), dict) and row['function'].get('name') == _TOOL) for row in tools):
            state.terminal_reason = 'tool_unavailable'
            return None
        choices = {'chat_completions': {'type': 'function', 'function': {'name': _TOOL}},
                   'codex_responses': {'type': 'function', 'name': _TOOL},
                   'responses': {'type': 'function', 'name': _TOOL},
                   'anthropic_messages': {'type': 'tool', 'name': _TOOL}}
        choice = choices.get(api_mode)
        thinking = request.get('thinking')
        if choice is None or (api_mode == 'anthropic_messages' and isinstance(thinking, dict) and thinking.get('type') in {'enabled', 'adaptive'}):
            state.terminal_reason = 'unsupported_transport'
            return None
        request_id = api_request_id or str(len(state.requests))
        if request_id not in state.requests:
            state.requests.add(request_id)
            if state.progress == view['progress_key']:
                state.stalled += 1
            else:
                state.stalled = 0
            state.progress = view['progress_key']
        if state.stalled >= _MAX_STALLED:
            state.terminal_reason = 'no_progress'
            return None
        # 此中间件只增加本次wire请求的选择，消息、系统内容与工具定义保持原字节。
        return {'request': {**request, 'tool_choice': choice}, 'source': 'jubao-drama', 'reason': '本轮只读核查仍有未完成的真实读取'}


def _report(plan, view, reason):
    lines = ['本轮只读核查结果：']
    directory = view['facts']['directory']
    if directory:
        lines += [f"已完整查询本轮稿件目录，共 {directory['total']} 份。", '最早保存的稿件（按创建顺序）：']
        lines += [f"{index}. {row['name']}" for index, row in enumerate(directory['oldest'], 1)]
        if plan['requested'].get('saved_times'):
            lines += ['保存时间：现有稿件记录未提供可靠保存时间，无法确认。']
    read = view['facts']['read']
    if read:
        lines += [f"已在本轮从头到尾读取《{read['name']}》。"]
        stats = read.get('statistics') or {}
        if plan['requested'].get('episode_counts'):
            for episode in stats.get('episodes') or []:
                lines += [f"{episode['episode']}正文：{episode['han_characters']} 汉字，{episode['non_whitespace_characters']} 个非空白字符。"]
            if stats.get('episodes_truncated'):
                lines += ['逐集明细仅覆盖本轮回执列出的集数，不能视为所有集的逐项统计。']
        totals = stats.get('episode_body_totals') or {}
        if plan['requested'].get('body_total') and totals.get('coverage_complete'):
            lines += [f"分集正文合计（不含集标题）：{totals['han_characters']} 汉字，{totals['non_whitespace_characters']} 个非空白字符。"]
        elif plan['requested'].get('body_total'):
            lines += ['分集正文合计：本轮回执没有确认可分集统计的完整范围，无法提供可靠合计。']
        if plan['requested'].get('whole_total') and type(stats.get('han_characters')) is int and type(stats.get('non_whitespace_characters')) is int:
            lines += [f"含集标题的全文：{stats['han_characters']} 汉字，{stats['non_whitespace_characters']} 个非空白字符。"]
        if plan['requested'].get('last_dialogue'):
            lines += ['最后一句对白：' + (read.get('last_dialogue') or '本轮回读未确认最后一句对白。')]
        if plan['requested'].get('last_line'):
            lines += ['最后一行非空文字：' + (read.get('last_line') or '未读取到非空文字。')]
        receipt = read.get('receipt') or {}
        if plan['requested'].get('paragraphs'):
            if receipt.get('paragraphs_scope') == 'nonempty_top_level_content_paragraphs_excluding_table_cells' and type(receipt.get('paragraphs')) is int:
                lines += [f"Word 回执中的 {receipt['paragraphs']} 段表示非空顶层正文段落，排除排版空段和表格单元格；不等于全部 XML 段落节点数。"]
            else:
                lines += ['段落数：本轮回执未提供可确认的段落统计范围。']
        if plan['requested'].get('file_checks'):
            lines += [('内容回读核验：现有导出回执确认导出文本与预期导出正文一致；不代表本轮重新导出或重新进行文件实机验收。'
                       if receipt.get('content_verified') is True else '内容回读核验：本轮回执没有提供通过证据。')]
        if plan['requested'].get('wps'):
            lines += ['WPS 实机验收：本轮没有实际打开 WPS 的验收证据，不能宣称通过。']
        if plan['requested'].get('cache'):
            lines += ['缓存原因：本轮没有客户端故障证据，不能据服务端文件非空推断当时打开空白是缓存导致。']
    comparison=view['facts'].get('comparison')
    if comparison:
        lines += [f'已在本轮完整读取当前稿《{comparison["current"]["name"]}》及其直接前版《{comparison["previous"]["name"]}》，两份版本关系和原文摘要均已核对。']
        for label in ('current','previous'):
            lines += [('当前稿' if label=='current' else '直接前版')+'编号：'+comparison[label]['document_id']+'。']
            totals=(comparison[label].get('statistics') or {}).get('episode_body_totals') or {}
            if totals.get('coverage_complete'):
                lines += [('当前稿' if label=='current' else '直接前版')+f'正文：{totals["han_characters"]}汉字，{totals["non_whitespace_characters"]}个非空白字符。']
        if comparison['locked_prefix_unchanged'] is not None:
            lines += ['本次结尾修改的锁定前文逐字一致。' if comparison['locked_prefix_unchanged'] else '本次结尾修改的锁定前文存在差异，不能称为逐字一致。']
    if view['missing']:
        lines += ['未完成：' + '、'.join(_LABELS[item] for item in view['missing']) + '。']
        lines += [_REASONS.get(reason, '模型本轮没有完成这些工具动作，不能用历史回执替代本轮核查。')]
    if view['missing'] and plan.get('target'):
        suggestion = {'label': '继续未完成的只读核查', 'prompt': '请继续完成刚才明确列出的未完成读取项；本轮只读核查，不改稿、不保存、不导出。'}
    elif view['missing']:
        suggestion = {'label': '列出稿件供选择', 'prompt': '请列出本会话已保存稿件的名称，供我选择要核查的对象；只读查询，不保存、不导出。'}
    elif read and (plan['requested'].get('body_total') or plan['requested'].get('whole_total') or plan['requested'].get('episode_counts')):
        suggestion = {'label': '解释刚才的统计口径', 'prompt': '请根据刚才已核实的结果，解释汉字数、非空白字符数以及集标题是否计入的区别。'}
    else:
        suggestion = {'label': '查看本轮核查范围', 'prompt': '请根据刚才的核查结果，说明已经确认的范围和仍无法确认的信息。'}
    lines += ['```studio-suggestions\n' + json.dumps([suggestion], ensure_ascii=False) + '\n```']
    return '\n\n'.join(lines)


def transform_llm_output(*, response_text='', session_id='', turn_id='', **_kwargs):
    with _LOCK:
        state = _current(session_id, turn_id)
        if state:
            view = snapshot(state.plan)
            return _report(state.plan, view, state.terminal_reason or view['terminal_reason'])


def on_session_end(*, session_id='', turn_id='', **_kwargs):
    with _LOCK:
        if not isinstance(session_id, str) or not session_id:
            return
        session_key = (hermes_home_key(), session_id)
        from .agent_documents import _reading_scope
        try:
            owner = document_owner(session_id)
            scope = set(_reading_scope(session_id, owner))
        except PermissionError:
            owner, scope = None, {session_id}
        for key in list(_TURNS):
            state = _TURNS[key]
            same_conversation = session_id in state.sessions or (state.plan['owner'] == owner and key[1] in scope)
            if key[0] == session_key[0] and same_conversation and (not turn_id or key[2] == turn_id):
                _TURNS.pop(key)
        for pending in list(_STARTING):
            if pending[0] == session_key[0] and pending[1] in scope and (not turn_id or _STARTING[pending][0] == turn_id):
                _STARTING.pop(pending)

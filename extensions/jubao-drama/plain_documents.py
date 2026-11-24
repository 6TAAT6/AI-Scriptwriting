"""普通会话显式请求的文档交付，不隐式启用任何 Agent 或技能。"""
from contextlib import closing
import hashlib
import re

from hermes_constants import get_hermes_home, hermes_home_key
from plugins.plugin_storage import plugin_db

OWNER = 'conversation-documents'
_DOCUMENT = r'(?:文件|文档|稿件|Word|docx)'
_DELIVERY = r'(?:保存|导出|另存|生成|制作|打包|发送|发过来|发给我|发来|发我|给我|交付|提供)'


def _delivery_requested(original):
    from .task_requirement_extract import _clauses

    # 先移除完整引文，再分句，避免引文里的句号把引号拆开后误成指令。
    direct = re.sub(r'“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|(?<!`)`(?!`)[^`\n]*`(?!`)', '', original)
    denial = (r'(?:不要|不用|无需|不必|不需要|禁止|不得|不能|别|不)\s*'
              r'(?:(?:再|重新|自动|现在|本轮|先)\s*)*'
              rf'(?:{_DELIVERY}|发|给|(?:以|用)?\s*{_DOCUMENT}|(?:把|将)[^，,。！？!?；;\n]{{0,24}}{_DOCUMENT})')
    delivery_denial = (r'(?:不要|不用|无需|不必|不需要|禁止|不得|不能|别|不)\s*'
                      r'(?:(?:再|重新|自动|现在|本轮|先)\s*)*'
                      rf'(?:保存|导出|另存|发送|发|给|交付|(?:以|用)?\s*{_DOCUMENT})')
    requested = False
    for clause in _clauses(direct):
        if (re.match(r'^(?:(?:请|帮我|我|只是|只|仅|在)\s*)*(?:引用|复述|解释|说明|翻译|分析|讨论|比较|举例|例如|假如|如果|他说|她说|原话)', clause)
                or re.search(r'怎么|如何|为什么|是什么|什么意思|是否|能否|可否', clause)):
            continue
        for fragment in re.split(r'[，,]', clause):
            if re.search(denial, fragment, re.I):
                if re.search(delivery_denial, fragment, re.I):
                    return False
                continue
            if (re.search(rf'{_DELIVERY}.{{0,24}}{_DOCUMENT}|{_DOCUMENT}.{{0,24}}{_DELIVERY}', fragment, re.I)
                    or re.fullmatch(rf'(?:(?:请|就|直接|还是)\s*)*(?:以|用)\s*{_DOCUMENT}\s*(?:的)?(?:形式|格式)[。！!\s]*', fragment, re.I)):
                requested = True
    return requested


def requested(session_id):
    from .requirement_control import _current

    state = _current(session_id)
    if not state:
        return False
    contract = state['contract']
    source = contract.get('source') or {}
    original = source.get('original_text')
    if (contract.get('capture_status') != 'captured' or contract.get('home_key') != hermes_home_key()
            or contract.get('session_id') != session_id or contract.get('turn_id') != state['turn_id']
            or source.get('turn_id') != state['turn_id'] or not isinstance(original, str)
            or source.get('text_sha256') != hashlib.sha256(original.encode()).hexdigest()):
        return False
    if (contract.get('current_task') or {}).get('read_only'):
        return False
    return _delivery_requested(original)


def has_documents(session_id):
    state = get_hermes_home() / 'state.db'
    lineage = [session_id]
    if state.is_file():
        from hermes_state import SessionDB
        with closing(SessionDB(state, read_only=True)) as database:
            lineage = database._resume_lineage_ids(session_id)
    with closing(plugin_db('jubao-drama')) as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='agent_documents'").fetchone():
            return False
        return conn.execute('SELECT 1 FROM agent_documents WHERE session_id IN (' + ','.join('?' for _ in lineage)
                            + ') AND agent_id=? LIMIT 1', (*lineage, OWNER)).fetchone() is not None


def allowed(args, session_id):
    if not isinstance(args, dict) or args.get('kind') == 'internal':
        return False
    # 不选能力直接要稿件的对话，稿件照常保存、查看、核验与返修（曾因只放开保存，模型先列稿件时整轮中止）。
    from .capability_selection import requested_creative
    if args.get('action') in {'save', 'export'}:
        return requested(session_id) or requested_creative(session_id)
    return args.get('action') in {'read', 'list'} and (requested(session_id) or has_documents(session_id)
                                                       or requested_creative(session_id))


def pre_llm_call(*, session_id='', **_kwargs):
    from .agent_profiles import active_agent
    from .capability_selection import active_skills

    if session_id and not active_agent(session_id) and not active_skills(session_id) and requested(session_id):
        return {'context': '【普通文档交付】用户本轮明确要求以文档形式交付。可使用 drama_agent_document 保存本会话正文并生成 Word，'
                '无需启用剧本 Agent 或技能，也不能自行启用任何创作规则。仅导出已有正文时保持正文不变；'
                '若之前的 Agent 已停用，可把当前对话中已有的完整正文保存为普通文档副本；'
                '不能读取或导出原 Agent 的私有稿件编号，也不能改写旧稿。当前对话没有完整正文时先说明缺失。'
                '保存仍须通过已有要求核验，依据真实 receipt 交付，失败时保留草稿并说明缺项。'}

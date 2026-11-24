"""把要求清单、设定库、真实读取及稿件验收接入同一轮工具链，每份稿件最多定向返修一次。

要求来自 ``ledger``（用户亲口提出、经引文校验的条目），不再从用户原话用正则推断；
本模块只负责本轮的读取证据、确定性检查、独立语义审稿与返修预算。
"""
from contextlib import closing
from copy import deepcopy
import hashlib
import logging
import json
import re
from threading import RLock

from hermes_constants import hermes_home_key
from plugins.plugin_storage import plugin_db
from . import ledger, story_bible
from .creative_scope import scope_for
from .requirement_checks import check_draft, ending_boundaries
from .requirement_review import semantic_review
from .task_requirement_extract import _authored_request, source_for_turn
from .requirement_policy import source_world_requirements
from . import requirement_revision

_LOCK=RLock()
_TURNS={}
_MAX_DRAFTS=2


def _reply_only_requirement(requirement):
    """识别应由回复卡片满足的下一步要求，不把它误判为稿件正文缺陷。

    ``studio-suggestions`` 是交付协议的一部分。员工说“剧本结尾给出下一步建议”
    时，建议出现在正文下方的下一步卡片中；把这条回复要求送进稿件语义审稿会
    造成稿件永远因“正文里没有建议卡片”而 ``revision_required``。
    """
    if not isinstance(requirement,dict):
        return False
    text=' '.join(str(requirement.get(key) or '') for key in ('text','value','quote','description'))
    return '下一步' in text and ('建议' in text or '卡片' in text)


def _document_contract(contract):
    """返回只包含稿件应满足的要求，保留回复级要求给收尾卡片处理。"""
    rows=[row for row in contract.get('active_requirements',[]) if not _reply_only_requirement(row)]
    semantic=[row for row in contract.get('semantic_requirements',[]) if not _reply_only_requirement(row)]
    return {**contract,'active_requirements':rows,'semantic_requirements':semantic}


def revision_base(session_id,kind):
    """本轮上一稿未通过核验时返回其正文，供“只重写未达标的几集”合并回整批稿件。"""
    state=_current(session_id)
    last=state and state.get('last')
    if not last or last.get('kind')!=kind or (last.get('report') or {}).get('status')=='pass':
        return None
    return last.get('content')


def _tables(conn):
    conn.execute('CREATE TABLE IF NOT EXISTS requirement_reads (session_id TEXT NOT NULL,identity TEXT NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(session_id,identity))')


def _key(sid):
    return hermes_home_key(),sid


def _current(sid):
    with _LOCK:
        value=_TURNS.get(_key(sid))
        if value is not None:
            return value
        # 压缩只能沿原生验证过的祖先继承同轮状态，不能借其他分支重开修订。
        for ancestor in reversed(_scope_sessions(sid)[:-1]):
            value=_TURNS.get(_key(ancestor))
            if value is not None:
                _TURNS[_key(sid)]=value
                del _TURNS[_key(ancestor)]
                value['contract']={**value['contract'],'session_id':sid}
                if value.get('baseline'):
                    value['baseline']={**value['baseline'],'session_id':sid}
                return value
        return None


def _draft_text(text):
    return re.sub(r'```studio-suggestions\s*[\s\S]*?```','',text or '').strip()


def _baseline(history, contract):
    for row in reversed(history[:-1]):
        content=row.get('content')
        if row.get('role')=='assistant' and isinstance(content,str) and re.search(r'(?m)^\s*(?:[#*]*\s*)?第\s*\d+\s*集',content):
            text=_draft_text(content)
            return {'content':text,'content_sha256':hashlib.sha256(text.encode()).hexdigest(),
                    'home_key':contract['home_key'],'session_id':contract['session_id'],'source':'当前会话上一稿'}
    return None


def _source_baseline(contract):
    """Use a complete manuscript pasted in the current user turn as the edit baseline.

    An edit request may include the source text inline instead of referring to a saved
    document.  That text is already user supplied and session scoped, so requiring a
    second ``drama_agent_document.read`` makes legitimate edits report
    ``missing_or_foreign_baseline``.  Stop before the trailing edit instructions; those
    instructions are requirements, not part of the manuscript.
    """
    source = contract.get('source') or {}
    raw = source.get('original_text')
    if not isinstance(raw, str) or not raw.strip():
        return None
    if not re.search(r'原稿|以下是|如下|在这个基础上|按下面内容|根据下面|粘贴', raw):
        return None
    from .requirement_checks import _episodes
    heading_pattern = re.compile(r'第\s*(?:\d{1,4}|[零〇一二两三四五六七八九十百千]{1,6})\s*集')
    candidates = []
    for match in heading_pattern.finditer(raw):
        if not re.search(r'\n(?:\s*\d{1,4}[-—.]\d{1,4}|\s*(?:人物|△|▲|场景)|\s*[^\n]{1,20}[：:])', raw[match.end():match.end() + 400]):
            continue
        line_start = raw.rfind('\n', 0, match.start()) + 1
        prefix = raw[line_start:match.start()].strip()
        # A heading on its own line is the strongest source boundary.  A heading after
        # “以下是原稿：” is also valid; an inline instruction such as “修改第3集” is not.
        rank = 0 if not prefix else 1 if re.search(r'(?:原稿|正文|稿件|如下)\s*[:：]?', prefix) else 2
        candidates.append((rank, match.start(), match))
    start = min(candidates, key=lambda item: (item[0], item[1]))[2] if candidates else None
    if not start:
        return None
    text = raw[start.start():].strip()
    # Common inline edit instructions follow the pasted manuscript on the same turn.
    cut = re.search(r'\n[^\n]{0,16}集在这个基础上(?:扩充|扩写|精简|修改|重写)|\n(?:再次强调|请(?:精简|扩充|修改|重写))', text)
    if cut:
        text = text[:cut.start()].rstrip()
    if not _episodes(text) or len(text) < 24:
        return None
    return {
        'content': text,
        'content_sha256': hashlib.sha256(text.encode()).hexdigest(),
        'home_key': contract.get('home_key'),
        'session_id': contract.get('session_id'),
        'source': '当前用户消息中的原稿',
    }


def _owned_baseline(baseline,reads):
    if not baseline or baseline.get('document_id'):return baseline
    matching=[row for row in reads if row.get('document_id') and row.get('content_sha256')==baseline.get('content_sha256')
              and row.get('home_key')==baseline.get('home_key') and row.get('session_id')==baseline.get('session_id')]
    # 阅读账本按最近真实读取排序；全文和版本都验证后才补齐直接前版身份。
    verified=_read_baseline(matching)
    return {**baseline,'document_id':verified['document_id']} if verified else baseline


def _saved_baseline(session_id):
    """Recover the latest saved manuscript in this conversation for a later edit turn."""
    with closing(plugin_db('jubao-drama')) as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='agent_documents'").fetchone():
            return None
        rows = conn.execute("SELECT id,content FROM agent_documents WHERE session_id=? ORDER BY rowid DESC LIMIT 20",
                            (session_id,)).fetchall()
    from .requirement_checks import _episodes
    for identifier, content in rows:
        if not isinstance(content, str) or not _episodes(content):
            continue
        return {'content': content, 'content_sha256': hashlib.sha256(content.encode()).hexdigest(),
                'document_id': identifier, 'home_key': hermes_home_key(),
                'session_id': session_id, 'source': '当前会话已保存稿件'}
    return None


def _initial_baseline(history,contract):
    reads=_read_evidence(contract['session_id'])
    inline = _source_baseline(contract) if (contract.get('current_task') or {}).get('edit_range') else None
    return (inline
            or (_saved_baseline(contract['session_id']) if (contract.get('current_task') or {}).get('edit_range') else None)
            or _owned_baseline(_baseline(history,contract),reads)
            or _read_baseline(reads))


def _ending_context(state):
    value=(state['contract'].get('current_task') or {}).get('edit_range') or {}
    if value.get('part')!='ending':return ''
    policy=('\n【只改结尾的宿主执行边界】\n用户仅授权修改结尾。以下origin=host_boundary是宿主保守解释，'
            '不是用户说过“4段”。默认最多4个末尾非空段落，限最后一场且不超过正文末20%，其前原文原样保留；'
            '不得为润色结尾重新措辞前文。若确需改更早部分，只报告所需扩大范围，不能自行改。')
    baseline=state.get('baseline')
    if not baseline:return policy+'请先读取当前原稿；核验会返回可修改原文及锁定前缀。'
    return policy+'\n'+json.dumps(ending_boundaries(baseline['content'],value),ensure_ascii=False)


def _snapshot(user_message,history,session_id,turn_id,source=None):
    """本轮核验合同 = 要求清单的生效条目 + 经来源校验的本轮用户原话。"""
    from agent.delegation_context import is_delegated_child_context
    scope=scope_for(session_id)
    contract=ledger.check_contract(scope,session_id,turn_id)
    contract['scope_id']=scope
    if not isinstance(turn_id,str) or not turn_id or len(turn_id)>512:
        contract['capture_status']='missing_turn_id'
    elif is_delegated_child_context():
        contract['capture_status']='delegated_read_only'
    else:
        if source is None:
            from .task_requirement_extract import source_for_delegation_completion
            source = source_for_delegation_completion(user_message, history, session_id, turn_id)
        source = source if source is not None else source_for_turn(user_message,history,turn_id)
        if source is None:
            contract['capture_status']='untrusted_source'
        else:
            contract['source']=source
    return contract


def pre_llm_call(*,user_message='',conversation_history=None,session_id='',turn_id='',**_kwargs):
    """登记本轮核验状态；要求与设定由创作胶囊注入，这里只在“只改结尾”时补充宿主边界。

    本轮先不进入强制核验：只有模型实际保存或核验稿件时才按本轮要求审稿，普通问答不被要求调用稿件工具。
    """
    if not session_id:return None
    snapshot=_snapshot(user_message,conversation_history or [],session_id,turn_id)
    from .continuation_context import bind_contract, render as continuation_context
    snapshot=bind_contract(snapshot,user_message=user_message,conversation_history=conversation_history or [],
                           session_id=session_id,turn_id=turn_id)
    from .agent_delivery import native_delivery_input, mark_managed_input
    delivery_input=native_delivery_input(user_message,conversation_history or [])
    with _LOCK:
        current=_TURNS.get(_key(session_id))
        if not current or current['turn_id']!=turn_id:
            _TURNS[_key(session_id)]={'contract':snapshot,'turn_id':turn_id,'active':False,
                'last':None,'validation_lock':RLock(),'baseline':_initial_baseline(conversation_history or [],snapshot)}
        state=_TURNS[_key(session_id)]
        state.update(contract=snapshot,untrusted_creative=False,delivery_input=delivery_input)
    mark_managed_input(session_id,delivery_input)
    ending='\n\n'.join(filter(None,[_ending_context(state),continuation_context(snapshot)]))
    from .agent_profiles import own_protocol
    # 自带协议的 Agent 用自己的确认词与断点规则推进，不接收宿主的续写/只改结尾合同。
    if own_protocol(session_id):return None
    return {'context':ending} if ending else None


def _refresh_contract(state,session_id):
    """核验前等待本轮要求提取完成，并以最新清单替换合同条目，保留本轮来源与已激活的语义条款。"""
    contract=state['contract']
    scope=contract.get('scope_id') or scope_for(session_id)
    ledger.wait_pending(scope)
    fresh=ledger.check_contract(scope,session_id,state['turn_id'])
    kept=[row for row in contract.get('active_requirements',[]) if row.get('subject')=='current_user_request']
    updated={**contract,**{key:fresh[key] for key in ('active_requirements','semantic_requirements','current_task','revision')}}
    updated['active_requirements']=[*fresh['active_requirements'],*kept]
    updated['semantic_requirements']=[*fresh['semantic_requirements'],*kept]
    if contract.get('current_task',{}).get('creative'):
        updated['current_task']={**fresh['current_task'],**{k:v for k,v in contract['current_task'].items()
                                                              if k not in fresh['current_task']}}
    state['contract']=updated
    from .delivery_authorization import apply_contract
    apply_contract(state)
    from .continuation_context import apply_contract as apply_continuation
    state['contract']=apply_continuation(state['contract'])


def _scope_sessions(sid):
    from .creative_scope import lineage
    return lineage(sid)


def observe_result(tool_name,args,result,session_id):
    state=_current(session_id)
    if not state or state['contract'].get('capture_status')!='captured':return
    try:payload=json.loads(result) if isinstance(result,str) else result
    except (TypeError,ValueError):return
    if not isinstance(payload,dict) or payload.get('ok') is not True:return
    source=None
    if tool_name=='drama_material_import':
        material=payload.get('material') or {}
        source={'path':args.get('path'),'file_sha256':material.get('sha256'),'content_sha256':material.get('content_sha256'),
            'text':material.get('text',''),'start_char':material.get('start_char',material.get('source_start_char',0)),'end_char':material.get('end_char',material.get('source_end_char')),
            'characters':material.get('characters',material.get('source_characters'))}
        # 整表分页同样保留表身份，不能把另一张表的全文当作指定原稿已读。
        source.update({key:material[key] for key in ('sheet','sheet_visibility','read_sheets','unread_sheets','workbook_coverage_complete') if key in material})
        source['coverage_complete']=_valid_page(source)
        if material.get('mode')=='cells':
            source.update(sheet=material.get('sheet'),range=material.get('cell_range'),
                cells=[{**c,'cell':c['address']} for c in material.get('cells',[]) if isinstance(c,dict) and 'address' in c],
                coverage_complete=material.get('coverage_complete') is True)
    elif tool_name=='drama_agent_document' and args.get('action')=='read':
        doc=payload.get('document') or {}
        source={'document_id':doc.get('id'),'content_sha256':payload.get('content_sha256'),
            'text':doc.get('content',''),'start_char':payload.get('start_char',0),'end_char':payload.get('end_char'),
            'characters':payload.get('characters')}
        source['coverage_complete']=_valid_page(source)
    if source is None:return
    source.update(home_key=hermes_home_key(),session_id=session_id,turn_id=state['turn_id'])
    identity=hashlib.sha256(json.dumps({k:v for k,v in source.items() if k not in {'text','turn_id'}},sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    with closing(plugin_db('jubao-drama')) as conn:
        _tables(conn);conn.execute('INSERT OR REPLACE INTO requirement_reads VALUES(?,?,?)',(session_id,identity,json.dumps(source,ensure_ascii=False)));conn.commit()
    if source.get('document_id'):
        state['baseline']=_read_baseline(_read_evidence(session_id)) or state.get('baseline')


def _valid_page(source):
    start,end,total=(source.get(key) for key in ('start_char','end_char','characters'))
    return (all(type(value) is int for value in (start,end,total)) and 0<=start<=end<=total
            and isinstance(source.get('text'),str) and len(source['text'])==end-start)


def _current_file_hash(path):
    from .documents import _path, MAX_FILE_BYTES
    from .security import read_document_bytes
    candidate=_path(path,{'.txt','.md','.docx','.xlsx','.xls','.xlsm','.csv','.pdf'})
    data=read_document_bytes(candidate,MAX_FILE_BYTES)
    return hashlib.sha256(data).hexdigest() if len(data)<=MAX_FILE_BYTES else None


def _document_versions(lineage):
    with closing(plugin_db('jubao-drama')) as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='agent_documents'").fetchone():return {}
        rows=conn.execute('SELECT id,content FROM agent_documents WHERE session_id IN ('+
                          ','.join('?' for _ in lineage)+')',lineage).fetchall()
    return {identifier:(text,hashlib.sha256(text.encode()).hexdigest()) for identifier,text in rows}


def _read_evidence(sid):
    lineage=_scope_sessions(sid)
    with closing(plugin_db('jubao-drama')) as conn:
        _tables(conn)
        rows=conn.execute('SELECT evidence FROM requirement_reads WHERE session_id IN ('+','.join('?' for _ in lineage)+') ORDER BY rowid DESC',lineage).fetchall()
    results=[];files={};documents=_document_versions(lineage)
    for raw, in rows:
        evidence=json.loads(raw)
        if evidence.get('home_key')!=hermes_home_key() or evidence.get('session_id') not in lineage:continue
        if evidence.get('path'):
            path=evidence['path']
            if path not in files:
                try:files[path]=_current_file_hash(path)
                except (OSError,ValueError,TypeError):files[path]=None
            if not files[path] or files[path]!=evidence.get('file_sha256'):continue
        elif evidence.get('document_id'):
            current=documents.get(evidence['document_id'])
            if (not current or current[1]!=evidence.get('content_sha256') or not _valid_page(evidence)
                    or current[0][evidence['start_char']:evidence['end_char']]!=evidence['text']):continue
        else:continue
        evidence['source_session_id']=evidence['session_id'];evidence['session_id']=sid;results.append(evidence)
    return results


def _read_baseline(reads):
    grouped={}
    for row in reads:
        if row.get('document_id') and row.get('coverage_complete'):
            grouped.setdefault((row['document_id'],row['content_sha256']),[]).append(row)
    for (identifier,digest),pages in grouped.items():
        text=''
        for page in sorted(pages,key=lambda row:row['start_char']):
            if page['start_char']>len(text):break
            text+=page['text'][max(0,len(text)-page['start_char']):]
        if len(text)==pages[0]['characters'] and hashlib.sha256(text.encode()).hexdigest()==digest:
            return {'content':text,'content_sha256':digest,'document_id':identifier,
                    'home_key':hermes_home_key(),'session_id':pages[0]['session_id']}
    return None


def _contract_issues(state,session_id):
    contract=state['contract']
    if (contract.get('capture_status')!='captured' or contract.get('home_key')!=hermes_home_key()
            or contract.get('session_id')!=session_id or contract.get('turn_id')!=state['turn_id']):
        return [{'kind':'contract','code':'untrusted_contract','message':'本轮要求来源尚未确认，不能判定通过。'}]
    if contract.get('pending'):
        legacy_pending = (contract.get('bootstrap') or {}).get('pending')
        message = ('历史用户原文的来源或范围尚未完全核实，不能把附件内容或压缩摘要当作要求；草稿已保留，暂不能判定通过。'
                   if legacy_pending else '部分要求的修改或取消范围尚未确认，不能判定全部通过。')
        return [{'kind':'contract','code':'pending_requirements','message':message}]
    if not any(row.get('status','active')=='active' for row in contract.get('active_requirements',[])):
        return [{'kind':'contract','code':'no_active_requirements','message':'本轮没有可核验的明确要求，不能判定全部通过。'}]
    return []


def _source_read_requirements(contract):
    return [row for row in contract.get('active_requirements', [])
            if row.get('kind') == 'source_read' and row.get('status', 'active') == 'active']


def _with_current_source_reads(contract, reads, turn_id):
    """来源义务来自可信用户文件引用或本轮实际读取，不以成功读完为前提。"""
    from agent.context_references import parse_context_references
    from .documents import _path
    def path_key(value):
        try:
            return str(_path(value, {'.txt', '.md', '.docx', '.xlsx', '.xls', '.xlsm', '.csv', '.pdf'}))
        except (ValueError, TypeError, PermissionError):
            return None
    explicit = _source_read_requirements(contract)
    covered = {key for row in explicit if isinstance(row.get('value'), dict)
               and row['value'].get('path') and (key := path_key(row['value']['path'])) is not None}
    references = [ref for ref in parse_context_references((contract.get('source') or {}).get('original_text', ''))
                  if ref.kind == 'file']
    sources = [{'path': ref.target} for ref in references]
    if not references:
        if explicit:
            return contract
        sources = [{key: row[key] for key in ('path', 'document_id') if row.get(key) is not None}
                   for row in reads]
    if not sources or not (contract.get('current_task') or {}).get('creative'):
        return contract
    result = deepcopy(contract)
    seen = set()
    for value in sources:
        if value.get('path') and path_key(value['path']) in covered:
            continue
        identity = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:24]
        if identity in seen:
            continue
        seen.add(identity)
        result['active_requirements'].append({'id': 'source-read-' + identity, 'kind': 'source_read',
            'value': value, 'status': 'active', 'origin': 'runtime_source_reference', 'source_turn_id': turn_id,
            'scope': {'lifetime': 'turn'}, 'quote': '本轮引用的原始资料须有完整且同版本的读取证据。'})
    return result


def _relevant_reads(contract,reads,*,basis_only=False):
    from .documents import _path
    requirements=_source_read_requirements(contract)
    relevant=[]
    for row in reads:
        for requirement in requirements:
            if (requirement.get('origin') == 'runtime_source_reference'
                    and row.get('turn_id') != requirement.get('source_turn_id')):
                continue
            value = requirement.get('value') or {}
            # 未指定局部范围时需读完整工作簿；工具自选单表不能缩小用户的来源义务。
            if row.get('unread_sheets') and not any(value.get(key) for key in ('sheet', 'range', 'requested_cells', 'basis_cells')):
                continue
            if value.get('path'):
                try:
                    suffixes={'.txt','.md','.docx','.xlsx','.xls','.xlsm','.csv','.pdf'}
                    if not row.get('path') or _path(row['path'],suffixes)!=_path(value['path'],suffixes):continue
                except (ValueError,TypeError,PermissionError):continue
            identifier=value.get('source_id') or value.get('document_id')
            if identifier and identifier!=row.get('document_id'):continue
            if value.get('sheet') and value['sheet']!=row.get('sheet'):continue
            selection={**value,'requested_cells':value['basis_cells']} if basis_only and value.get('basis_cells') else value
            selected=_source_cells(row,selection)
            if selected is None:continue
            relevant.append({**selected,**({'path':value['path']} if value.get('path') else {})})
            break
    return relevant


def _source_cells(row,value):
    ranges=value.get('requested_cells') or ([value['range']] if value.get('range') else [])
    if not ranges:return row
    from .requirement_checks import _cells
    wanted=_cells(ranges if isinstance(ranges,list) else [ranges])
    if not wanted:return None
    cells=[cell for cell in row.get('cells',[]) if str(cell.get('cell','')).upper().replace('$','') in wanted]
    if not cells:return None
    text=json.dumps(cells,ensure_ascii=False)
    return {**row,'cells':cells,'range':ranges,'text':text,'content_sha256':hashlib.sha256(text.encode()).hexdigest(),
            'start_char':0,'end_char':len(text),'characters':len(text)}


def _evidence_fingerprint(contract,reads,baseline):
    return hashlib.sha256(json.dumps({'contract':contract,'reads':reads,'baseline':baseline},
                                    sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def _current_evidence(state,session_id):
    reads=_read_evidence(session_id)
    baseline=_owned_baseline(state.get('baseline'),reads)
    if baseline and baseline.get('document_id'):
        # 已保存原稿由宿主完整读取；核验其真实归属和版本，不要求模型再补一次 read。
        with closing(plugin_db('jubao-drama')) as conn:
            current=conn.execute('SELECT session_id,content FROM agent_documents WHERE id=?',
                                 (baseline['document_id'],)).fetchone()
        if (baseline.get('home_key')!=hermes_home_key() or baseline.get('session_id')!=session_id
                or not current or current[0] not in _scope_sessions(session_id)
                or current[1]!=baseline.get('content')
                or hashlib.sha256(current[1].encode()).hexdigest()!=baseline.get('content_sha256')):
            baseline=None
    contract=_with_market(_with_story_bible(state['contract']))
    current_reads=[row for row in reads if row.get('turn_id')==state['turn_id']]
    contract=_with_current_source_reads(contract,current_reads,state['turn_id'])
    relevant=_relevant_reads(contract,reads)
    contract=source_world_requirements(contract,relevant)
    return relevant,baseline,_evidence_fingerprint(contract,relevant,baseline),contract


def _for_document_kind(contract,kind):
    """字数要求只核对其适用的稿件类型：正文字数不能拿来判大纲或分析稿不达标。"""
    rows=contract.get('active_requirements',[])
    kept=[row for row in rows if row.get('kind')!='min_words' or (row.get('scope') or {}).get('target','script') in {kind,'any'}]
    if len(kept)==len(rows):return contract
    return {**contract,'active_requirements':kept}


def _with_story_bible(contract):
    """创作稿件统一对照设定库审查世界观与人物；设定库为空时审稿只核对正文自身前后一致。"""
    if not (contract.get('current_task') or {}).get('creative'):
        return contract
    scope=contract.get('scope_id')
    entries=story_bible.list_entries(scope,include_proposed=True) if scope else []
    core=[{**{k:row[k] for k in ('id','category_label','name','aliases','content')},'confirmed':row['status']=='active'}
          for row in entries if row['core']]
    timeline=sorted((row for row in entries if row['category']=='timeline'),key=lambda row:row['updated_at'],reverse=True)[:3]
    result=deepcopy(contract)
    result['active_requirements'].append({'id':'story-bible-consistency','kind':'story_bible_consistency',
        'value':{'core_entries':core,'timeline':[{**{k:row[k] for k in ('id','name','content')},
                                                   'source':row.get('source'),'status':row.get('status'),
                                                   'confirmed':row.get('source') == 'user'} for row in timeline],
                 'empty':not core},
        'scope':{'lifetime':'turn','episodes':(contract.get('current_task') or {}).get('episode_range'),'document_id':None},
        'status':'active','origin':'story_bible','quote':'设定库为用户确认的权威设定；新增核心设定须经用户确认。'})
    return result


def _with_market(contract):
    """北美项目由独立审稿一并核对本土化：词表只能拦明显的中式词，人名、台词口吻、情节习俗要按语境判断。"""
    if not (contract.get('current_task') or {}).get('creative'):
        return contract
    from .market import market_for
    market,fantasy=market_for(contract.get('scope_id') or '')
    if market!='north_america':
        return contract
    result=deepcopy(contract)
    result['active_requirements'].append({'id':'market-north-america','kind':'semantic',
        'value':'目标市场为北美：人名、地名、机构、称呼、节日、法律与家庭关系、情节习俗（如婚俗、查验、宗族、株连）和台词口吻都要符合北美语境，'
                '台词是北美人会说的口语，不用中式成语俗语和文绉绉的书面语；'+('用户已要求东方奇幻元素，可保留其设定。' if fantasy else
                '奇幻只用西方体系，不出现修仙、宗门、境界与网文式力量等级修辞，冲突规模不升级。')+'中文只是表达语言，不是故事世界。',
        'scope':{'lifetime':'turn','episodes':(contract.get('current_task') or {}).get('episode_range'),'document_id':None},
        'status':'active','origin':'market_policy','subject':'market','quote':'目标市场：北美（海外付费短剧）'})
    return result


def _semantic_checks(report,semantic):
    ids={row['id'] for row in report['semantic_requirements']}
    decisions={row['requirement_id']:row for row in semantic.get('checks',[])}
    for check in report['checks']:
        identifier=check['requirement_id']
        if identifier not in ids:continue
        decision=decisions.get(identifier)
        check['status']=decision['status'] if decision else 'unverified'
        check['evidence']={'text':decision['evidence'],'reason':decision['reason']} if decision else {}
        check['issues']=[issue for issue in semantic['issues'] if issue.get('requirement_id')==identifier]
    report['issues']=[issue for check in report['checks'] for issue in check['issues']]
    report['issues'].extend(issue for issue in semantic['issues'] if not issue.get('requirement_id'))
    report['semantic_review']=semantic
    report['status']=('fail' if semantic['status']=='fail' or any(c['status']=='fail' for c in report['checks'])
                      else 'unverified' if semantic['status']=='unverified' or any(c['status']=='unverified' for c in report['checks']) else 'pass')


def _activate_artifact_review(state,kind,session_id):
    """实际稿件操作必须核对真实本轮要求，不把分类器漏识别当作无要求。"""
    contract=state['contract']
    task=contract.get('current_task') or {}
    source=contract.get('source') or {}
    original=source.get('original_text')
    if (contract.get('capture_status')!='captured' or contract.get('home_key')!=hermes_home_key()
            or contract.get('session_id')!=session_id or contract.get('turn_id')!=state['turn_id']
            or source.get('turn_id')!=state['turn_id'] or not isinstance(original,str) or not original.strip()
            or source.get('text_sha256')!=hashlib.sha256(original.encode()).hexdigest()):
        return {'status':'unverified','issues':[{'kind':'contract','code':'untrusted_artifact_request',
                 'message':'本轮稿件操作缺少可核验的真实用户原文，保留为未核验草稿。'}]}
    if task.get('read_only') or task.get('correction_only'):
        return {'status':'unverified','issues':[{'kind':'contract','code':'readonly_artifact_request',
                 'message':'本轮只读或仅记录纠正，未授权交付新稿，不能将此稿标记为通过。'}]}
    authored=_authored_request(original)
    if not authored or len(authored)>8000:
        return {'status':'unverified','issues':[{'kind':'contract','code':'artifact_request_scope_unverified',
                 'message':'本轮完整用户要求尚未纳入语义核验，不能以截断或空白内容标记通过。'}]}
    updated=deepcopy(contract)
    requirements=updated['active_requirements']
    if not any(row.get('subject')=='current_user_request' for row in requirements):
        identity=hashlib.sha256((session_id+state['turn_id']+'current_user_request'+authored).encode()).hexdigest()[:24]
        requirements.append({'id':identity,'kind':'semantic','subject':'current_user_request','value':authored,
            'quote':authored,'scope':{'lifetime':'turn','episodes':task.get('episode_range'),'document_id':None},
            'source_turn_id':state['turn_id'],'status':'active','origin':'user_text'})
    updated['semantic_requirements']=[*updated.get('semantic_requirements',[]),
        *[row for row in requirements if row.get('subject')=='current_user_request'
          and not any(prior.get('id')==row['id'] for prior in updated.get('semantic_requirements',[]))]]
    updated['current_task']={**task,'creative':True,'read_only':False,'output_kind':task.get('output_kind') or kind,
                             'source_query':original,'activation_source':'actual_document_operation'}
    state.update(contract=updated,active=True)
    return None


def validate(content,kind,session_id,llm=None,document_id=None):
    if not isinstance(content,str) or not content.strip() or len(content)>1_000_000:raise ValueError('核验需要完整稿件正文')
    state=_current(session_id)
    if not state:
        return {'status':'unverified','issues':[{'kind':'contract','code':'no_active_creative_task','message':'没有本轮真实创作任务合同，未进行达标判定。'}]}
    # 同一轮并行工具调用共享返修预算，审核中的调用不能同时读取旧计数。
    with state['validation_lock']:
        _refresh_contract(state,session_id)
        if not state['active']:
            blocked=_activate_artifact_review(state,kind,session_id)
            if blocked:return blocked
        return _validate(content,kind,session_id,llm,document_id,state)


def _market_check(report,text,scope_id,kind='script'):
    """把词表命中作为现有语义审稿的上下文线索，不单独判稿件失败。

    词表无法判断“掌门”是宗门身份还是企业负责人，也无法区分正文事实和
    用户正在讨论的原稿。最终结论必须由同一轮 market-north-america 语义审稿
    给出；没有有效语义回执时仍保持 unverified。
    """
    from .market import market_for, mismatch
    if market_for(scope_id)[0] != 'north_america' or kind not in {'script', 'outline', 'novel'}:
        return
    groups=mismatch(scope_id,text,kind)
    terms=[term for group in groups for term in group['terms']]
    market_requirements = report.setdefault('semantic_requirements', [])
    if not any(row.get('id') in {'market-north-america', 'market:north_america'}
               or row.get('requirement_id') in {'market-north-america', 'market:north_america'}
               for row in market_requirements):
        market_requirements.append({'id':'market-north-america','kind':'semantic',
            'value':'词表命中仅作为语义审稿线索，须结合上下文判断北美市场要求。',
            'scope':{'lifetime':'turn'},'status':'active','origin':'market_policy',
            'subject':'market','quote':'目标市场：北美（海外付费短剧）'})
        report.setdefault('checks', []).append({'requirement_id':'market-north-america','kind':'semantic',
            'status':'unverified','actual':terms,'target':None,'evidence':{},'issues':[]})
    report.setdefault('market_hints', []).extend({
        'group':group['group'],'terms':group['terms'],'fix':group['fix']
    } for group in groups)
    # Repeated calls must remain idempotent and must not duplicate hint cards.
    report['market_hints'] = list({json.dumps(item, ensure_ascii=False, sort_keys=True): item
                                   for item in report['market_hints']}.values())


def _validate(content,kind,session_id,llm,document_id,state):
    contract=state['contract'];text=content;digest=hashlib.sha256(text.encode()).hexdigest()
    blocked=_contract_issues(state,session_id)
    if blocked:return {'status':'unverified','checks':[],'issues':blocked}
    if document_id and requirement_revision.repairing(state,document_id,content=content,kind=kind):
        with closing(plugin_db('jubao-drama')) as conn:
            stored=conn.execute('SELECT content_sha256,report FROM agent_document_quality WHERE document_id=?', (document_id,)).fetchone()
        if stored and stored[0]==digest:
            report=json.loads(stored[1])
            report['revisions_remaining']=0
            state['last']={'content':text,'content_sha256':digest,'kind':kind,'report':report,
                           'document_id':document_id,'evidence_fingerprint':None}
            return deepcopy(report)
    reads,baseline,fingerprint,contract=_current_evidence(state,session_id)
    contract=_for_document_kind(contract,kind)
    document_contract=_document_contract(contract)
    last=state['last']
    retry_review=bool(last and llm is not None and _needs_semantic_check(last['report']))
    if last and not retry_review and last['content_sha256']==digest and last['kind']==kind and last['evidence_fingerprint']==fingerprint:
        if document_id:
            last['document_id']=document_id
            last['report']['document_id']=document_id
        cached={**deepcopy(last['report']),'document_id':document_id or last.get('document_id')}
        if requirement_revision.repairing(state,document_id,content=content,kind=kind):
            cached['revisions_remaining']=0
        if cached.get('previous_document_id')==cached.get('document_id'):
            cached.pop('previous_document_id',None);cached.pop('previous_content_sha256',None)
        return cached
    limit=_MAX_DRAFTS
    # 独立稿件分别计算新稿次数；同一正文补语义核验不占用返修预算。
    from .requirement_turn_delivery import draft_identity
    identity_key=draft_identity(document_id,session_id,kind)
    drafts=state.setdefault('draft_versions',{}).setdefault(identity_key,[])
    new_draft=digest not in drafts
    used=len(drafts)
    if new_draft and used>=limit:
        return {'status':'unverified','issues':[{'kind':'budget','code':'revision_limit','message':'本轮返修次数已用完：不要再改写或保存，保留当前稿件，在回复中如实说明未达标项，由用户决定是否继续修改。'}]}
    report=check_draft(text,kind,document_contract,baseline,reads)
    _market_check(report,text,document_contract.get('scope_id') or scope_for(session_id),kind)
    semantic_ids={r['id'] for r in report.get('semantic_requirements',[])}
    hard=[c for c in report['checks'] if c['requirement_id'] not in semantic_ids]
    objective='fail' if any(c['status']=='fail' for c in hard) else 'unverified' if not report['checks'] or any(c['status']=='unverified' for c in hard) else 'pass'
    report['objective_status']=objective
    # 工具的类型字段只能确认调用意图，正文是否真的写成剧本必须另行审读。
    report['semantic_requirements'] += [r for r in document_contract['active_requirements']
                                        if r.get('kind')=='output_kind' and r.get('status','active')=='active']
    if requirement_revision.repairing(state,document_id,content=content,kind=kind) and report.get('semantic_requirements'):
        # 修改后仅保留客观统计；不再调用审稿模型，也不把首稿结论冒充修订稿结论。
        _semantic_checks(report,{'status':'unverified','checks':[],'performed':False,'issues':[
            {'kind':'semantic','code':'revision_review_not_repeated','message':'本轮一次修改已完成，修订稿不再自动复审。'}]})
    elif objective=='pass' and report.get('semantic_requirements'):
        basis=(_relevant_reads(contract,reads,basis_only=True) if _source_read_requirements(contract) else reads)
        source_text=[{key:row[key] for key in ('path','document_id','sheet','range','file_sha256','content_sha256',
                                              'start_char','end_char','characters','text') if key in row} for row in reversed(basis)]
        if baseline:
            source_text.append({'role':'previous_manuscript','document_id':baseline.get('document_id'),
                                'content_sha256':baseline['content_sha256'],'text':baseline['content']})
        review_contract={**contract, 'market_hints': report.get('market_hints', [])}
        missing_source=[row for row in report['semantic_requirements']
                        if row.get('kind')=='source_world_continuity' and not source_text]
        if missing_source:
            semantic={'status':'unverified','checks':[],'performed':False,'issues':[
                {'kind':'semantic','code':'source_evidence_missing','requirement_id':row['id'],
                 'message':'本轮来源正文缺失或读取范围未完整核实，不能判定来源一致性通过。'} for row in missing_source]}
        else:
            semantic=semantic_review(llm,text,kind,review_contract,report['semantic_requirements'],source_text,
                                     objective_evidence={'checks':hard,'statistics':report['statistics']})
        _semantic_checks(report,semantic)
    elif objective=='pass':report['status']='pass'
    if new_draft:
        drafts.append(digest)
    attempt=drafts.index(digest)+1
    report.update(contract_revision=contract['revision'],content_sha256=digest,attempt=attempt,
        revisions_remaining=0 if requirement_revision.repairing(state,document_id,content=content,kind=kind) else max(0,limit-len(drafts)),document_id=document_id)
    if ((contract.get('current_task') or {}).get('edit_range') and baseline and baseline.get('document_id')
            and baseline['document_id']!=document_id):
        report.update(previous_document_id=baseline['document_id'],previous_content_sha256=baseline['content_sha256'])
    state['last']={'content':text,'content_sha256':digest,'kind':kind,'report':report,'document_id':document_id,
                   'evidence_fingerprint':fingerprint}
    return deepcopy(report)


def document_check(args,session_id,llm,*,document_id=None):
    from .requirement_delivery import public_report
    if set(args)-{'action','content','kind','name'}:raise ValueError('check仅接受完整content、kind及可选name')
    kind=args.get('kind','script')
    if kind not in {'script','outline','analysis','novel','document'}:raise ValueError('核验稿件类型不正确')
    report=validate(args.get('content'),kind,session_id,llm,document_id)
    if document_id:
        from .requirement_delivery import record
        record({'id':document_id,'content':args['content'],'kind':kind},session_id,
               checker=lambda _document,_session:report)
        return {'ok':True,'quality_check':public_report(report),'draft_saved':bool(_current(session_id) and _current(session_id)['last']),
                'next':requirement_revision.guidance(report,session_id)}
    return {'ok':True,'quality_check':public_report(report),'saved':False,'next':_unsaved_check_guidance(report,session_id)}


def _unsaved_check_guidance(report,session_id):
    """核验回复里的正文不产生稿件，回执必须如实说明未保存。

    2026-11-19 测试版实测：核验回执沿用已存稿件的“当前稿件已保存”，第二次又说“不再另存新版本”，
    模型据此对用户说已保存，修改版却从未落库，卡片一直停在修改前的旧稿。
    """
    from .reply_text import _creative
    if not session_id or not _creative(session_id):
        return '本次只做了核验，没有保存任何稿件；面向用户只说明核验发现的事实，不要说已保存。'
    save='drama_agent_document(action="save", kind=同一类型, name=同一稿件名, from_reply=true)'
    if report.get('status')=='fail' and report.get('revisions_remaining',0)>0:
        return ('这份稿件只做了核验，还没有保存。先用一句话说明修改什么，再在回复中写出修订后的完整正文，紧接着用 '+save+
                ' 保存（保存时会自动核验，不必再调用 check）。\n'+_feedback(report))
    if report.get('status')=='fail':
        lead,tail='修改次数已用完，这份稿件还没有保存。不要再改写，','保存后用一两句话向用户说明实际改动和仍未满足的要求。'
    else:
        lead,tail='核验已结束，但这份稿件还没有保存。','保存后再向用户交付。'
    return (lead+'紧接着用 '+save+' 保存刚核验的这份正文（不必重写，系统沿用刚核验的正文）；'+tail+
            '保存成功之前不要对用户说已保存。')


def _self_delivering(session_id):
    """自带协议、并在能力条目登记了稿件工具的 Agent（小说 Agent）：稿件由它自己保存，宿主不替它补存，也不按剧本口径核验。

    Vee 也是自带协议，但不保存稿件；正式版员工一直在用收尾补存下来的 Vee 稿件卡下载 Word，这里不改变它。
    """
    from .agent_profiles import AGENT_PROFILES, active_agent
    profile = AGENT_PROFILES.get(active_agent(session_id) or '', {})
    return bool(profile.get('own_protocol')) and 'drama_agent_document' in profile.get('host_tools', ())


def saved_quality(document,session_id,llm=None):
    if document.get('kind')=='internal':return None
    requirement_revision.track_document(_current(session_id),document)
    # 自己用稿件工具交付的自带协议 Agent（小说 Agent）按自身规则自审：宿主按剧本分集口径的要求核验与返修不适用，
    # 否则账号里“每集1000字”这类长期要求会把小说章节误判为未达标。Vee 的收尾补存稿照旧核验。
    report=None if _self_delivering(session_id) else validate(document['content'],document['kind'],session_id,llm,document['id'])
    from .requirement_turn_delivery import track
    track(_current(session_id),document,session_id)
    return report


def automatic_quality(document,session_id):
    """收尾仅复用本稿已有结论；历史协调不能拿本轮合同重验旧稿或消耗返修次数。"""
    state=_current(session_id)
    last=state.get('last') if state else None
    digest=hashlib.sha256(document['content'].encode()).hexdigest()
    if last and last['content_sha256']==digest and last['kind']==document['kind']:
        return deepcopy(last['report'])
    if document.get('quality_check'):
        return document['quality_check']
    if document.get('kind')!='internal' and state and (state['active'] or state.get('untrusted_creative')):
        return {'status':'unverified','content_sha256':digest,'contract_revision':state['contract']['revision'],
                'issues':[{'kind':'contract','code':'automatic_draft_unchecked',
                           'message':'此稿由交付收尾保存，尚无对应正文的要求核验回执，保留为待核验草稿。'}]}
    return None


def _issue_message(issue,report):
    if issue.get('message'):return str(issue['message'])
    code=issue.get('code','')
    episode=issue.get('episode')
    subject=f'第{episode}集正文' if episode is not None else '本次正文'
    if code in {'below_minimum','above_maximum'}:
        check=next((row for row in report.get('checks',[]) if row.get('requirement_id')==issue.get('requirement_id')),{})
        metric=(check.get('target') or {}).get('metric')
        unit='个汉字' if metric=='han_characters' else '个非空白字符' if metric=='non_whitespace_characters' else '字'
        actual,target=issue.get('actual'),issue.get('target')
        difference=issue.get('difference')
        # 只给差额时模型常常改过头（超上限删到低于下限）；同时给出完整区间和建议字数。
        low,high=(check.get('target') or {}).get('minimum'),(check.get('target') or {}).get('maximum')
        span_text=f'，目标区间{low}—{high}{unit}，建议改到约{(low+high)//2}{unit}' if low is not None and high is not None else ''
        # 模型数不准字但能数段：按该集现有段数等比例给出目标段数；没有段数时按每段约 34 个非空白字符、28 个汉字换算。
        # 大区间的返修目标留出模型计数与段落波动余量；这是写作建议，不改变用户合同边界。
        if low is not None and high is not None:
            width = high - low
            goal = low + round(width * 0.30) if width >= 200 else (low + high) / 2
            span_text = f'，目标区间{low}—{high}{unit}，安全目标约{round(goal)}{unit}'
        else:
            goal = target*1.1 if code=='below_minimum' else target*0.9
        lines=issue.get('lines')
        # 整集重新创作时段落长短跟着变：测试版重放中第31—35集从约1400字改到约800字、再改回约1500字；
        # 在原文上整段增删、保留的段落一字不改，字数才会按段数等比例变化。
        sentences=issue.get('sentences')
        if (isinstance(lines,int) and 0<lines<4 and isinstance(sentences,int) and sentences>=3
                and isinstance(actual,int) and actual>0):
            # 分集大纲每集只有一两段：按字数说“删去约74字”时模型删过头（测试版重放：270字左右删到110—160字），
            # 按句增删、保留的句子一字不改，字数才按比例变化。
            wanted=max(1,round(sentences*goal/actual))
            verb='补写' if code=='below_minimum' else '删去'
            return (f'{subject}实际{actual}{unit}，'+(f'少于至少{target}{unit}的要求，还差' if code=='below_minimum' else f'超过最多{target}{unit}的要求，需减少')
                    +f'{difference}{unit}{span_text}（该集现有{sentences}句，{verb}约{max(1,abs(wanted-sentences))}句，改到约{wanted}句）；'
                    +('在原段落里补写具体事件、冲突或钩子的句子，原有句子一字不改，不改动其他集。' if code=='below_minimum'
                      else '只整句删去重复或说明性的句子，保留的句子一字不改，剧情与钩子不变，不改动其他集。'))
        if isinstance(lines,int) and 0<lines<4 and isinstance(difference,int):
            # 句子太少时按字数说明。
            change=round(abs(goal-actual)) if isinstance(actual,int) else difference
            return (f'{subject}实际{actual}{unit}，少于至少{target}{unit}的要求，还差{difference}{unit}{span_text}；在原段落里补写约{change}{unit}的具体事件、'
                    '冲突或钩子，原有内容保留，不改动其他集。' if code=='below_minimum'
                    else f'{subject}实际{actual}{unit}，超过最多{target}{unit}的要求，需减少{difference}{unit}{span_text}；在原段落里删去约{change}{unit}'
                    '重复或说明性的句子，剧情与钩子不变，不改动其他集。')
        if isinstance(lines,int) and lines>0 and isinstance(actual,int) and actual>0:
            wanted=max(1,round(lines*goal/actual))
            span_text+=f'（该集现有{lines}段，{"补" if code=="below_minimum" else "删"}约{max(1,abs(wanted-lines))}段，改到约{wanted}段）'
        else:
            per=28 if metric=='han_characters' else 34
            if isinstance(difference,int) and difference>=per:
                span_text+=f'（约{"补" if code=="below_minimum" else "删"} {round(difference/per)} 段）'
        return (f'{subject}实际{actual}{unit}，少于至少{target}{unit}的要求，还差{difference}{unit}{span_text}；在原文上补写：原有段落一字不改地保留，'
                '在合适位置新增具体动作、冲突或对白段落，不重新创作这一集，不改动其他集。' if code=='below_minimum'
                else f'{subject}实际{actual}{unit}，超过最多{target}{unit}的要求，需减少{difference}{unit}{span_text}；在原文上删减：保留的段落一字不改，'
                '只整段删去重复的动作与说明性台词，不重新创作这一集，剧情与卡点不变，不改动其他集。')
    episodes='、'.join(f'第{number}集' for number in issue.get('episodes',[]))
    descriptions={
        'independent_semantic_review_required':'语义审稿尚未执行；先处理已列出的字数、范围或资料读取问题，再审核同一份正文。',
        'missing_episodes':f'本次正文缺少要求交付的{episodes}。',
        'missing_scoped_episodes':f'本次正文缺少需核验字数的{episodes}。',
        'unexpected_episodes':f'本次正文包含未授权交付的{episodes}。',
        'duplicate_episodes':f'本次正文重复出现{episodes}，请保留正确版本。',
        'episode_order':f'集数顺序不符合要求，当前顺序为{episodes}。',
        'changed_outside_edit_range':f'未经授权修改了第{episode}集，请恢复该集原文。' if episode is not None else '未经授权修改了集正文以外的原文，请恢复。',
        'changed_before_ending_boundary':f'第{episode}集结尾边界之前的原文被改动，请恢复第{issue.get("start_line")}行之前的原文，只修订工具标出的结尾。',
        'ending_boundary_unresolved':'结尾的完整段落超出默认末20%边界或尚未读到原稿，需先读稿或明确更大的修改范围，不能改写前文。',
        'ending_removed':f'第{episode}集结尾正文被删除，请保留完整结尾。',
        'episode_added_or_removed_during_edit':f'修改时新增或删除了第{episode}集，未满足保留原稿的要求。',
        'episode_sequence_changed_during_edit':'修改时改变了原稿集数或先后顺序，请按原稿范围保留。',
        'changed_outside_scene_range':'修改了指定场次以外的正文，请恢复未授权修改的场次。',
        'missing_requested_scene':'缺少指定场次'+ '、'.join(issue.get('scenes',[]))+'的完整正文，无法核验。',
        'source_read_incomplete':'指定单元格尚未完整读取，缺少'+ '、'.join(issue.get('missing_cells',[]))+ '。',
        'source_read_not_proven':'尚无当前资料版本已完整读取的证据，请读取缺失正文后再核验。',
        'unresolved_source_identity':'待核验的参考资料尚未唯一对应到原稿，请核对资料名称与版本。',
        'invalid_source_cell_range':'资料要求中的单元格范围尚未解析，请核对实际工作表和坐标。',
        'unresolved_edit_range':'修改范围尚未明确，无法核对范围外原文是否保留。',
        'ambiguous_baseline_episode_structure':'原稿集标题存在歧义，尚不能逐集比对修改范围。',
        'missing_or_foreign_baseline':'缺少属于当前会话的完整原稿，无法核验修改范围。',
        'baseline_hash_mismatch':'原稿内容与记录的版本不一致，请重新读取原稿。',
        'baseline_document_mismatch':'读取的原稿不是本轮指定稿件，请核对稿件后再修改。',
        'output_kind_mismatch':f'本次稿件类型为{issue.get("actual")}，用户要求为{issue.get("target")}。',
        'premature_finale':f'全剧共{issue.get("target")}集，第{episode}集不是结局：不要写成大结局或“全剧终”，主线冲突与核心期待保留到后面的集数，集尾留下一集的钩子。',
        'truncated_ending':f'第{episode}集在句子中途中断（末句为“{issue.get("tail","")}”），没有写完：从该集标题开始完整重写这一集，写到本集卡点为止。',
        'beyond_series_end':f'全剧共{issue.get("target")}集，本次稿件出现了第{episode}集，超出全剧集数。',
        'novelistic_prose':f'用户要求不要小说化描写，第{episode}集的动作或环境行仍有'+'、'.join(issue.get('terms',[]))+'（如“'+'”“'.join(issue.get('lines',[])[:2])+'”）：改成镜头能拍到的动作、表情和声音，不用比喻和心理描写。',
        'no_recognized_target_body':'尚未识别到需要核验的完整分集正文，请补齐对应集标题和正文。',
    }
    return descriptions.get(code,'检查项“'+(code or issue.get('kind') or '未知')+'”尚未完成核验，请保留草稿并核对具体回执。')


_EPISODE_FIXES={'below_minimum','above_maximum','premature_finale','novelistic_prose','truncated_ending'}


def _feedback(report,for_user=False):
    """先展示实际阻塞，待执行项目只说明一次，不把审核状态冒充内容缺陷。

    for_user：回合结束后追加在回复末尾、给用户看的说明，只列未达标项，不含给模型的保存与返修操作说明。
    """
    pending=[];messages=[]
    for issue in report.get('issues',[]):
        text=_issue_message(issue,report)
        target=pending if issue.get('code')=='independent_semantic_review_required' else messages
        if text not in target:target.append(text)
    visible=messages[:12]
    if len(messages)>12:visible.append(f'另有{len(messages)-12}项具体问题，完整信息见稿件核验回执。')
    if for_user:
        if not visible:
            return '这份稿件的要求核验尚未完成，结论出来后会更新到稿件上。'
        return '这份稿件还有以下地方没达到要求，可按以下问题继续调整：\n\n'+'\n'.join('- '+message for message in visible)
    visible.extend(pending[:1])
    if not visible:visible=['尚未取得完整验收结果，不能判定稿件已达标。']
    failing={issue.get('episode') for issue in report.get('issues',[]) if issue.get('code') in _EPISODE_FIXES}
    episodes={row.get('episode_number') for row in (report.get('statistics') or {}).get('episodes',[])}
    if failing and None not in failing and len(episodes)>1 and failing<episodes:
        names='、'.join(f'第{number}集' for number in sorted(failing))
        visible.append(f'返修方法：只在回复中从集标题开始完整写出修订后的{names}（在原文上按上面的段数增删，不重新创作），其余集不要写；'
                       '写完用同一名称 from_reply=true 保存，系统会把这几集替换进本批稿件后整体核验。')
    prefix=('本轮草稿需要修订，具体问题如下：' if report.get('status')=='fail'
            else '本轮草稿的核验尚未完成，以下是待处理事项；这不代表这些内容已经判定不合格：')
    return prefix+'\n\n'+'\n'.join('- '+message for message in visible)


def _needs_semantic_check(report):
    """只有此前未获得模型的稿件允许首次补审，已审失败不能自动重复检查。"""
    semantic=report.get('semantic_review') or {}
    return (report.get('status')=='unverified' and report.get('objective_status')=='pass'
            and semantic.get('performed') is False
            and any(issue.get('code')=='review_not_run' for issue in semantic.get('issues',[])))


def _as_requested(manuscript,requested):
    """回复识别出的稿件类型与用户本轮要的不一致时，按内容核对后采用用户要的类型。

    员工的分集大纲常带“【场景】【主要人物】【剧情脉络】”栏目，会被识别成剧本，进而按剧本字数核验
    （测试版重放：要第12—15集大纲，被当成剧本按每集1000—1500字判不达标）。没有一集带场次、动作行
    或台词的“剧本”按大纲处理；分析、文档类回复里带集标题的按用户要的剧本或大纲处理。
    """
    from .requirement_checks import _episodes, script_like
    rows=_episodes(manuscript['content'])
    if not rows:
        return manuscript
    if requested in {'script','outline'} and manuscript['kind'] in {'analysis','document'}:
        return {**manuscript,'kind':requested}
    if requested=='outline' and manuscript['kind']=='script' and not any(script_like(row['body']) for row in rows):
        return {**manuscript,'kind':'outline'}
    return manuscript


def pre_verify(*,session_id='',final_response='',coding=False,**_kwargs):
    """模型准备结束本轮时只处理稿件交付、客观核验与定向返修。"""
    from .creative_delegation import waiting_for_analysis
    from .agent_delivery import mark_managed_input
    state=_current(session_id)
    if state and not coding:
        mark_managed_input(session_id,state.get('delivery_input'))
        from .delivery_authorization import apply_clarification
        apply_clarification(state,session_id)
    if waiting_for_analysis(state, session_id):
        return None
    return _revision_verdict(session_id=session_id,final_response=final_response,coding=coding)


# 开关：本轮结束时是否自动追加“系统核验”和“自动返修”续轮。用户 2026-11-17 要求关闭（“感觉没什么用”）；
# 改回 True 并部署即可恢复。关闭时仍会把回复里写出但未保存的稿件补存。
AUTO_REVIEW_CONTINUATION = False


def _revision_verdict(*,session_id='',final_response='',coding=False):
    """模型准备结束本轮时把关：回复里写了稿件却没保存，就按正常流程保存并核验；未通过且还有返修机会时让本轮继续返修。

    重放正式版员工的真实会话时，多集稿件的轮次里模型常常只在回复中写出正文、不调用保存，核验只能在收尾
    进行，字数不达标也无法在本轮返修。这里在本轮结束前补上保存与核验，返回 continue 让模型只重写未达标的集。
    """
    if coding or not session_id:
        return None
    state=_current(session_id)
    # 本轮状态在模型首次保存或核验时才激活；没保存过的稿件正是这里要补核的。
    if not state:
        return None
    from .agent_profiles import active_agent
    from .reply_text import _creative
    try:
        if not _creative(session_id) or active_agent(session_id)=='oa6-1':
            return None
        # 小说 Agent 只保留它自己用工具保存的稿件。收尾补存按剧本的标题规则切分回复，测试版里把小说 Agent 的
        # 建项汇总从“3. **《第十三节车厢》**”切开，存成了一份假小说稿。
        if _self_delivering(session_id):
            return None
        if not state['last'] and not _deliverable_requested(state,session_id):
            return None
        source = (state.get('contract') or {}).get('source') or {}
        if source.get('message_uid') or source.get('message_row_id'):
            from .agent_delivery import mark_managed_turn
            mark_managed_turn(session_id, source)
        _save_checked_draft(state,session_id)
        _save_unsaved_reply(state,final_response,session_id)
    except Exception as exc:
        logging.getLogger(__name__).warning('结束前稿件核验失败（session=%s）: %s',session_id,exc,exc_info=True)
        return None
    if not AUTO_REVIEW_CONTINUATION:
        return _length_repair(state,session_id)
    from .requirement_turn_delivery import next_review
    pending=next_review(state,session_id)
    if pending is not None:
        return pending
    requested=requirement_revision.begin_repair(state,session_id)
    if not requested:
        return None
    issues=[row['name']+'：\n'+_feedback(row['report']) for row in requested]
    return {'action':'continue','message':'【以下稿件各自仅修改一次】'+ '\n\n'.join(issues)+
            '\n只处理各稿的具体问题，沿用各自原名保存，不再次检查同稿。其他独立新内容仍有自己的首次核验和一次修改。'
            '先用一句话流式说明修改什么，再输出需修改的正文并用 drama_agent_document(action="save", from_reply=true) 保存。'
            '结束时用一两句话说明实际修改；不输出通过、未通过或达标标签，不再复述全稿。'}


_LENGTH_CODES={'below_minimum','above_maximum'}


def _length_repair(state,session_id):
    """自动核验续轮关闭时，能力目录标了 length_revision 的主 Agent（Agent2.2）仍对字数不达标的稿件当轮返修一次。

    只交字数问题，不追加系统语义核验续轮；每份稿件只领取一次（requirement_revision.begin_repair），其他 Agent 维持关闭。
    2026-11-23 测试版：模型写完不调保存，收尾补存判三集低于下限却无人修订，员工拿到的是偏短稿。
    """
    from .agent_profiles import active_profile
    if not active_profile(session_id).get('length_revision'):
        return None
    current=requirement_revision.cycle(state)
    eligible=[]
    with closing(plugin_db('jubao-drama')) as conn:
        for identifier,target in current['targets'].items():
            if target['repair_requested'] or identifier in current['revised']:
                continue
            row=conn.execute('SELECT report FROM agent_document_quality WHERE document_id=?',(identifier,)).fetchone()
            report=json.loads(row[0]) if row else {}
            if (report.get('status')=='fail' and report.get('revisions_remaining',0)>0
                    and any(issue.get('code') in _LENGTH_CODES for issue in report.get('issues',[]))):
                eligible.append(identifier)
    requested=requirement_revision.begin_repair(state,session_id,eligible) if eligible else []
    if not requested:
        return None
    issues=[]
    for row in requested:
        report=row['report']
        length={**report,'issues':[issue for issue in report.get('issues',[]) if issue.get('code') in _LENGTH_CODES]}
        issues.append(row['name']+'：\n'+_feedback(length))
    return {'action':'continue','message':'【以下稿件仅按字数修改一次】'+'\n\n'.join(issues)+
            '\n只调整篇幅：保留已写的剧情、人物、台词意图、集尾卡点和格式，不足补具体动作与冲突，超出删重复动作与说明性台词，不灌水。'
            '沿用各自原名保存，不再次检查同稿。先用一句话流式说明修改什么，再输出需修改的正文并用 '
            'drama_agent_document(action="save", from_reply=true) 保存。结束时用一两句话说明实际修改；'
            '不输出通过、未通过或达标标签，不再复述全稿。'}


def _deliverable_requested(state,session_id):
    """本轮用户是否要了稿件：要求清单里有本轮的稿件类型或集数，或原话里有“写/续写/生成…剧本/大纲”。

    只让读稿、提问、分析的轮次（如“请你读取一下剧本内容”）不被当成交付：模型复述用户原稿时，
    原稿里的写法不能算作本轮稿件去核验。
    """
    contract=state['contract']
    text=((state.get('contract') or {}).get('source') or {}).get('original_text') or ''
    if not text:
        return False
    # “改编方案为什么…”中的“改编”是名词的一部分，纯问题不能变成自动存稿授权。
    direct=_authored_request(text)
    question=re.fullmatch(r'[^。！？?\n]*(?:为什么|怎么|如何|是什么|什么意思|是否|能否|可否)[^。！？?\n]*[？?]?',direct)
    requested=re.search(r'(?:帮我|替我|为我|请|我要|我想)[^。！？\n]{0,12}(?:写|生成|输出|制作|保存|导出)|'
                        r'^(?:(?:能否|可否|是否可以|你可以|你能|可以)\s*)?(?:写|撰写|生成|输出|给我|制作|保存|导出)',direct)
    if question and not requested:
        return False
    if requested:
        return True
    if any(row.get('kind') in {'output_kind','episode_range','edit_range'} for row in contract.get('active_requirements',[])):
        return True
    from .plain_documents import _delivery_requested
    if _delivery_requested(text):
        return True
    from .task_requirement_extract import extract
    try:
        from .agent_profiles import active_agent
        return bool(extract({'original_text':text,'wrapper_settings':{}},{},selected_agent=active_agent(session_id) or '')[1].get('creative'))
    except Exception:
        return False


def _requested_kind(state,session_id):
    contract=state['contract']
    return next((row.get('value') for row in contract.get('active_requirements',[]) if row.get('kind')=='output_kind'),None)


def _save_checked_draft(state,session_id):
    """本轮核验过、模型却没保存的最后一版在收尾时补存，卡片才显示最新稿。

    先于回复补存执行：最终回复若又写出更新的正文，会作为更新版本保存；与刚补存的相同则按摘要去重。
    """
    from . import reply_text
    pending=reply_text.take_checked(session_id,state.get('turn_id'))
    if not pending:
        return
    from .agent_delivery import _auto_capture_allowed
    from .agent_documents import document_action
    request=((state.get('contract') or {}).get('source') or {}).get('original_text') or ''
    task=(state.get('contract') or {}).get('current_task') or {}
    if task.get('read_only') or task.get('correction_only') or not _auto_capture_allowed(request):
        return
    saved=document_action({'action':'save','kind':pending['kind'],'name':pending['name'],'content':pending['content']},session_id,
                          quality_checker=lambda document,session:saved_quality(document,session,None),defer_revision=True)
    key=(reply_text.hermes_home_key(),session_id)
    reply_text._NAMES[key]=(saved.get('document') or {}).get('name') or pending['name']


def _save_unsaved_reply(state,response_text,session_id):
    """回复中未保存的稿件走与工具保存相同的流程；只重写了未达标几集时先合并回整批稿件。"""
    from .agent_delivery import _auto_capture_allowed, _manuscripts
    from .agent_documents import document_action
    from . import reply_text
    from .requirement_checks import merge_revised_episodes
    request=((state.get('contract') or {}).get('source') or {}).get('original_text') or ''
    task=state.get('contract',{}).get('current_task') or {}
    if task.get('read_only') or task.get('correction_only') or not _auto_capture_allowed(request):
        return
    from .agent_delivery import _clean
    from .requirement_checks import _episodes
    requested=_requested_kind(state,session_id)
    if not state.get('last'):
        from .continuation_context import merge_unfinished_reply
        response_text=merge_unfinished_reply(state['contract'],response_text or '')
    manuscripts=_manuscripts(response_text or '',request, allow_fallback=not bool(state.get('delivery_checks') or state.get('last')))
    whole=_clean(response_text or '')
    if requested in {'script','outline'} and len(manuscripts)>1 and _episodes(whole):
        # 用户本轮要的是一份大纲或一批剧本：回复里按“阶段”“一、二、三”分节写出时仍是同一份稿件。
        from .reply_text import _PREAMBLE
        lines=whole.splitlines()
        while lines and (not lines[0].strip() or _PREAMBLE.match(lines[0])):
            lines=lines[1:]
        manuscripts=[{'kind':requested,'name':manuscripts[0]['name'],'content':'\n'.join(lines).strip()}]
    for manuscript in manuscripts:
        manuscript=_as_requested(manuscript,requested)
        # 分集正文仍需真实集标题；明确识别出的分析、方案与资料稿在补建议卡之前同样保存核验。
        if manuscript['kind'] not in {'analysis', 'document', 'novel', 'outline', 'script'}:
            continue
        if manuscript['kind'] == 'script' and not _episodes(manuscript['content']):
            continue
        content,name=manuscript['content'],manuscript['name']
        last=state['last']
        if last and hashlib.sha256(content.encode()).hexdigest()==last['content_sha256']:
            continue
        base=revision_base(session_id,manuscript['kind']) if len(manuscripts)==1 and manuscript['kind'] in {'script','outline'} else None
        merged=merge_revised_episodes(base,content) if base else None
        key=(reply_text.hermes_home_key(),session_id)
        if merged:
            content=merged
        if merged or (len(manuscripts)==1 and manuscript['kind'] in {'script','outline'}
                      and reply_text._revises_last_draft(session_id,manuscript['kind'],content)):
            name=reply_text._NAMES.get(key) or name
        # pre_verify 钩子只有 30 秒，这里仅保存并做客观核验；独立语义审核由下一轮既有 check 工具完成。
        saved=document_action({'action':'save','kind':manuscript['kind'],'name':name,'content':content},session_id,
                              quality_checker=lambda document,session:saved_quality(document,session,None), defer_revision=True)
        reply_text._NAMES[key]=(saved.get('document') or {}).get('name') or name


_LABEL_KEYS=('label','title','name','action','option')
_PROMPT_KEYS=('prompt','content','message','request','text','value','description')


def _normalize_suggestions(text):
    """前端只认 label/prompt：模型写成 title/content 等近义字段时整张卡片不显示（测试版重放中出现过），收尾时统一改正。"""
    def fix(match):
        body=match.group(2)
        try:
            # 与前端一致：去掉 ]、} 前多余的逗号，引号内的内容不动。
            values=json.loads(re.sub(r'("(?:\\.|[^"\\])*")|,\s*([}\]])',lambda m:m.group(1) or m.group(2),
                                     re.sub(r'^json[ \t]*\r?\n','',body.strip(),flags=re.I)))
        except ValueError:
            return match.group(0)
        if isinstance(values,dict):
            values=next((values[key] for key in ('suggestions','options','items') if key in values),values)
        if not isinstance(values,list):
            return match.group(0)
        cards=[]
        for item in values:
            if not isinstance(item,dict):
                continue
            label=next((item[key] for key in _LABEL_KEYS if isinstance(item.get(key),str) and item[key].strip()),'')
            prompt=next((item[key] for key in _PROMPT_KEYS if isinstance(item.get(key),str) and item[key].strip()),'') or label
            if not label and prompt:
                label=prompt
            if not label:
                continue
            card={'label':label.strip().splitlines()[0][:30],'prompt':prompt.strip()}
            if item.get('recommended') is True and not any(row.get('recommended') for row in cards):
                card['recommended']=True
            cards.append(card)
        if not cards or cards==values:
            return match.group(0)
        return match.group(1)+json.dumps(cards,ensure_ascii=False)+match.group(3)
    return re.sub(r'((?:^|\n)[ \t]*```[ \t]*studio-suggestions[ \t]*\r?\n)([\s\S]*?)(\r?\n[ \t]*```)',fix,text or '',flags=re.I)


def transform_llm_output(*,response_text='',session_id='',turn_id='',**_kwargs):
    """保留模型的流式修改说明，只规范下一步卡片并去掉上游截断留下的符号乱码；内部核验状态不追加到正文。"""
    from .agent_delivery import SYMBOL_RUN_NOTE, strip_symbol_runs
    text,_=strip_symbol_runs(response_text or '','\n\n'+SYMBOL_RUN_NOTE+'\n\n')
    fixed=_normalize_suggestions(text)
    return fixed if fixed!=(response_text or '') else None



def on_session_end(*,session_id='',turn_id='',**_kwargs):
    """交付收尾完成后仅清理当前轮内存；已保存正文及阅读证据继续保留。"""
    with _LOCK:
        state=_TURNS.get(_key(session_id))
        if state and turn_id==state['turn_id']:
            from .agent_delivery import mark_managed_input
            mark_managed_input(session_id,state.get('delivery_input'))
            del _TURNS[_key(session_id)]

"""稿件质量回执与原文字节绑定，保存草稿不等于用户要求已经通过。"""
from contextlib import closing
from copy import deepcopy
import hashlib
import json

from plugins.plugin_storage import plugin_db


def quality_summary(report):
    """稿件目录与资料卡只承担状态展示，详细修订依据由工具顶层给出一次。"""
    if not isinstance(report,dict):return report
    return {key:report[key] for key in ('status','objective_status','content_sha256','contract_revision',
                                      'previous_document_id','previous_content_sha256') if key in report} | {
        'issues_count':len(report.get('issues',[]))}


def _public_issues(issues):
    grouped={}
    for issue in issues:
        row=deepcopy(issue)
        identifier=row.pop('requirement_id',None)
        identity=json.dumps(row,ensure_ascii=False,sort_keys=True)
        existing=grouped.setdefault(identity,row)
        if identifier:
            existing.setdefault('requirement_ids',[])
            if identifier not in existing['requirement_ids']:existing['requirement_ids'].append(identifier)
    return list(grouped.values())


def public_report(report):
    """不改内部完整报告；模型得到客观数值、逐项状态与一次完整失败修订依据。"""
    if not isinstance(report,dict):return report
    result={key:deepcopy(report[key]) for key in ('status','objective_status','contract_revision','content_sha256',
            'attempt','revisions_remaining','document_id','statistics','previous_document_id','previous_content_sha256') if key in report}
    result['issues']=_public_issues(report.get('issues',[]))
    # 除代码与数字外附上可执行的修改指引（含目标区间与建议字数），避免模型改过头或整集重写。
    from .requirement_control import _issue_message
    for issue in result['issues']:
        if issue.get('code')!='independent_semantic_review_required' and not issue.get('message'):
            issue['message']=_issue_message(issue,report)
    result['checks']=[]
    objective={'min_words','episode_range','output_kind','edit_range','source_read'}
    for check in report.get('checks',[]):
        row={key:deepcopy(check[key]) for key in ('requirement_id','kind','status','actual') if key in check}
        if check.get('kind') in objective:
            if 'target' in check:row['target']=deepcopy(check['target'])
            evidence=deepcopy(check.get('evidence',{}))
            if report.get('status')=='pass':
                for boundary in evidence.get('ending_boundaries',[]):
                    boundary.pop('locked_prefix',None);boundary.pop('original_ending',None)
            if evidence:row['evidence']=evidence
        result['checks'].append(row)
    semantic=report.get('semantic_review')
    if isinstance(semantic,dict):
        result['semantic_review']={key:deepcopy(semantic[key]) for key in
            ('status','performed','content_sha256','contract_revision','receipt_id') if key in semantic}
    return result


def create_table(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS agent_document_quality "
                 "(document_id TEXT PRIMARY KEY,content_sha256 TEXT NOT NULL,report TEXT NOT NULL)")


def record(document, session_id, checker=None, *, historical=False):
    if checker is None:
        from .requirement_control import saved_quality
        checker = saved_quality
    report = checker(document, session_id)
    if report is None:
        if historical:
            return document.get('quality_check')
        report = document.get('quality_check')
        if report is None:
            return None
        from .creative_scope import scope_for
        from .ledger import check_contract
        current = check_contract(scope_for(session_id), session_id, '')
        if current['revision'] != report.get('contract_revision'):
            report = {'status': 'unverified', 'contract_revision': current['revision'],
                      'issues': [{'kind': 'contract', 'code': 'contract_changed',
                                  'message': '用户要求已更新，旧稿通过的是历史要求，当前稿件需要按新要求重新核验。'}]}
    digest = hashlib.sha256(document['content'].encode()).hexdigest()
    with closing(plugin_db('jubao-drama')) as conn:
        create_table(conn)
        conn.execute('INSERT OR REPLACE INTO agent_document_quality VALUES(?,?,?)',
                     (document['id'], digest, json.dumps(report, ensure_ascii=False)))
        conn.commit()
    return report


def annotate(document, digest, raw_report):
    if not raw_report or digest != hashlib.sha256(document['content'].encode()).hexdigest():
        return
    report = json.loads(raw_report)
    document['quality_check'] = report
    document.update({key:report[key] for key in ('previous_document_id','previous_content_sha256') if key in report})
    document['quality_check_scope'] = '记录的用户要求版本 ' + str(report.get('contract_revision', '未知'))
    document['status'] = 'checked' if report['status'] == 'pass' else 'revision_required'


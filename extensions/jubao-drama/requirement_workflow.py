"""OA6批次也按真实稿件核验，原有人工确认与独立审稿流程继续生效。"""
from .requirement_control import saved_quality


def check_saved_batch(store, project, kind, data, session_id, llm):
    if kind not in {'script_batch', 'outline_batch'}:
        return project, None
    batches = project[kind.removesuffix('_batch') + '_batches']
    batch = next((row for row in batches if row['id'] == data.get('id')), batches[-1])
    report = saved_quality({'id': batch['id'], 'kind': batch['kind'], 'content': batch['content']}, session_id, llm)
    if report is None:
        return project, None
    with store.transaction() as conn:
        current = store.get(project['id'], conn)
        stored = store._find_batch(current, batch['id'])
        if stored['content_hash'] != batch['content_hash']:
            raise ValueError('核验期间稿件发生变化，请重新核验当前稿件')
        stored['quality_check'] = report
        project = store.save(current, conn)
    return project, report


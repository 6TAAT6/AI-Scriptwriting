import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StudioPresentation } from '../presentation.mjs'
import { FileHandles } from '../file-handles.mjs'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('稿件 Word 回执绑定当前下载账号并保留来源编号，失败时保留已保存正文', async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-word-receipt-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  const workspace = path.join(home, 'workspace')
  await mkdir(workspace)
  const file = path.join(workspace, '第一批.docx')
  await writeFile(file, '已生成文件')
  const user = { id: 'employee', role: 'employee', profile: 'studio-employee' }
  const backend = { homeFor: () => home, file: async (_user, value) => value }
  backend.files = new FileHandles(backend)
  const presentation = new StudioPresentation(backend)
  const receipt = { path: file, name: '第一批.docx', artifact_id: 'v1', format: 'docx', kind: 'script', status: 'draft', content_verified: true, layout_verified: false, secret: '隐藏字段' }
  const project = { id: 'p1', artifacts: [{ id: 'v1', name: '第一批', content: '△她推门。' }], exports: [receipt] }
  const result = await presentation.toolResultAs(user, user, 'drama_agent_document', { ok: true, receipt, project })
  assert.equal(result.receipt.path, result.project.exports[0].path)
  assert.equal(result.receipt.artifact_id, 'v1')
  assert.equal((await backend.files.resolveEntry(user, result.receipt.path)).path, file)
  await assert.rejects(backend.files.resolveEntry({ ...user, id: 'another' }, result.receipt.path))
  assert.ok(!JSON.stringify(result).includes(home))
  assert.ok(!JSON.stringify(result).includes('隐藏字段'))
  const failed = await presentation.toolResultAs(user, user, 'drama_agent_document', { ok: false, saved: true, export_status: 'failed', export_error: '内部路径/private/logs', project })
  assert.equal(failed.saved, true)
  assert.equal(failed.project.artifacts[0].content, '△她推门。')
  assert.match(failed.export_error, /Word/)
  assert.ok(!JSON.stringify(failed).includes('/private/logs'))
})

test('紧凑历史缺少技能回执时不虚构成功，完整错误回执仍标记失败', async () => {
  const user = { id: 'employee', role: 'employee', profile: 'studio-employee' }
  const presentation = new StudioPresentation({ files: {} })
  const failed = JSON.stringify({ error: '请先在用户消息中明确调用一个剧本 Agent。' })
  const rows = await presentation.messages(user, [
    { role: 'tool', name: 'skill_view', tool_call_id: 'missing' },
    { role: 'tool', name: 'skill_view', tool_call_id: 'empty', text: '' },
    { role: 'tool', name: 'skill_view', tool_call_id: 'failed', content: failed },
    { role: 'tool', name: 'skill_view', tool_call_id: 'loaded', content: { success: true, content: '规则正文' } }
  ])
  assert.equal(rows[0].content, null)
  assert.equal(rows[1].content, null)
  assert.equal(rows[2].content.ok, false)
  assert.match(rows[2].content.summary, /失败/)
  assert.equal(rows[3].content.ok, true)
  assert.match(rows[3].content.summary, /完成/)
  assert.ok(!JSON.stringify(rows).includes('规则正文'))
})

test('独立技能保存的稿件通过业务投影保留正文，内部字段不进入界面', async () => {
  const user = { id: 'employee', role: 'employee', profile: 'studio-employee' }
  const presentation = new StudioPresentation({ files: {} })
  const result = await presentation.toolResultAs(user, user, 'drama_agent_document', { ok: true, project: {
    id: 'draft', title: '第一集', stage: 'skill', agent_id: 'independent-skills',
    artifacts: [{ id: 'v1', name: '第一集优化稿', content: '人物甲：门开着。', internal: '不应显示' }]
  } }, {})
  assert.deepEqual(result.project.artifacts, [{ id: 'v1', name: '第一集优化稿', content: '人物甲：门开着。', content_sha256: createHash('sha256').update('人物甲：门开着。').digest('hex') }])
  assert.ok(!JSON.stringify(result).includes('不应显示'))
})

test('稿件质量回执公开 document_id 与前版 lineage，供客户端安全合并返修', async () => {
  const user = { id: 'employee', role: 'employee', profile: 'studio-employee' }
  const previousHash = 'a'.repeat(64)
  const presentation = new StudioPresentation({ files: {} })
  const result = await presentation.toolResultAs(user, user, 'drama_agent_document', { ok: true,
    quality_check: { status: 'fail', document_id: 'doc-new', previous_document_id: 'doc-old', previous_content_sha256: previousHash },
    project: { id: 'p', artifacts: [{ id: 'doc-new', name: '第2集正文', content: '修订正文', source_message_id: 'm2',
      previous_document_id: 'doc-old', previous_content_sha256: previousHash }] } })
  assert.deepEqual(result.quality_check, { status: 'fail', document_id: 'doc-new', previous_document_id: 'doc-old', previous_content_sha256: previousHash, issues: [] })
  assert.deepEqual(result.project.artifacts[0], { id: 'doc-new', name: '第2集正文', content: '修订正文', source_message_id: 'm2', previous_document_id: 'doc-old', previous_content_sha256: previousHash, content_sha256: createHash('sha256').update('修订正文').digest('hex') })
})

test('普通账号与管理员的错误事件都返回中文，不暴露底层名称', async () => {
  for (const role of ['employee', 'super_admin']) {
    const presentation = new StudioPresentation({ files: {}, runtimeOwners: new Map([['s', role]]) })
    const user = { id: role, role, profile: 'studio-test' }
    const event = await presentation.event(user, { method: 'event', params: { type: 'error', session_id: 's', payload: {
      message: "Hermes can't reach the model provider. You may be offline. Check your internet connection and try again."
    } } }, new Map())
    assert.equal(event.params.payload.message, '暂时无法连接创作服务，请稍后重试。')
    const reply = await presentation.rpc(user, { method: 'prompt.submit', params: {} }, { id: 1, error: { code: 503, message: 'Hermes provider request timed out' } })
    assert.equal(reply.error.code, 503)
    assert.match(reply.error.message, /[\u3400-\u9fff]/)
    assert.ok(!reply.error.message.includes('Hermes'))
  }
})

test('业务拒绝保留不可重试动作，旧式非 JSON 工具错误不再伪装成成功', async () => {
  const user = { id: 'employee', role: 'employee', profile: 'studio-test' }
  const presentation = new StudioPresentation({ files: {} })
  const blocked = await presentation.toolResultAs(user, user, 'drama_submit', {
    ok: false, error: '先完成新纲的独立审稿和正式验收', blocked_reason: 'workflow_precondition',
    required_user_action: '先完成独立审核和正式验收。', retryable: false,
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.retryable, false)
  assert.equal(blocked.blocked_reason, 'workflow_precondition')
  assert.equal(blocked.summary, '先完成独立审核和正式验收。')

  const legacy = await presentation.toolResultAs(user, user, 'drama_review', '[TOOL_ERROR] Tool execution failed: APIConnectionError: Connection error.')
  assert.equal(legacy.ok, false)
  assert.equal(legacy.error_kind, 'tool_execution_error')
})

test('稿件核验结论只带公开部分：是否通过、剩余返修次数、问题类型与集号差额', async () => {
  const user = { id: 'employee', role: 'employee', profile: 'studio-employee' }
  const presentation = new StudioPresentation({ files: {} })
  const result = await presentation.toolResultAs(user, user, 'drama_agent_document', { ok: true, saved: true,
    project: { id: 'p', artifacts: [{ id: 'v1', name: '第04—05集 剧本正文', content: '△她推门。' }] },
    quality_check: { status: 'fail', revisions_remaining: 1, contract_revision: 7, statistics: { secret: '内部统计' },
      issues: [{ code: 'above_maximum', episode: 5, difference: 313, message: '第5集正文实际1413个汉字……', requirement_id: 'R1' }, { code: 'market_mismatch', terms: ['督军'] }] } })
  assert.deepEqual(result.quality_check, { status: 'fail', revisions_remaining: 1,
    issues: [{ code: 'above_maximum', episode: 5, difference: 313 }, { code: 'market_mismatch' }] })
  assert.ok(!JSON.stringify(result).includes('内部统计'))
})

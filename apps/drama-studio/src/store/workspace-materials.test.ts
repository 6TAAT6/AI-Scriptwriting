import { expect, it } from 'vitest'
import type { SessionMaterials } from '../lib/creative'
import { Workspace, type WorkspaceApi } from './workspace'

function materials(stage: string): SessionMaterials {
  return { project: { id: 'project', title: '并发创作', stage, artifacts: [] }, sources: [{ id: stage, name: `${stage}.md`, kind: 'source' }] }
}

it('并发刷新资料只采用最新请求，旧响应或失败不能回退稿件和阶段', async () => {
  const pending: { resolve: (value: SessionMaterials) => void; reject: (error: Error) => void }[] = []
  const local = new Workspace({ profile: 'materials', rpc: () => { throw new Error('读取资料不应调用创作模型') },
    materials: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) })
  local.session.set({ runtimeId: 'live', storedId: 'saved', info: {} })
  const old = local.loadMaterials()
  const staleFailure = local.loadMaterials()
  const latest = local.loadMaterials()
  pending[2].resolve(materials('M5'))
  await latest
  pending[0].resolve(materials('M1'))
  pending[1].reject(new Error('旧请求超时'))
  await Promise.all([old, staleFailure])
  expect.soft(local.project.get()?.stage).toBe('M5')
  expect.soft(local.sources.get().map(row => row.name)).toEqual(['M5.md'])
  expect.soft(local.materialError.get()).toBe('')
})

it('资料刷新期间的新回执保留最新阶段，同时合并资料库恢复的历史稿件', async () => {
  let finish!: (value: SessionMaterials) => void
  const local = new Workspace({ profile: 'materials', rpc: () => { throw new Error('读取资料不应调用创作模型') },
    materials: () => new Promise(resolve => { finish = resolve }) })
  local.session.set({ runtimeId: 'live', storedId: 'saved', info: {} })
  local.conversation.set({ runtimeId: 'live', entries: [], running: true, error: '' })
  const loading = local.loadMaterials()
  local.receive({ type: 'tool.complete', session_id: 'live', payload: { tool_id: 'save', name: 'drama_project', result: { project: { id: 'project', title: '并发创作', stage: 'M5', exports: [{ path: '/作品/成稿.docx' }] } } } })
  const restored = materials('M1')
  restored.project!.artifacts.push({ id: 'older', name: '历史剧情分析', content: '女主正在核对旧账。', kind: 'result' })
  finish(restored)
  await loading
  expect(local.project.get()?.stage).toBe('M5')
  expect(local.project.get()?.artifacts.map(row => row.name).sort()).toEqual(['历史剧情分析', '成稿.docx'])
})

it('独立技能稿件可预览，其他 Agent 的迟到进度不能覆盖当前稿件', () => {
  const local = new Workspace({ profile: 'skills', rpc: () => { throw new Error('不调用模型') }, materials: async () => ({ project: null, sources: [] }) })
  local.session.set({ runtimeId: 'live', storedId: 'saved', info: {} })
  local.conversation.set({ runtimeId: 'live', running: false, error: '', entries: [
    { id: 'u1', role: 'user', text: '调用巨豹skill-去AI味', calls: [] }
  ] })
  local.receive({ type: 'tool.complete', session_id: 'live', payload: { tool_id: 'doc', name: 'drama_agent_document', result: {
    project: { id: 'independent', title: '润色稿', stage: 'skill', agent_id: 'independent-skills', artifacts: [{ id: 'v1', name: '优化对白', content: '人物甲：门开着。' }] }
  } } })
  expect(local.project.get()?.artifacts).toContainEqual({ id: 'v1', name: '优化对白', content: '人物甲：门开着。', kind: 'result' })
  local.conversation.set({ ...local.conversation.get(), entries: [
    { id: 'u2', role: 'user', text: '调用巨豹 Agent-适配 GR4.7 版本', calls: [] }
  ] })
  local.receive({ type: 'tool.complete', session_id: 'live', payload: { tool_id: 'new', name: 'drama_agent_document', result: {
    project: { id: 'new', title: '当前稿件', stage: 'skill', agent_id: 'gr4-7', artifacts: [] }
  } } })
  local.receive({ type: 'tool.complete', session_id: 'live', payload: { tool_id: 'old', name: 'drama_project_status', result: {
    project: { id: 'old', title: '旧项目', stage: 'H1' }
  } } })
  expect(local.project.get()?.id).toBe('new')
})

it('资料快照等待期间成功发送的新附件不会被旧原稿列表清空', async () => {
  let finish!: (value: SessionMaterials) => void
  const local = new Workspace({ profile: 'materials',
    rpc: (async method => {
      if (method === 'prompt.submit') return { status: 'streaming' }
      throw new Error('本测试只提交已上传原稿')
    }) as WorkspaceApi['rpc'], materials: () => new Promise(resolve => { finish = resolve }) })
  local.session.set({ runtimeId: 'live', storedId: 'saved', info: {} })
  local.conversation.set({ runtimeId: 'live', entries: [], running: false, error: '' })
  local.editComposer({ text: '分析新上传的原稿', attachments: [{ attached: true, uploaded: true, name: '新原稿.md',
    path: '/作品/新原稿.md', ref_path: '/作品/新原稿.md', ref_text: '@file:`/作品/新原稿.md`' }] })
  const loading = local.loadMaterials()
  await local.send()
  expect(local.composer.get().attachments).toEqual([])
  expect(local.sources.get().map(row => row.name)).toEqual(['新原稿.md'])
  finish({ project: null, sources: [] })
  await loading
  expect(local.sources.get().map(row => row.name)).toEqual(['新原稿.md'])
})

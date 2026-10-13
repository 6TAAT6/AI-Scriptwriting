import { afterEach, expect, it, vi } from 'vitest'
import { StudioGateway } from './gateway'
import { Workspace } from '../store/workspace'
import { JsonRpcRequestChannel, type ServerRequest } from '../../../shared/src/json-rpc-channel'
import { refreshCsrfToken } from '../accounts/api'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('缺少文案的失败响应仍显示可读提示并保留错误状态', async () => {
  const channel = new JsonRpcRequestChannel()
  let outgoing: { id: string } | undefined
  channel.attach({ send: text => { outgoing = JSON.parse(text) } })
  const result = channel.request('session.list').catch(error => error)
  channel.handleFrame(JSON.stringify({ jsonrpc: '2.0', id: outgoing!.id, error: { code: 503 } }))
  const error = await result
  channel.detach(new Error('测试结束'))
  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ code: 503, message: expect.stringMatching(/[\u3400-\u9fff]/) })
})

it.each(['materials', 'file'] as const)('旧账号迟到的 %s 请求401不能退出新账号', async method => {
  const pending: ((value: Response) => void)[] = []
  vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { pending.push(resolve) }))
  const gateway = new StudioGateway()
  gateway.profile = 'account-a'
  const expired = vi.fn()
  window.addEventListener('studio:auth-expired', expired)
  try {
    const reading = method === 'materials' ? gateway.materials('session-a') : gateway.file('/old-script.md', 'session-a')
    gateway.stop()
    gateway.profile = 'account-b'
    for (const resolve of pending) resolve(new Response('{}', { status: 401 }))
    await expect(reading).rejects.toThrow()
    expect(expired).not.toHaveBeenCalled()
  } finally { window.removeEventListener('studio:auth-expired', expired) }
})

it('正式资料库恢复旧稿并合并 OA 阶段成果，保留每类每批文件与来源消息', async () => {
  refreshCsrfToken('material-test-csrf')
  const calls: { path: string; options?: RequestInit }[] = []
  vi.stubGlobal('fetch', async (input: URL | string, options?: RequestInit) => {
    const path = String(input)
    calls.push({ path, options })
    if (path === '/studio/session-documents') return new Response(JSON.stringify({ ok: true, project: {
      id: 'agent-docs', title: '创作稿件', agent_id: 'oa6-1', stage: 'skill',
      artifacts: [{ id: 'old-novel', name: '旧小说第一批', content: '第一章\n\n很久以前的已保存正文。', kind: 'novel', source_message_id: 12 }],
      exports: [{ artifact_id: 'old-novel', path: '/assets-data/old/小说.docx', name: '小说.docx', format: 'docx' }]
    } }))
    return new Response(JSON.stringify({ messages: [
      { role: 'user', content: '@file:`/assets-data/source/原稿.md`' },
      { role: 'tool', tool_call_id: 'oa-save', content: { ok: true, project: {
        id: 'oa-project', agent_id: 'oa6-1', stage: 'M3', script_batches: [{ id: 'script', content: '第八集\n\n△她打开门。' }],
        exports: [{ artifact_id: 'script', path: '/assets-data/new/剧本.docx', name: '剧本.docx', format: 'docx' }]
      } } }
    ] }))
  })
  const gateway = new StudioGateway()
  const result = await gateway.materials('saved-session')
  expect(result.project?.stage).toBe('M3')
  expect(result.project?.artifacts).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'old-novel', sourceMessageId: '12', documentKind: 'novel', downloadPath: '/assets-data/old/小说.docx' }),
    expect.objectContaining({ id: 'script', downloadPath: '/assets-data/new/剧本.docx' })
  ]))
  expect(result.project?.artifacts.filter(row => row.kind === 'document').map(row => row.path).sort()).toEqual(['/assets-data/new/剧本.docx', '/assets-data/old/小说.docx'])
  expect(result.sources.map(row => row.name)).toEqual(['原稿.md'])
  const request = calls.find(row => row.path === '/studio/session-documents')
  expect(request?.options).toMatchObject({ method: 'POST', headers: { 'X-Studio-CSRF': 'material-test-csrf' } })
  expect(JSON.parse(String(request?.options?.body))).toEqual({ session_id: 'saved-session' })
})

it('并发start必须等真实WebSocket打开后才返回成功', async () => {
  vi.useFakeTimers()
  class Socket extends EventTarget {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSED = 3
    static current: Socket
    readyState = 0
    constructor(_url: string) { super(); Socket.current = this }
    send(_text: string) {}
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  }
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ profile: 'account-a' })))
  const gateway = new StudioGateway()
  const first = gateway.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(gateway.connectionState).toBe('connecting')
  let secondResult: boolean | undefined
  const second = gateway.start().then(result => { secondResult = result; return result })
  await vi.advanceTimersByTimeAsync(0)
  const beforeOpen = secondResult
  Socket.current.open()
  const results = await Promise.all([first, second])
  gateway.stop()
  expect(beforeOpen).toBeUndefined()
  expect(results).toEqual([true, true])
})

it('连接中断后自动重连并通知恢复，退出后不再尝试连接', async () => {
  vi.useFakeTimers()
  class Socket extends EventTarget {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSED = 3
    static instances: Socket[] = []
    readyState = 0
    constructor(_url: string) { super(); Socket.instances.push(this) }
    send(_text: string) {}
    close() { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code: 1006 })) }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  }
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ profile: 'account-a' })))
  const gateway = new StudioGateway(), recovered = vi.fn()
  window.addEventListener('studio:reconnected', recovered)
  try {
    const initial = gateway.start()
    await vi.advanceTimersByTimeAsync(0)
    Socket.instances[0].open(); await initial
    Socket.instances[0].close()
    await vi.advanceTimersByTimeAsync(2000)
    expect(Socket.instances).toHaveLength(2)
    Socket.instances[1].open()
    await vi.advanceTimersByTimeAsync(0)
    expect(gateway.connectionState).toBe('open')
    expect(recovered).toHaveBeenCalledTimes(1)
    gateway.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(Socket.instances).toHaveLength(2)
  } finally { gateway.stop(); window.removeEventListener('studio:reconnected', recovered) }
})

it('bootstrap返回401时停止重连并通知登录状态失效', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: '请先登录' }), { status: 401 }))
  const gateway = new StudioGateway(), expired = vi.fn()
  window.addEventListener('studio:auth-expired', expired)
  try {
    await expect(gateway.start()).rejects.toThrow(/请先登录/)
    expect(expired).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(['idle', 'closed', 'error']).toContain(gateway.connectionState)
  } finally { gateway.stop(); window.removeEventListener('studio:auth-expired', expired) }
})

it('已被reset清空的旧审批对象不可向新连接回应', () => {
  const channel = new JsonRpcRequestChannel()
  channel.attach({ send: () => {} })
  let request!: ServerRequest
  channel.onRequest(value => { request = value; return true })
  channel.deliverRequest('approval-a', 'approval', { session_id: 'runtime-a' })
  const workspace = new Workspace({ profile: 'account-a', rpc: () => { throw new Error('不调用RPC') }, materials: async () => ({ project: null, sources: [] }) })
  const oldRequest = request
  workspace.requests.set([oldRequest])
  workspace.reset()
  channel.detach(new Error('退出账号'))
  const writes: string[] = []
  channel.attach({ send: text => writes.push(text) })
  channel.deliverRequest('approval-a', 'approval', { session_id: 'runtime-b' })
  const currentRequest = request
  workspace.session.set({ storedId: 'stored-b', runtimeId: 'runtime-b', info: {} })
  workspace.requests.set([currentRequest])
  workspace.answer(oldRequest, { choice: 'once' })
  expect(writes).toEqual([])
  expect(workspace.requests.get()).toEqual([currentRequest])
  workspace.answer(currentRequest, { choice: 'deny' })
  expect(writes.map(text => JSON.parse(text))).toEqual([{ jsonrpc: '2.0', id: 'approval-a', result: { choice: 'deny' } }])
  expect(workspace.requests.get()).toEqual([])
})

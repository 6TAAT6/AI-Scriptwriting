import { JsonRpcGatewayClient } from '../../../shared/src/json-rpc-gateway'
import { isStableOpen, reconnectBackoffDelayMs } from '../../../shared/src/reconnect-backoff'
import type { RpcMethods, TranscriptMessage } from '../../../shared/src/gateway-contract.generated'
import { historyProject, historySources, mergeProjectArtifacts, projectFromResult, spilloverPath, type SessionMaterials } from './creative'
import { refreshCsrfToken, studioRequest } from '../accounts/api'

export class StudioGateway extends JsonRpcGatewayClient {
  profile = 'jubao-drama'
  private startEpoch = 0
  private starting: Promise<boolean> | null = null
  private automatic = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempt = 0
  private openedAt: number | null = null

  constructor() {
    super({
      closedErrorMessage: '创作连接已断开，请重新连接。',
      connectErrorMessage: '暂时无法连接创作服务。',
      notConnectedErrorMessage: '请先连接创作服务。',
      onSocketClose: event => {
        if (event.code === 4401) { this.automatic = false; clearTimeout(this.reconnectTimer); window.dispatchEvent(new Event('studio:auth-expired')) }
      }
    })
    this.onState(state => {
      if (state === 'open') { this.openedAt = Date.now(); clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
      if (state === 'closed' || state === 'error') {
        if (isStableOpen(this.openedAt)) this.reconnectAttempt = 0
        this.openedAt = null
        this.scheduleReconnect()
      }
    })
  }

  private scheduleReconnect() {
    if (!this.automatic || this.reconnectTimer !== undefined) return
    const delay = Math.max(250, reconnectBackoffDelayMs(this.reconnectAttempt++, { baseDelayMs: 1000, capMs: 15_000 }))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.automatic) return
      void this.start().then(connected => { if (connected && this.automatic) window.dispatchEvent(new Event('studio:reconnected')) }).catch(() => {})
    }, delay)
  }

  async start(): Promise<boolean> {
    this.automatic = true
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined
    if (this.connectionState === 'open') return true
    if (this.starting) return this.starting
    const starting = this.startConnection()
    this.starting = starting
    try { return await starting }
    catch (error) { this.scheduleReconnect(); throw error }
    finally { if (this.starting === starting) this.starting = null }
  }

  private async startConnection(): Promise<boolean> {
    const epoch = ++this.startEpoch
    const response = await fetch('/studio/bootstrap', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(10_000) })
    const data = await response.json()
    if (epoch !== this.startEpoch) return false
    if (response.status === 401) {
      // Cookie 会在网页服务重启后失效；停止当前重连循环，让 AuthGate 回到登录页，
      // 不要把失效会话当成网络抖动反复拨号。
      this.automatic = false
      clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined
      window.dispatchEvent(new Event('studio:auth-expired'))
    }
    if (!response.ok || typeof data.profile !== 'string') throw new Error(data.error || '创作服务连接失败。')
    if (typeof data.csrfToken === 'string') refreshCsrfToken(data.csrfToken)
    this.profile = data.profile
    const url = new URL('/api/ws', window.location.href)
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    await this.connect(url.toString())
    return epoch === this.startEpoch
  }

  stop() {
    this.automatic = false; clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined
    this.reconnectAttempt = 0; this.openedAt = null
    this.startEpoch++; this.starting = null; this.close(); this.profile = ''
  }

  rpc<K extends keyof RpcMethods>(method: K, params: RpcMethods[K]['params']): Promise<RpcMethods[K]['result']> {
    return this.request(method, params as Record<string, unknown>)
  }

  async materials(storedId: string): Promise<SessionMaterials> {
    const epoch = this.startEpoch
    const [history, saved] = await Promise.all([
      this.historyMaterials(storedId, epoch),
      studioRequest<unknown>('/session-documents', 'POST', { session_id: storedId })
    ])
    if (epoch !== this.startEpoch) throw new Error('账号连接已变化。')
    const documents = projectFromResult(saved)
    const workflow = history.project
    const preferred = workflow && workflow.stage !== 'skill' && (!documents?.agentId || workflow.agentId === documents.agentId) ? workflow : documents
    return { ...history, project: mergeProjectArtifacts(preferred, preferred === workflow ? documents : workflow) }
  }

  private async historyMaterials(storedId: string, epoch: number): Promise<SessionMaterials> {
    const url = new URL(`/api/sessions/${encodeURIComponent(storedId)}/messages`, window.location.origin)
    url.searchParams.set('profile', this.profile)
    url.searchParams.set('limit', '500')
    url.searchParams.set('order', 'latest')
    url.searchParams.set('inline_images', 'false')
    const response = await fetch(url, { credentials: 'same-origin' })
    if (epoch !== this.startEpoch) throw new Error('账号连接已变化。')
    if (response.status === 401) window.dispatchEvent(new Event('studio:auth-expired'))
    if (!response.ok) throw new Error('历史资料读取失败。')
    const data = await response.json() as { messages: TranscriptMessage[] }
    if (epoch !== this.startEpoch) throw new Error('账号连接已变化。')
    const sources = historySources(data.messages)
    const receipts = data.messages.filter(row => row.role === 'tool' && row.tool_call_id && row.content != null).map(row => ({ id: row.tool_call_id!, content: row.content }))
    let project = historyProject(data.messages)
    if (project) {
      for (const row of data.messages) if (row.role === 'tool') project = mergeProjectArtifacts(project, projectFromResult(row.content))
      return { project, sources, receipts }
    }
    let recoveredFiles = 0
    // 恢复该会话自己的最近回执，不用“最新项目”猜测当前会话的归属。
    for (const row of data.messages.toReversed()) {
      if (row.role !== 'tool') continue
      const path = spilloverPath(row.content)
      if (!path) continue
      if (recoveredFiles++ >= 3) break
      const saved = await this.file(path, storedId)
      if (epoch !== this.startEpoch) throw new Error('账号连接已变化。')
      if (Number(saved.headers.get('content-length')) > 16 * 1024 * 1024) throw new Error('项目回执过大，请在对话中查看项目进度。')
      const project = projectFromResult(await saved.text())
      if (epoch !== this.startEpoch) throw new Error('账号连接已变化。')
      if (project) return { project, sources, receipts }
    }
    return { project: historyProject(data.messages), sources, receipts }
  }

  async file(path: string, storedSessionId: string, preview = false): Promise<Response> {
    const epoch = this.startEpoch
    const url = new URL(preview ? '/api/fs/read-text' : '/api/fs/download', window.location.origin)
    url.searchParams.set('profile', this.profile)
    url.searchParams.set('path', path)
    url.searchParams.set('session_id', storedSessionId)
    const response = await fetch(url, { credentials: 'same-origin' })
    if (epoch !== this.startEpoch) throw new Error('账号连接已变化。')
    if (response.status === 401) window.dispatchEvent(new Event('studio:auth-expired'))
    if (!response.ok) throw new Error('暂时无法读取这个文件，请检查它是否仍在项目中。')
    return response
  }
}

export const gateway = new StudioGateway()

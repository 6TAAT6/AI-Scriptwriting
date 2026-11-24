import { WebSocket, WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { authorizeRpc } from './backend.mjs'
import { nativeModelRpc, modelSwitchReceipt, sessionReceipt } from './session-model.mjs'

export function createSocketBridge({ backend, store, authenticateRequest, sameOrigin, maintenance }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 30_000_000, perMessageDeflate: false })
  const connections = new Set()
  const revoke = (userId, token) => {
    for (const entry of connections) if (userId && entry.user.id === userId || token && entry.token === token) {
      entry.client.close(4401, '账号状态已变化，请重新登录。'); entry.upstream?.close()
    }
  }
  store.revoked.add(revoke)
  const maintenanceFrame = state => JSON.stringify({ jsonrpc: '2.0', method: 'studio.maintenance', params: state })
  const expireAll = () => {
    for (const entry of connections) {
      entry.client.close(4401, '系统维护中，请稍后重新登录。'); entry.upstream?.close()
    }
  }
  const unsubscribeMaintenance = maintenance?.subscribe(state => {
    const frame = maintenanceFrame(state)
    for (const entry of connections) if (entry.client.readyState === WebSocket.OPEN) entry.client.send(frame)
    if (state.phase !== 'inactive') expireAll()
  })
  const upgrade = async (req, socket, head) => {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { socket.destroy(); return }
    if (url.pathname !== '/api/ws') {
      if (url.pathname.startsWith('/api/')) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    try {
      sameOrigin(req, true)
      const auth = await authenticateRequest(req, true)
      backend.requireEmployeeChannel(auth.user)
      if (url.search) throw new Error('不能传入连接凭证')
      wss.handleUpgrade(req, socket, head, client => connect(client, auth))
    } catch (error) {
      console.error('studio websocket upgrade rejected:', error?.status || error?.message || 'unknown')
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    }
  }
  async function connect(client, auth) {
    const entry = { client, user: auth.user, token: auth.token, upstream: null,
      observationGeneration: -1, observationKnown: false, current_stored_session: null }
    connections.add(entry)
    const maintenanceState = maintenance?.snapshot()
    if (maintenanceState && maintenanceState.phase !== 'inactive') {
      client.send(maintenanceFrame(maintenanceState))
      client.close(4401, '系统维护中，请稍后重新登录。')
      connections.delete(entry)
      return
    }
    let upstream, queued = Promise.resolve(), incoming = Promise.resolve(), readyResolve, transport
    const ready = new Promise(resolve => { readyResolve = resolve })
    const pending = new Map(), questions = new Map(), deferredEvents = []
    const controls = new Map()
    const controlError = () => Object.assign(new Error('暂时无法核对创作状态，请稍后重试。'), { status: 503 })
    const closeControls = () => {
      for (const control of controls.values()) { clearTimeout(control.timer); control.reject(controlError()) }
      controls.clear()
    }
    const active = () => {
      if (!store.authenticate(auth.token)) { revoke(null, auth.token); return false }
      return client.readyState === WebSocket.OPEN
    }
    const send = frame => {
      if (active()) client.send(JSON.stringify(frame))
    }
    const sendUpstream = frame => {
      if (!active() || upstream?.readyState !== WebSocket.OPEN) return false
      upstream.send(JSON.stringify(frame)); return true
    }
    const readNative = method => new Promise((resolve, reject) => {
      if (!['session.active_list', 'delegation.status'].includes(method)) { reject(controlError()); return }
      const id = 'studio-state:' + randomUUID()
      const timer = setTimeout(() => { controls.delete(id); reject(controlError()) }, 10_000)
      timer.unref()
      controls.set(id, { resolve, reject, timer })
      if (!sendUpstream({ jsonrpc: '2.0', id, method, params: { profile: transport.profile } })) {
        controls.delete(id); clearTimeout(timer); reject(controlError())
      }
    })
    const readContinuation = async stored => {
      const url = new URL(`/api/sessions/${encodeURIComponent(stored)}/latest-descendant`, transport.endpoint)
      url.searchParams.set('profile', transport.profile)
      const response = await fetch(url, { headers: { 'X-Hermes-Session-Token': transport.token },
        signal: AbortSignal.timeout(5000), redirect: 'error' })
      if (!response.ok) throw controlError()
      return response.json()
    }
    const error = (id, code, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
    const observeSelection = frame => {
      const params = frame.params
      const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[/?#\\\x00-\x1f\x7f]/.test(value)
      if (frame.jsonrpc !== '2.0' || !['string', 'number'].includes(typeof frame.id)
        || typeof frame.id === 'string' && frame.id.length > 128
        || !params || typeof params !== 'object' || Array.isArray(params)
        || Object.keys(params).length !== 3 || Object.keys(params).some(key => !['generation', 'runtime_id', 'stored_session_id'].includes(key))
        || !Number.isSafeInteger(params.generation) || params.generation < 0
        || !(params.runtime_id === null && params.stored_session_id === null || validId(params.runtime_id) && validId(params.stored_session_id))) {
        error(frame.id, 400, '页面观测参数不正确。'); return
      }
      if (params.generation <= entry.observationGeneration) { error(frame.id, 409, '页面观测已被更新。'); return }
      if (params.runtime_id !== null && (backend.runtimeOwners.get(params.runtime_id) !== entry.user.id
        || backend.runtimeStates.get(params.runtime_id)?.storedSessionId !== params.stored_session_id)) {
        error(frame.id, 403, '只能观测本账号已恢复的对话。'); return
      }
      entry.observationGeneration = params.generation
      entry.observationKnown = true
      entry.current_stored_session = params.stored_session_id
      send({ jsonrpc: '2.0', id: frame.id, result: { accepted: true } })
    }
    const sessionId = frame => frame.params?.session_id
    const owned = frame => !sessionId(frame) || backend.runtimeOwners.get(sessionId(frame)) === entry.user.id
    const acceptRequest = frame => {
      if (!active()) return null
      const projected = backend.presentation.request(entry.user, frame)
      if (projected) questions.set(frame.id, projected)
      else sendUpstream({ jsonrpc: '2.0', id: frame.id,
        ...(frame.method === 'approval' ? { result: { choice: 'deny' } } : { error: { code: -32601, message: '当前工作区不支持此操作。' } }) })
      return projected
    }
    const emit = async frame => {
      if (!active()) return
      backend.noteEvent(frame)
      if (frame.params?.type === 'request.cancel') questions.delete(frame.params.payload?.id)
      const projected = frame.method && frame.id !== undefined ? acceptRequest(frame) : await backend.presentation.event(entry.user, frame)
      if (projected) send(projected)
    }
    const timer = setInterval(() => {
      void store.verifyActor(auth).catch(() => revoke(null, auth.token))
    }, 30_000)
    timer.unref()
    client.once('close', () => { clearInterval(timer); connections.delete(entry); closeControls(); upstream?.close(); readyResolve(false) })
    client.on('error', () => upstream?.close())
    client.on('message', (raw, binary) => {
      queued = queued.then(async () => {
        await store.verifyActor(auth)
        if (!active()) return
        let frame
        try {
          if (binary) throw new Error('格式')
          frame = JSON.parse(raw.toString())
          // 旁路观测只读本连接选择，不进入核心 RPC 或模型执行路径。
          if (frame?.method === 'studio.observation.selection') { observeSelection(frame); return }
          if (!frame.method && frame.id !== undefined && ('result' in frame || 'error' in frame)) {
            const question = questions.get(frame.id)
            if (!question) { error(frame.id, 403, '不能回答其他会话的确认请求。'); return }
            questions.delete(frame.id)
            if (await ready && active()) sendUpstream(backend.presentation.answer(entry.user, question, frame)); return
          }
          maintenance?.assertPrompt(frame)
          const outgoing = await authorizeRpc(frame, entry.user, backend)
          if (!active()) return
          if (pending.has(frame.id)) { error(frame.id, 400, '请求标识重复。'); return }
          if (pending.size >= 256) { error(frame.id, 429, '待处理请求过多，请稍后重试。'); return }
          if (!await ready) { error(frame.id, 503, '创作连接尚未就绪。'); return }
          if (!active() || upstream?.readyState !== WebSocket.OPEN) return
          maintenance?.assertPrompt(outgoing)
          await backend.prepareRequest(outgoing, readNative, readContinuation)
          if (!active()) return
          maintenance?.assertPrompt(outgoing)
          if (outgoing.method === 'prompt.submit') backend.ownRuntime(entry.user, outgoing.params.session_id)
          backend.noteRequest(outgoing)
          pending.set(frame.id, outgoing)
          const native = nativeModelRpc(outgoing)
          const upstreamFrame = native.params.profile ? { ...native, params: { ...native.params, profile: transport.profile } } : native
          if (!sendUpstream(upstreamFrame)) { pending.delete(frame.id); await backend.noteReply(outgoing, { error: true }, entry.user) }
        } catch (e) { error(frame?.id, e.status || 400, e.status ? e.message : '请求格式不正确。') }
      }).catch(() => client.close(1011, '创作连接异常。'))
    })
    try {
      transport = await backend.transport(entry.user)
      if (!active()) return
      const url = new URL('/api/ws', transport.endpoint)
      const serviceToken = transport.token
      url.protocol = 'ws:'; url.searchParams.set('token', serviceToken)
      upstream = new WebSocket(url, { maxPayload: 32_000_000, handshakeTimeout: 10_000, perMessageDeflate: false })
      entry.upstream = upstream
      upstream.once('open', () => { const allowed = active(); readyResolve(allowed); if (!allowed) upstream.close() })
      upstream.on('error', error => {
        closeControls()
        if (active()) console.error('studio websocket upstream error:', error?.message || 'unknown')
        backend.tokenValue = ''; readyResolve(false); client.close(1011, '创作服务暂时不可用。')
      })
      upstream.once('close', (code, reason) => {
        closeControls()
        if (active()) console.error('studio websocket upstream closed:', code, String(reason || ''))
        readyResolve(false); client.close(1011, '创作连接已结束。')
      })
      upstream.on('message', raw => {
        incoming = incoming.then(async () => {
          if (!active()) return
          for (const line of raw.toString().split('\n').filter(Boolean)) {
            if (!active()) return
            let frame = JSON.parse(line)
            if (frame.id !== undefined && !frame.method) {
              const control = controls.get(frame.id)
              if (control) {
                controls.delete(frame.id); clearTimeout(control.timer)
                if (frame.error || !frame.result || typeof frame.result !== 'object') control.reject(controlError())
                else control.resolve(frame.result)
                continue
              }
              const call = pending.get(frame.id)
              if (!call) continue
              pending.delete(frame.id)
              frame = sessionReceipt(call, modelSwitchReceipt(call, frame))
              if (['session.create', 'session.resume'].includes(call.method) && frame.result?.session_id) {
                await backend.rememberSession(entry.user, frame.result, call.params, backend.requestModelSlots.get(call))
              }
              await backend.noteReply(call, frame, entry.user)
              send(await backend.presentation.rpc(entry.user, call, frame, acceptRequest))
              const waiting = deferredEvents.splice(0)
              for (const event of waiting) { if (owned(event)) await emit(event); else deferredEvents.push(event) }
            } else if (owned(frame)) await emit(frame)
            else if ([...pending.values()].some(call => ['session.create', 'session.resume'].includes(call.method)) && deferredEvents.length < 256) deferredEvents.push(frame)
          }
        }).catch(() => client.close(1011, '创作服务响应异常。'))
      })
    } catch (error) {
      console.error('studio websocket upstream setup failed:', error?.message || 'unknown')
      readyResolve(false); client.close(1011, '创作服务暂时不可用。')
    }
  }
  return {
    observationVersion: 2,
    modelsChanged() {
      const frame = JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'studio.models.changed', payload: {} } })
      for (const entry of connections) if (entry.client.readyState === WebSocket.OPEN && store.authenticate(entry.token)) entry.client.send(frame)
    },
    observationSnapshot() {
      const online = new Map()
      for (const entry of connections) {
        if (entry.client.readyState !== WebSocket.OPEN || !store.authenticate(entry.token)) continue
        const row = online.get(entry.user.id) || { user_id: entry.user.id, pages: 0, known: true, sessions: new Set() }
        row.pages++; row.known &&= entry.observationKnown
        if (entry.observationKnown && entry.current_stored_session) row.sessions.add(entry.current_stored_session)
        online.set(entry.user.id, row)
      }
      return [...online.values()].map(row => ({ user_id: row.user_id, pages: row.pages, conversation_count: row.known ? row.sessions.size : null }))
    },
    upgrade,
    async close() {
      unsubscribeMaintenance?.()
      store.revoked.delete(revoke)
      for (const entry of connections) { entry.client.terminate(); entry.upstream?.terminate() }
      await new Promise(resolve => wss.close(resolve))
    }
  }
}

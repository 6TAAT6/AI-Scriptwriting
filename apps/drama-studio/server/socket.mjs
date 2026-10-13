import { WebSocket, WebSocketServer } from 'ws'
import { authorizeRpc } from './backend.mjs'
import { nativeModelRpc, modelSwitchReceipt, sessionReceipt } from './session-model.mjs'

export function createSocketBridge({ backend, store, authenticateRequest, sameOrigin }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 30_000_000, perMessageDeflate: false })
  const connections = new Set()
  const revoke = (userId, token) => {
    for (const entry of connections) if (userId && entry.user.id === userId || token && entry.token === token) {
      entry.client.close(4401, '账号状态已变化，请重新登录。'); entry.upstream?.close()
    }
  }
  store.revoked.add(revoke)
  const upgrade = (req, socket, head) => {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { socket.destroy(); return }
    if (url.pathname !== '/api/ws') {
      if (url.pathname.startsWith('/api/')) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    try {
      sameOrigin(req, true)
      const auth = authenticateRequest(req, true)
      backend.requireEmployeeChannel(auth.user)
      if (url.search) throw new Error('不能传入连接凭证')
      wss.handleUpgrade(req, socket, head, client => connect(client, auth))
    } catch (error) {
      console.error('studio websocket upgrade rejected:', error?.status || error?.message || 'unknown')
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    }
  }
  async function connect(client, auth) {
    const entry = { client, user: auth.user, token: auth.token, upstream: null }
    connections.add(entry)
    let upstream, queued = Promise.resolve(), incoming = Promise.resolve(), readyResolve, transport
    const ready = new Promise(resolve => { readyResolve = resolve })
    const pending = new Map(), questions = new Map(), deferredEvents = []
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
    const error = (id, code, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
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
      if (!store.authenticate(auth.token)) revoke(null, auth.token)
    }, 30_000)
    timer.unref()
    client.once('close', () => { clearInterval(timer); connections.delete(entry); upstream?.close(); readyResolve(false) })
    client.on('error', () => upstream?.close())
    client.on('message', (raw, binary) => {
      queued = queued.then(async () => {
        if (!active()) return
        let frame
        try {
          if (binary) throw new Error('格式')
          frame = JSON.parse(raw.toString())
          if (!frame.method && frame.id !== undefined && ('result' in frame || 'error' in frame)) {
            const question = questions.get(frame.id)
            if (!question) { error(frame.id, 403, '不能回答其他会话的确认请求。'); return }
            questions.delete(frame.id)
            if (await ready && active()) sendUpstream(backend.presentation.answer(entry.user, question, frame)); return
          }
          const outgoing = await authorizeRpc(frame, entry.user, backend)
          if (!active()) return
          if (pending.has(frame.id)) { error(frame.id, 400, '请求标识重复。'); return }
          if (pending.size >= 256) { error(frame.id, 429, '待处理请求过多，请稍后重试。'); return }
          if (!await ready) { error(frame.id, 503, '创作连接尚未就绪。'); return }
          if (!active() || upstream?.readyState !== WebSocket.OPEN) return
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
        console.error('studio websocket upstream error:', error?.message || 'unknown')
        backend.tokenValue = ''; readyResolve(false); client.close(1011, '创作服务暂时不可用。')
      })
      upstream.once('close', (code, reason) => {
        console.error('studio websocket upstream closed:', code, String(reason || ''))
        readyResolve(false); client.close(1011, '创作连接已结束。')
      })
      upstream.on('message', raw => {
        incoming = incoming.then(async () => {
          if (!active()) return
          for (const line of raw.toString().split('\n').filter(Boolean)) {
            if (!active()) return
            let frame = JSON.parse(line)
            if (frame.id !== undefined && !frame.method) {
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
    observationSnapshot() {
      const online = new Map()
      for (const entry of connections) {
        if (entry.client.readyState !== WebSocket.OPEN || !store.authenticate(entry.token)) continue
        const row = online.get(entry.user.id) || { user_id: entry.user.id, pages: 0 }
        row.pages++; online.set(entry.user.id, row)
      }
      return [...online.values()]
    },
    upgrade,
    async close() {
      store.revoked.delete(revoke)
      for (const entry of connections) { entry.client.terminate(); entry.upstream?.terminate() }
      await new Promise(resolve => wss.close(resolve))
    }
  }
}

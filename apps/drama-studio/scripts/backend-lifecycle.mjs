import { createServer } from 'node:net'
import { StudioBackend } from '../server/backend.mjs'

export async function matchesBackendHome(backend, repoRoot, backendToken) {
  try {
    const client = new StudioBackend({ backend, repoRoot, backendToken })
    if (backendToken) {
      const identity = await fetch(client.endpoint, { headers: { 'X-Hermes-Session-Token': backendToken }, signal: AbortSignal.timeout(5000), redirect: 'error' })
      if (!identity.ok || (await identity.json()).service !== 'studio-runtime') return false
    }
    const response = await fetch(new URL('/api/status', client.endpoint), {
      headers: { 'X-Hermes-Session-Token': await client.token() },
      signal: AbortSignal.timeout(5000), redirect: 'error'
    })
    if (!response.ok) return false
    const status = await response.json()
    // 消息网关可在独立网页模式下停用；归属由完整 home 路径判断，不能匹配前缀。
    return status?.hermes_home === client.home
  } catch {
    return false
  }
}

export async function shouldStartBackend(backend, repoRoot, backendToken) {
  const endpoint = new URL(backend)
  const port = Number(endpoint.port || 80)
  const probe = createServer()
  const available = await new Promise((resolve, reject) => {
    probe.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
  if (available) return true
  if (await matchesBackendHome(backend, repoRoot, backendToken)) return false
  throw new Error(`端口 ${port} 已被其他服务占用，或无法确认属于当前工作区的受保护服务；现有任务保持运行，请核对后端启动方式。`)
}

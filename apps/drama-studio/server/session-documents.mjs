import { fail } from './accounts.mjs'

/** 只接受会话身份；正文、Agent 与文件位置均由当前账号运行时决定。 */
export async function sessionDocuments(service, user, body, authorize) {
  if (!body || Object.keys(body).some(key => key !== 'session_id')
    || typeof body.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.session_id)) {
    fail(400, '稿件请求只支持有效的当前会话标识。')
  }
  authorize()
  await service.session(user, body.session_id)
  authorize()
  const transport = await service.transport(user)
  authorize()
  const url = new URL('/api/studio/session-documents', transport.endpoint)
  url.searchParams.set('profile', transport.profile)
  const response = await fetch(url, { method: 'POST', headers: {
    'X-Hermes-Session-Token': transport.token, 'Content-Type': 'application/json'
  }, body: JSON.stringify({ session_id: body.session_id }), signal: AbortSignal.timeout(120_000), redirect: 'error' })
  if (!response.ok) {
    await response.body?.cancel()
    fail(response.status === 404 ? 404 : 503, response.status === 404 ? '对话不存在。' : '暂时无法整理稿件，请稍后重试。')
  }
  const data = await response.json()
  authorize()
  if (data?.ok !== true) fail(503, '稿件整理尚未完成，请稍后重试。')
  const project = await service.presentation.project(user, data.project)
  authorize()
  return { ok: true, documents: project?.artifacts ?? [], project: project ?? null }
}

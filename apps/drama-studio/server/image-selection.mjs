import { fail } from './accounts.mjs'

export async function saveImageSelection(backend, user, params) {
  const { image_model: model = '', image_provider: provider = '' } = params
  if (model || provider) {
    const catalog = backend.catalogs.get(user.id)
    if (typeof model !== 'string' || typeof provider !== 'string' || !catalog?.providers.some(row => row.slug === provider && row.image_models?.includes(model))) fail(403, '请选择已接入的生图模型。')
  }
  const state = backend.runtimeStates.get(params.session_id)
  if (state?.running || state?.submitting || state?.selectingImage || state?.switchingModel) fail(409, '本轮正在生成或切换模型，请完成后再发送。')
  if (state) state.selectingImage = true
  try {
    const transport = await backend.transport(user)
    const url = new URL('/api/studio/image-selection', transport.endpoint)
    url.searchParams.set('profile', transport.profile)
    const response = await fetch(url, { method: 'POST', headers: { 'X-Hermes-Session-Token': transport.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: params.session_id, model, provider }), signal: AbortSignal.timeout(10_000), redirect: 'error' })
    if (!response.ok) { await response.body?.cancel(); fail(503, '生图模型选择未能保存，请重试。') }
    const saved = await response.json()
    if (saved.ok !== true) fail(503, '生图模型选择尚未确认。')
  } finally { if (state) state.selectingImage = false }
}

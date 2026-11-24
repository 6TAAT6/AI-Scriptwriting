import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fail } from './accounts.mjs'

const BRAND_PROVIDER = 'jubao-models'
const defaults = [
  ['brand-text-1', 'text', 'gemini-pro-agent', '巨豹满血版 V1.1'],
  ['brand-text-2', 'text', 'gemini-3.8-flash-high', '巨豹满血版 V1.0'],
  ['brand-text-3', 'text', 'gpt-6.1-sol', '巨豹测试版 V2.1'],
  ['brand-text-4', 'text', 'gpt-6-astra', '巨豹测试版 V2.0'],
  ['brand-text-5', 'text', 'grok-4.7', '巨豹试用版 V3.0'],
  ['brand-image-1', 'image', 'gpt-image-2.5-sunburst', '巨豹生图 V1.0'],
  ['brand-image-2', 'image', 'gemini-3.1-flash-image', '巨豹生图 V2.0']
].map(([id, kind, model, display_name]) => ({ id, kind, model, display_name, provider: '', visible: true }))
const rows = value => Array.isArray(value) ? value : []
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,255}$/
const providerPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const slotPattern = /^brand-(text|image)-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const field = kind => kind === 'image' ? 'image_models' : 'models'
const sha = text => createHash('sha256').update(text).digest('hex')
const hasModel = (target, kind, model) => rows(target?.[field(kind)]).includes(model)
const providerName = value => String(value || '').trim().replace(/^custom:/, '')

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'models') || !Array.isArray(input.models) || !input.models.length || input.models.length > 200) fail(400, '请保存完整的品牌模型列表，最多保留 200 个入口。')
  const seen = new Set()
  return input.models.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['id', 'kind', 'model', 'provider', 'display_name', 'visible'].includes(key))
      || typeof row.id !== 'string' || !slotPattern.test(row.id) || !['text', 'image'].includes(row.kind) || !row.id.startsWith(`brand-${row.kind}-`) || typeof row.model !== 'string' || !modelPattern.test(row.model)
      || typeof row.provider !== 'string' || row.provider && !providerPattern.test(row.provider)
      || typeof row.display_name !== 'string' || !row.display_name.trim() || row.display_name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(row.display_name)
      || typeof row.visible !== 'boolean' || seen.has(row.id)) fail(400, '品牌标识不可更改，请填写 1 至 80 个字符的显示名称并选择已接入模型。')
    seen.add(row.id)
    return { id: row.id, kind: row.kind, model: row.model, provider: row.provider, display_name: row.display_name.trim(), visible: row.visible }
  })
}

/** 品牌入口保持稳定；映射只决定下一次新建或主动切换使用的真实模型。 */
export class ModelDisplayNames {
  constructor(filename, secret, models, readEndpoints) {
    this.filename = filename
    this.secret = secret
    this.models = models
    this.readEndpoints = readEndpoints
    this.queue = Promise.resolve()
    this.targets = []
    this.disabledTargets = []
    this.sessionFilename = path.join(path.dirname(filename), 'session-brand-bindings.json')
    this.sessionBindings = new Map()
    this.historicalModels = new Set()
  }
  static async open(dataDir, readEndpoints) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const filename = path.join(dataDir, 'model-display-names.json')
    let data
    try { data = JSON.parse(await readFile(filename, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    let result
    if (data) {
      if (data.version !== 1 || typeof data.secret !== 'string' || !/^[a-f0-9]{64}$/.test(data.secret)) throw new Error('品牌模型配置无效。')
      result = new ModelDisplayNames(filename, data.secret, validate({ models: data.models }), readEndpoints)
    } else {
      result = new ModelDisplayNames(filename, randomBytes(32).toString('hex'), defaults.map(row => ({ ...row })), readEndpoints)
      await result.persist(result.models)
    }
    let bindings = []
    try { bindings = JSON.parse(await readFile(result.sessionFilename, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!Array.isArray(bindings) || bindings.some(row => !row || ['user', 'profile', 'stored', 'slot', 'model', 'provider'].some(key => typeof row[key] !== 'string') || !result.models.some(slot => slot.id === row.slot && slot.kind === 'text'))) throw new Error('会话品牌记录无效。')
    result.sessionBindings = new Map(bindings.map(row => [JSON.stringify([row.user, row.profile, row.stored]), row]))
    result.historicalModels = new Set(bindings.map(row => row.model))
    return result
  }
  async refreshTargets() {
    const endpoints = await this.readEndpoints()
    const all = rows(endpoints).map(row => ({ provider: String(row.id || ''), provider_name: String(row.name || '模型接入'),
      models: rows(row.models).filter(value => typeof value === 'string' && modelPattern.test(value)),
      image_models: rows(row.image_models).filter(value => typeof value === 'string' && modelPattern.test(value)), is_current: row.is_current === true, enabled: row.enabled !== false }))
      .filter(row => providerPattern.test(row.provider))
    // 员工配置不含已停用接入；绑定、路由和可选列表只认已启用的接入，停用接入仅用于提示和脱敏。
    this.targets = all.filter(row => row.enabled)
    this.disabledTargets = all.filter(row => !row.enabled)
    return this.targets
  }
  resolved(slot, targets = this.targets) {
    if (slot.provider) return slot
    const candidates = targets.filter(target => hasModel(target, slot.kind, slot.model))
    return candidates.length === 1 ? { ...slot, provider: candidates[0].provider } : slot
  }
  /** 停用接入前评估影响：员工不能因此失去全部文字入口；绑在它上面的可见入口会暂时隐藏，重新启用后恢复。 */
  async disableImpact(provider) {
    await this.refreshTargets()
    const remaining = this.targets.filter(target => target.provider !== provider)
    const reachable = (slot, targets) => hasModel(targets.find(target => target.provider === this.resolved(slot, targets).provider), slot.kind, slot.model)
    const visible = this.models.filter(slot => slot.visible)
    if (!visible.some(slot => slot.kind === 'text' && reachable(slot, remaining))) {
      return { blocked: '停用后员工将没有可用的文字模型入口。请先在下方品牌入口中把至少一个文字入口绑定到其他已启用的接入。' }
    }
    return { hidden: visible.filter(slot => reachable(slot, this.targets) && !reachable(slot, remaining)).map(slot => slot.display_name) }
  }
  list() {
    return { models: this.models.map(row => ({ ...this.resolved(row) })),
      targets: this.targets.map(({ is_current, enabled, ...target }) => target),
      disabled_targets: this.disabledTargets.map(({ provider, provider_name }) => ({ provider, provider_name })) }
  }
  privateNames() {
    return [...new Set([...defaults.map(row => row.model), ...this.models.map(row => row.model),
      ...[...this.targets, ...this.disabledTargets].flatMap(row => [...row.models, ...row.image_models]),
      ...this.historicalModels])].filter(value => value.length >= 5 && /[\d._:/-]/.test(value))
  }
  async persist(models, authorize = () => {}) {
    const pending = this.queue.catch(() => {}).then(async () => {
      authorize()
      const temporary = this.filename + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, secret: this.secret, models }) + '\n', { flag: 'wx', mode: 0o600 })
        authorize()
        await rename(temporary, this.filename)
        this.models = models
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    })
    this.queue = pending
    await pending
  }
  async save(input, authorize) {
    const previous = this.models
    const models = validate(input)
    if (this.models.some(existing => !models.some(row => row.id === existing.id))) fail(400, '请保留已有入口记录，使用删除按钮下架入口。')
    await this.refreshTargets()
    for (const row of models) {
      const existing = this.models.find(value => value.id === row.id)
      const target = this.targets.find(value => value.provider === row.provider)
      // 尚未接入的默认入口可保持原样；任何改绑都必须指向当前接入目录中的具体模型。
      const unchangedUnbound = existing && !row.provider && !existing.provider && row.model === existing.model
      const unchangedHidden = existing && !row.visible && row.provider === existing.provider && row.model === existing.model
      if (!unchangedUnbound && !unchangedHidden && !hasModel(target, row.kind, row.model)) {
        const paused = this.disabledTargets.find(value => value.provider === row.provider)
        fail(400, paused ? `「${row.display_name}」绑定的模型接入「${paused.provider_name}」已停用，员工看不到这个入口。请改选已启用的接入，或删除该入口后再保存。` : '请选择当前已接入的模型；同名模型有多个接入时需要指定接入。')
      }
    }
    if (!models.some(row => row.visible && row.kind === 'text' && hasModel(this.targets.find(target => target.provider === this.resolved(row).provider), 'text', row.model))) fail(400, '至少保留一个已接入的文字模型入口。')
    await this.persist(models, () => {
      authorize?.()
      if (this.models !== previous) fail(409, '品牌入口已被其他页面修改，请刷新目录后重试。')
    })
  }
  route(user, catalog, slot) {
    const resolved = this.resolved(slot)
    if (!resolved.provider) return null
    const target = this.targets.find(row => row.provider === resolved.provider)
    if (!hasModel(target, slot.kind, slot.model)) return null
    const workerProvider = target.is_current ? 'studio-inference' : 'studio-model-' + sha('provider-' + sha(target.provider).slice(0, 24)).slice(0, 16)
    const names = user.role === 'super_admin' ? [target.provider, 'custom:' + target.provider] : [workerProvider, 'custom:' + workerProvider, target.provider, 'custom:' + target.provider]
    const candidates = rows(catalog?.providers).filter(row => names.includes(row.slug) || rows(row.aliases).some(alias => names.includes(alias)))
    const row = candidates.find(row => hasModel(row, slot.kind, slot.model))
    return row ? { model: slot.model, provider: row.slug } : null
  }
  defaultModel(user, catalog) {
    const text = this.models.filter(slot => slot.visible && slot.kind === 'text' && this.route(user, catalog, slot))
    return (text.find(slot => slot.id === 'brand-text-1') || text[0])?.id || ''
  }
  async catalog(user, native) {
    await this.refreshTargets()
    const available = this.models.filter(slot => slot.visible).map(slot => ({ slot, route: this.route(user, native, slot) })).filter(row => row.route)
    const text = available.filter(row => row.slot.kind === 'text'), images = available.filter(row => row.slot.kind === 'image')
    return { model: this.defaultModel(user, native), provider: BRAND_PROVIDER, providers: [{
      slug: BRAND_PROVIDER, aliases: [], name: '巨豹创作模型', authenticated: true,
      models: text.map(row => row.slot.id), image_models: images.map(row => row.slot.id), image_model: images[0]?.slot.id || '',
      display_names: Object.fromEntries(text.map(({ slot }) => [slot.id, slot.display_name])),
      image_display_names: Object.fromEntries(images.map(({ slot }) => [slot.id, slot.display_name])),
      capabilities: Object.fromEntries(text.map(({ slot, route }) => [slot.id, native.providers.find(row => row.slug === route.provider)?.capabilities?.[route.model] || {}]))
    }] }
  }
  selection(user, catalog, kind, selection) {
    if (!selection.model && !selection.provider) return selection
    if (selection.provider && selection.provider !== BRAND_PROVIDER) fail(403, '请选择当前工作区提供的品牌模型。')
    const slot = this.models.find(row => row.id === selection.model && row.kind === kind && row.visible)
    const route = slot && this.route(user, catalog, slot)
    if (!route) fail(403, '所选品牌模型暂不可用，请刷新模型目录后重试。')
    return { ...selection, ...route }
  }
  binding(user, value, catalog) {
    const model = value?.model
    if (typeof model !== 'string' || !model) return undefined
    const requested = providerName(value?.provider)
    const candidates = this.models.filter(slot => slot.kind === 'text' && slot.visible && slot.model === model)
    return candidates.find(slot => {
      const route = this.route(user, catalog, slot)
      const row = rows(catalog?.providers).find(row => row.slug === route?.provider)
      if (route?.model !== model) return false
      if (!requested || requested === 'custom') return true
      return providerName(route.provider) === requested || rows(row?.aliases).some(alias => providerName(alias) === requested)
    })?.id || (candidates.length === 1 && !rows(catalog?.providers).length ? candidates[0].id : undefined)
  }
  sessionSlot(user, stored, info) {
    const row = this.sessionBindings.get(JSON.stringify([user.id, user.profile, stored]))
    const slot = row && this.models.find(item => item.id === row.slot && item.kind === 'text')
    return slot && slot.model === row.model && (!info?.model || row.model === info.model) ? slot.id : undefined
  }
  legacySlotForModel(model) {
    if (typeof model !== 'string' || !model) return undefined
    return defaults.find(slot => slot.kind === 'text' && slot.model === model)?.id
  }
  async rememberSession(user, stored, slot, info) {
    if (!slot || !this.models.some(row => row.id === slot) || !info?.model) return
    const key = JSON.stringify([user.id, user.profile, stored])
    const value = { user: user.id, profile: user.profile, stored, slot, model: info.model, provider: String(info.provider || '').replace(/^custom:/, '') }
    const pending = this.queue.catch(() => {}).then(async () => {
      if (JSON.stringify(this.sessionBindings.get(key)) === JSON.stringify(value)) return
      const bindings = new Map(this.sessionBindings); bindings.set(key, value)
      const temporary = this.sessionFilename + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temporary, JSON.stringify([...bindings.values()]) + '\n', { flag: 'wx', mode: 0o600 })
        await rename(temporary, this.sessionFilename)
        this.sessionBindings = bindings
        this.historicalModels.add(value.model)
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    })
    this.queue = pending
    await pending
  }
  info(user, value, catalog, boundSlot) {
    const result = { ...value }
    if (typeof result.model === 'string' && result.model) {
      const slot = this.models.find(row => row.id === boundSlot)
        || this.models.find(row => row.id === this.binding(user, value, catalog))
        || this.models.find(row => row.kind === 'text' && row.model === result.model)
        || this.models.find(row => row.id === this.legacySlotForModel(result.model))
      result.model_display_name = slot?.display_name || '巨豹创作模型'
      result.model = slot?.id || 'history-model-' + createHmac('sha256', this.secret).update(JSON.stringify([user.id, result.model])).digest('hex').slice(0, 24)
    }
    if (typeof result.provider === 'string') result.provider = BRAND_PROVIDER
    return result
  }
}

export function createModelDisplayNamesService({ modelNames, store, onChanged }) {
  const authorize = auth => {
    const current = store.authenticate(auth.token)
    if (!current) fail(401, '登录已失效，请重新登录。')
    if (current.user.role !== 'super_admin') fail(403, '只有超级管理员可以修改品牌模型绑定。')
  }
  return { async handle(req, res, url, auth, input) {
    if (url.pathname !== '/studio/admin/model-names') return false
    authorize(auth)
    if (!['GET', 'POST'].includes(req.method)) fail(405, '此接口不支持该操作。')
    if (req.method === 'POST') { await modelNames.save(input, () => authorize(auth)); onChanged?.() }
    else await modelNames.refreshTargets()
    authorize(auth)
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(modelNames.list()))
    return true
  } }
}

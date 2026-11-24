import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { fail } from './accounts.mjs'
import { isSupportedFile as supported } from '../shared/attachments.mjs'

export const isEmployee = user => user.role !== 'super_admin'
export const FILE_REFERENCE = /@file:(?:`([^`]+)`|"([^"]+)"|'([^']+)'|([^\s]+))/g
const quote = value => '`' + value + '`'

export function validateEmployeePrompt(text) {
  // 与服务端输入清理一致地识别粘贴包装；只检查行首命令，不阻断正文里的斜线。
  const normalized = text.replace(/(?:\u001b\[|\^\[\[)(?:200|201)~/g, '')
    .replace(/(^|[\s>:\]\)])(?:\[200~|00~)/g, '$1')
    .replace(/(?:\[201~|01~)(?=$|[\s<\[(\):;.,!?])/g, '')
  if (/(?:^|[\r\n])[\s\x1c-\x1f]*\/+[a-z][a-z0-9_-]*(?=[\s\x1c-\x1f]|$)/i.test(normalized)) {
    fail(403, '创作消息不支持系统控制命令，请直接描述创作需求。')
  }
}

/** 浏览器只持有账号绑定的资料句柄，磁盘路径始终留在边缘服务。 */
export class FileHandles {
  constructor(backend) { this.backend = backend; this.handles = new Map(); this.paths = new Map() }
  revokeViewer(viewerId, sourceUserId) {
    for (const [handle, entry] of this.handles) {
      if (entry.owner === viewerId && (!sourceUserId || entry.sourceUser?.id === sourceUserId)) this.handles.delete(handle)
    }
    for (const [key, handle] of this.paths) {
      if (!this.handles.has(handle)) this.paths.delete(key)
    }
  }
  async register(user, rawPath, kind = 'source') {
    return this.registerAs(user, user, rawPath, kind)
  }
  async registerAs(viewer, sourceUser, rawPath, kind = 'source') {
    if (typeof rawPath !== 'string' || !supported(rawPath)) return null
    const candidate = await this.backend.file(sourceUser, rawPath)
    const home = await realpath(this.backend.homeFor(sourceUser))
    const relative = path.relative(home, candidate).split(path.sep).join('/')
    const image = kind === 'image' && /^cache\/generated\/images\/[^/]+\.(png|jpe?g|webp)$/i.test(relative)
    const allowed = image || (kind === 'source' ? /^(?:attachments\/|workspace\/\.hermes\/attachments\/)/.test(relative) : /^workspace\//.test(relative))
    if (!allowed || !image && /(?:^|\/)(?:\.env(?:\.|$)|config\.ya?ml|state\.db|cache|spillover)(?:\/|$)/i.test(relative)) return null
    const key = viewer.id + ':' + sourceUser.id + ':' + candidate
    if (this.paths.has(key)) return this.paths.get(key)
    const filename = path.basename(candidate).replace(/[\x00-\x1f\x7f`"'<>]/g, '_')
    const handle = `/assets-data/${randomBytes(24).toString('base64url')}/${filename}`
    this.paths.set(key, handle); this.handles.set(handle, { owner: viewer.id, profile: viewer.profile, path: candidate, source: rawPath, sourceUser: { id: sourceUser.id, role: sourceUser.role, profile: sourceUser.profile } })
    return handle
  }
  async resolve(user, handle) {
    const entry = await this.resolveEntry(user, handle)
    if (entry.sourceUser.id !== user.id) fail(403, '员工资料只能只读查看，不能作为当前账号的创作附件。')
    return entry.path
  }
  async resolveEntry(user, handle) {
    const entry = typeof handle === 'string' && this.handles.get(handle)
    if (!entry || entry.owner !== user.id || entry.profile !== user.profile) fail(403, '无法访问这个文件。')
    const sourceUser = entry.sourceUser?.id === user.id ? user : entry.sourceUser
    const current = await this.backend.file(sourceUser, entry.source)
    if (current !== entry.path) fail(403, '资料位置已经变化，请重新上传。')
    return { path: current, sourceUser }
  }
  async incoming(user, text) {
    let result = '', position = 0
    for (const match of text.matchAll(FILE_REFERENCE)) {
      const handle = match[1] || match[2] || match[3] || match[4]
      const target = await this.resolve(user, handle)
      result += text.slice(position, match.index) + '@file:' + quote(target)
      position = match.index + match[0].length
    }
    result += text.slice(position)
    // 非文件上下文引用可触发宿主命令、目录读取或外网请求；创作端仅接受上传资料。
    if (/@(?:folder|git|url|diff|staged)(?::|\b)/i.test(result)) fail(403, '请先把资料上传到当前工作区。')
    return result
  }
  async outgoing(user, text) {
    return this.outgoingAs(user, user, text)
  }
  async outgoingAs(viewer, sourceUser, text) {
    let result = '', position = 0
    for (const match of text.matchAll(FILE_REFERENCE)) {
      const raw = match[1] || match[2] || match[3] || match[4]
      let handle = null
      try { handle = await this.registerAs(viewer, sourceUser, raw) } catch (error) { if (!error.status) throw error }
      result += text.slice(position, match.index) + (handle ? '@file:' + quote(handle) : '附件：' + path.basename(raw))
      position = match.index + match[0].length
    }
    return result + text.slice(position)
  }
  async localLinks(user, text) {
    return this.localLinksAs(user, user, text)
  }
  async localLinksAs(viewer, sourceUser, text) {
    if (typeof text !== 'string') return text
    const links = /(!?)\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|((?:[^()\r\n]|\([^()\r\n]*\))+))\s*\)/g
    let result = '', position = 0
    for (const match of text.matchAll(links)) {
      const imageLink = match[1] === '!'
      const raw = (match[3] || match[4]).trim()
      const relative = raw.startsWith('./') || supported(raw) && !/[\/\\:]/.test(raw)
      const local = relative || raw.startsWith('../') || /^[a-z][a-z\d+.-]*:/i.test(raw) && !/^https?:/i.test(raw)
        || raw.startsWith('/') && !raw.startsWith('//') || raw.startsWith('工作区/')
      if (!local || raw.startsWith('/assets-data/')) continue
      let handle
      try {
        let target = decodeURIComponent(raw.startsWith('sandbox:') ? raw.slice(8) : raw)
        if (target.includes('\\') || target.split('/').includes('..') || /^[a-z][a-z\d+.-]*:/i.test(target)
          || relative && (path.isAbsolute(target) || target.includes(':'))) fail(403, '无法访问这个文件。')
        if (relative) target = path.resolve(this.backend.homeFor(sourceUser), 'workspace', target)
        handle = await this.registerAs(viewer, sourceUser, target, /\.(png|jpe?g|webp)$/i.test(target) ? 'image' : 'export')
      } catch (error) { if (!(error instanceof URIError) && !error.status) throw error }
      // 只认经过账号目录与真实文件校验的目标，不用显示别名或文件名猜测路径。
      const destination = handle && handle.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())).join('/')
      result += text.slice(position, match.index) + (destination ? `${imageLink ? '!' : ''}[${match[2]}](${destination})` : match[2])
      position = match.index + match[0].length
    }
    return result + text.slice(position)
  }
}

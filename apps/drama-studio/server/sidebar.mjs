import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, rm, realpath, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fail } from './accounts.mjs'
import { isEmployee } from './file-handles.mjs'

const runFile = promisify(execFile)
const defaultProject = () => ({ id: 'default', title: '我的剧本', pinned: false, hidden: false })
const contains = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep)
function fields(body, names) {
  if (!body || Object.keys(body).some(key => !names.includes(key))) fail(400, '请求包含不支持的字段。')
}
function patchValue(body, names) {
  fields(body, names)
  if (!Object.keys(body).length) fail(400, '请选择需要修改的内容。')
  const patch = { ...body }
  if ('title' in patch) {
    if (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.trim().length > 80 || /[\x00-\x1f\x7f]/.test(patch.title)) fail(400, '名称应为 1 至 80 个有效字符。')
    patch.title = patch.title.trim()
  }
  for (const key of ['pinned', 'archived', 'hidden']) if (key in patch && typeof patch[key] !== 'boolean') fail(400, '操作状态格式不正确。')
  if ('projectId' in patch && patch.projectId !== null && (typeof patch.projectId !== 'string' || !patch.projectId || patch.projectId.length > 80)) fail(400, '项目标识格式不正确。')
  return patch
}
function requireProject(row, id) {
  const project = row.projects.find(value => value.id === id)
  if (!project) fail(404, '项目不存在。')
  return project
}

/** 侧栏整理保存在账号名下；不改变底层会话的固定身份，也不删除原稿。 */
export async function createSidebarService({ dataDir, store, service }) {
  const file = path.join(dataDir, 'sidebar.json')
  let accounts = []
  try {
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (![1, 2].includes(data.version) || !Array.isArray(data.accounts)) throw new Error('侧栏存储格式不受支持。')
    // 旧聊天没有项目标记时仍属于默认项目，保留原有标题、置顶和归档状态。
    accounts = data.version === 1 ? data.accounts.map(({ project, ...row }) => ({ ...row, projects: [{ ...defaultProject(), ...project }] })) : data.accounts
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const account = user => accounts.find(row => row.userId === user.id && row.profile === user.profile)
  async function workspacePath(user) {
    if (process.platform !== 'darwin') return null
    const home = path.resolve(service.home, 'profiles', user.profile)
    try {
      const [realHome, folder] = await Promise.all([realpath(home), realpath(path.join(home, 'workspace'))])
      const realProfiles = await realpath(path.join(service.home, 'profiles'))
      if (!contains(realProfiles, realHome) || realHome !== path.join(realProfiles, user.profile) || !contains(realHome, folder) || !(await stat(folder)).isDirectory()) return null
      return folder
    } catch (error) { if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) return null; throw error }
  }
  async function state(user) {
    const data = account(user)
    const projects = (data?.projects || [defaultProject()]).map(({ id, title, pinned, hidden }) => ({ id, title, pinned, hidden }))
    const { id, ...project } = projects.find(value => value.id === 'default') || defaultProject()
    return { project, projects, sessions: data?.sessions || [], canReveal: !isEmployee(user) && Boolean(await workspacePath(user)) }
  }
  async function mutate(auth, apply) {
    await store.serialize(async () => {
      const user = store.requireActor(auth)
      const rows = structuredClone(accounts)
      let row = rows.find(value => value.userId === user.id && value.profile === user.profile)
      if (!row) { row = { userId: user.id, profile: user.profile, projects: [defaultProject()], sessions: [] }; rows.push(row) }
      await apply(row, user)
      store.requireActor(auth)
      const temp = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify({ version: 2, accounts: rows }), { mode: 0o600, flag: 'wx' })
        store.requireActor(auth)
        await rename(temp, file)
      } catch (error) { await rm(temp, { force: true }); throw error }
      accounts = rows
    })
  }
  const respond = (res, data, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)) }
  async function respondState(res, auth, extra = {}, status = 200) {
    const data = await state(auth.user)
    store.requireActor(auth)
    respond(res, { ...data, ...extra }, status)
  }
  async function handle(req, res, url, auth, body) {
    if (!url.pathname.startsWith('/studio/sidebar')) return false
    const user = store.requireActor(auth)
    if (url.search) fail(400, '侧栏操作不支持附加参数。')
    if (url.pathname === '/studio/sidebar' && req.method === 'GET') {
      await respondState(res, auth); return true
    }
    if (url.pathname === '/studio/sidebar/project' && req.method === 'PATCH') {
      const patch = patchValue(body, ['title', 'pinned', 'hidden'])
      await mutate(auth, row => { Object.assign(requireProject(row, 'default'), patch) })
      await respondState(res, auth); return true
    }
    if (url.pathname === '/studio/sidebar/projects' && req.method === 'POST') {
      const { title, requestId } = patchValue(body, ['title', 'requestId'])
      if (!title || typeof requestId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestId)) fail(400, '项目名称和有效创建标识不能为空。')
      const creationRequestId = requestId.toLowerCase()
      let id
      await mutate(auth, row => {
        const existing = row.projects.find(project => project.creationRequestId === creationRequestId)
        if (existing) {
          if (existing.creationTitle !== title) fail(409, '这次创建请求已使用其他名称，请重新发起创建。')
          id = existing.id; return
        }
        id = randomUUID()
        // 保持持久化数组也按创建顺序排列，前端刷新后新项目仍位于未置顶项目组顶部。
        row.projects.unshift({ id, title, pinned: false, hidden: false, creationRequestId, creationTitle: title })
      })
      await respondState(res, auth, { createdProjectId: id }, 201); return true
    }
    const projectMatch = url.pathname.match(/^\/studio\/sidebar\/projects\/([^/]+)$/)
    if (projectMatch && req.method === 'DELETE') {
      fields(body, [])
      let id
      try { id = decodeURIComponent(projectMatch[1]) } catch { fail(400, '项目标识格式不正确。') }
      let deletedSessionIds = []
      await mutate(auth, async (row, owner) => {
        const project = requireProject(row, id)
        if (!project.hidden) fail(409, '请先将项目移除到归档，再彻底删除。')
        deletedSessionIds = await service.projectSessionIds(owner, row.sessions, id)
        await service.assertSessionsIdle(owner, deletedSessionIds)
        for (const sessionId of deletedSessionIds) {
          store.requireActor(auth)
          try { await service.deleteSession(owner, sessionId, () => store.requireActor(auth)) }
          catch (error) { if (error.status !== 404) throw error }
        }
        row.sessions = row.sessions.filter(session => !deletedSessionIds.includes(session.id))
        row.projects = row.projects.filter(project => project.id !== id)
      })
      await respondState(res, auth, { deletedSessionIds }); return true
    }
    if (projectMatch && req.method === 'PATCH') {
      let id
      try { id = decodeURIComponent(projectMatch[1]) } catch { fail(400, '项目标识格式不正确。') }
      const patch = patchValue(body, ['title', 'pinned', 'hidden'])
      await mutate(auth, row => { Object.assign(requireProject(row, id), patch) })
      await respondState(res, auth); return true
    }
    const match = url.pathname.match(/^\/studio\/sidebar\/sessions\/([^/]+)$/)
    if (match && req.method === 'DELETE') {
      fields(body, [])
      let id
      try { id = decodeURIComponent(match[1]) } catch { fail(400, '对话标识格式不正确。') }
      await mutate(auth, async (row, owner) => {
        await service.deleteSession(owner, id, () => store.requireActor(auth))
        row.sessions = row.sessions.filter(session => session.id !== id)
      })
      await respondState(res, auth); return true
    }
    if (match && req.method === 'PATCH') {
      let id
      try { id = decodeURIComponent(match[1]) } catch { fail(400, '对话标识格式不正确。') }
      const patch = patchValue(body, ['title', 'pinned', 'archived', 'projectId'])
      await mutate(auth, async (row, owner) => {
        // Hermes 在首次提交时才写会话行；可信创建回执允许先保存归属，再提交消息。
        if (!service.ownsFreshSession(owner, id)) await service.session(owner, id)
        if ('projectId' in patch && patch.projectId !== null) requireProject(row, patch.projectId)
        let session = row.sessions.find(value => value.id === id)
        if (!session) { session = { id }; row.sessions.push(session) }
        Object.assign(session, patch)
      })
      await respondState(res, auth); return true
    }
    if (url.pathname === '/studio/sidebar/project/reveal' && req.method === 'POST') {
      if (isEmployee(user)) fail(403, '员工账号不能打开服务器文件管理器。')
      fields(body, [])
      const folder = await workspacePath(user)
      if (!folder) fail(409, '当前设备无法在 Finder 中打开这个工作区。')
      store.requireActor(auth)
      try { await runFile('/usr/bin/open', ['-a', 'Finder', folder], { timeout: 5000 }) }
      catch { fail(503, '未能打开 Finder，请稍后重试。') }
      respond(res, { ok: true }); return true
    }
    fail(404, '此侧栏操作不存在。')
  }
  return { handle }
}

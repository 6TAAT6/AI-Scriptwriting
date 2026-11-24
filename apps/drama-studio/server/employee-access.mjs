import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { fail } from './accounts.mjs'

const ADMIN_ROLES = new Set(['admin', 'super_admin'])
const EMPLOYEE_ROLE = 'employee'

function actorFor(store, auth) {
  const actor = store.requireActor(auth)
  if (!ADMIN_ROLES.has(actor.role)) fail(403, '只有管理员可以查看员工对话。')
  return actor
}

function copyUser(user) {
  return user ? { id: user.id, username: user.username, display_name: user.display_name, role: user.role, profile: user.profile,
    ...(user.organization_policy ? { organization: user.organization, organization_policy: true } : {}) } : null
}

export class EmployeeAccess {
  constructor(file, store, service) {
    this.file = file
    this.store = store
    this.service = service
    this.assignments = []
  }

  static async open(dataDir, store, service) {
    const access = new EmployeeAccess(path.join(dataDir, 'employee-conversation-access.json'), store, service)
    try {
      const saved = JSON.parse(await readFile(access.file, 'utf8'))
      if (saved.version !== 1 || !Array.isArray(saved.assignments)) throw new Error('员工对话授权存储格式不受支持。')
      access.assignments = saved.assignments.filter(row => typeof row?.id === 'string' && typeof row?.employeeId === 'string')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return access
  }

  async mutate(auth, apply) {
    await this.store.verifyActor(auth)
    actorFor(this.store, auth)
    return this.store.serialize(async () => {
      await this.store.verifyActor(auth)
      actorFor(this.store, auth)
      const rows = structuredClone(this.assignments)
      const result = await apply(rows, this.store.requireActor(auth))
      await this.store.verifyActor(auth)
      const temp = `${this.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify({ version: 1, assignments: rows }), { mode: 0o600, flag: 'wx' })
        await this.store.verifyActor(auth)
        await rename(temp, this.file)
      } catch (error) {
        await rm(temp, { force: true })
        throw error
      }
      this.assignments = rows
      return result
    })
  }

  employee(id) {
    const employee = this.store.user(id)
    if (!employee || employee.role !== EMPLOYEE_ROLE || !employee.enabled) fail(404, '员工账号不存在或已停用。')
    return employee
  }

  canView(auth, employeeId) {
    actorFor(this.store, auth)
    this.employee(employeeId)
    return this.assignments.some(row => row.employeeId === employeeId && row.createdBy === auth.user.id)
  }

  list(auth) {
    const actor = actorFor(this.store, auth)
    const users = new Map(this.store.listUsers().map(user => [user.id, user]))
    return this.assignments
      .filter(row => row.createdBy === actor.id)
      .map(row => ({ ...row, employee: copyUser(users.get(row.employeeId)) }))
      // 停用账号的历史授权仍保留在存储中，重新启用后可恢复；停用期间不能作为查看目标。
      .filter(row => row.employee && users.get(row.employeeId)?.enabled)
  }

  async add(auth, employeeId) {
    const employee = this.employee(employeeId)
    const actor = actorFor(this.store, auth)
    const existing = this.assignments.find(row => row.createdBy === actor.id && row.employeeId === employee.id)
    if (existing) return { ...existing, employee: copyUser(employee) }
    return this.mutate(auth, rows => {
      this.employee(employeeId)
      const assignment = { id: randomUUID(), employeeId: employee.id, createdBy: actor.id, createdAt: new Date().toISOString() }
      rows.push(assignment)
      return { ...assignment, employee: copyUser(employee) }
    })
  }

  async remove(auth, assignmentId) {
    const actor = actorFor(this.store, auth)
    const existing = this.assignments.find(row => row.id === assignmentId && row.createdBy === actor.id)
    if (!existing) fail(404, '员工查看授权不存在。')
    await this.mutate(auth, rows => {
      const index = rows.findIndex(row => row.id === assignmentId && row.createdBy === actor.id)
      if (index >= 0) rows.splice(index, 1)
      return { ok: true, deleted: assignmentId }
    })
    this.service?.files?.revokeViewer(actor.id, existing.employeeId)
    return { ok: true, deleted: assignmentId }
  }

  async removeUser(userId) {
    const affected = this.assignments.filter(row => row.employeeId === userId || row.createdBy === userId)
    if (!affected.length) return
    await this.store.serialize(async () => {
      const rows = this.assignments.filter(row => row.employeeId !== userId && row.createdBy !== userId)
      const temp = `${this.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify({ version: 1, assignments: rows }), { mode: 0o600, flag: 'wx' })
        await rename(temp, this.file)
      } catch (error) { await rm(temp, { force: true }); throw error }
      this.assignments = rows
      this.service?.files?.revokeViewer(userId)
    })
  }

  async handle(req, res, url, auth, body, service) {
    if (!url.pathname.startsWith('/studio/employee-conversations')) return false
    const actor = actorFor(this.store, auth)
    if (url.pathname === '/studio/employee-conversations' && req.method === 'GET') {
      const assignments = this.list(auth)
      const groups = await Promise.all(assignments.map(async assignment => {
        try { return { ...assignment, sessions: await this.sessions(actor, assignment.employee) } }
        catch { return { ...assignment, sessions: [], sync_error: '该员工工作区暂时无法同步，系统会自动重试。' } }
      }))
      await this.store.verifyActor(auth)
      const allowed = new Set(this.list(auth).map(row => row.employeeId))
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ groups: groups.filter(group => allowed.has(group.employeeId)) })); return true
    }
    if (url.pathname === '/studio/employee-conversations' && req.method === 'POST') {
      if (!body || Object.keys(body).some(key => key !== 'employee_id') || typeof body.employee_id !== 'string') fail(400, '员工账号不能为空。')
      const assignment = await this.add(auth, body.employee_id)
      res.statusCode = 201; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ assignment })); return true
    }
    const remove = url.pathname.match(/^\/studio\/employee-conversations\/assignments\/([^/]+)$/)
    if (remove && req.method === 'DELETE') {
      let assignmentId
      try { assignmentId = decodeURIComponent(remove[1]) } catch { fail(400, '查看授权标识格式不正确。') }
      const result = await this.remove(auth, assignmentId)
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(result)); return true
    }
    const messages = url.pathname.match(/^\/studio\/employee-conversations\/([^/]+)\/sessions\/([^/]+)\/messages$/)
    if (messages && req.method === 'GET') {
      let employeeId, sessionId
      try { employeeId = decodeURIComponent(messages[1]); sessionId = decodeURIComponent(messages[2]) } catch { fail(400, '员工对话标识格式不正确。') }
      const employee = this.employee(employeeId)
      if (!this.canView(auth, employee.id)) fail(403, '未授权查看该员工对话。')
      await service.session(employee, sessionId)
      const response = await service.fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, employee, { limit: 500, order: 'oldest', inline_images: false })
      if (!response.ok) fail(response.status === 404 ? 404 : 503, '暂时无法读取员工对话。')
      const data = await response.json()
      const projected = await service.presentation.messagesAs(auth.user, employee, data.messages)
      await this.store.verifyActor(auth)
      if (!this.canView(auth, employee.id)) fail(403, '已停止查看该员工对话。')
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ session_id: sessionId, messages: projected })); return true
    }
    fail(404, '员工对话操作不存在。')
  }

  async sessions(actor, employee) {
    this.employee(employee.id)
    if (!this.assignments.some(row => row.createdBy === actor.id && row.employeeId === employee.id)) return []
    const sessions = []
    for (let offset = 0; ; offset += 100) {
      const response = await this.service.fetch('/api/sessions', employee, { limit: 100, offset, order: 'recent', archived: 'include' })
      if (!response.ok) fail(503, '暂时无法读取员工对话列表。')
      const data = await response.json()
      const page = Array.isArray(data.sessions) ? data.sessions : []
      sessions.push(...page)
      if (page.length < 100) break
    }
    return sessions.map(row => ({ id: row.id, title: row.title, preview: row.preview, started_at: row.started_at, message_count: row.message_count, archived: Boolean(row.archived) }))
  }
}

export async function createEmployeeAccess(dataDir, store, service) {
  return EmployeeAccess.open(dataDir, store, service)
}

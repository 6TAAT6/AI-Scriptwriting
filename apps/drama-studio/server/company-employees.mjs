import { StudioError, companyUsername, fail } from './accounts.mjs'

const COMPANY_ORGANIZATIONS = ['hangzhou', 'chongqing']
const EMPLOYEE_ID = /^[1-9][0-9]{0,19}$/
// 单次同步最多停用的公司账号数；超过时只建号/恢复，防止公司接口异常导致批量停用。
const MAX_REMOVALS = 10

const companyAccounts = users => new Map(users.filter(user => user.auth_source === 'company').map(user => [user.employee_id, user]))

/**
 * 部门 → 该部门普通员工的归属集合；只有一个归属的部门可以给新人自动定归属。
 * 管理员常跨团队任职（如横店经理挂在重庆部门），不参与推断；同一轮里有明确归属的新员工计入。
 */
function departmentOrganizations(directory, accounts) {
  const departments = new Map()
  for (const employee of directory) {
    const user = accounts.get(employee.id)
    const organization = user ? (user.role === 'employee' ? user.organization : null) : employee.organization
    if (!employee.departmentId || !COMPANY_ORGANIZATIONS.includes(organization)) continue
    departments.set(employee.departmentId, (departments.get(employee.departmentId) ?? new Set()).add(organization))
  }
  return departments
}

/**
 * 新员工归属：公司接口返回的字段或部署映射优先，其次同部门已建号员工全部属于同一公司时沿用；
 * 部门混合（如横店、重庆同在一个部门）或新部门返回 null，交管理员在人员管理里分配。
 */
function resolveOrganization(employee, departments) {
  if (COMPANY_ORGANIZATIONS.includes(employee.organization)) return employee.organization
  const peers = employee.departmentId ? departments.get(employee.departmentId) : undefined
  return peers?.size === 1 ? [...peers][0] : null
}

/**
 * 按公司目录计算账号同步：目录新增且能确定归属的员工建号；目录中已没有的公司账号停用并标记
 * （保留创作记录和工作区）；被同步停用的账号重新出现在目录时恢复启用。管理员手动停用的不会被自动启用。
 */
export function planCompanySync(directory, users) {
  const accounts = companyAccounts(users), present = new Set(directory.map(employee => employee.id))
  const departments = departmentOrganizations(directory, accounts), usernames = new Set(users.map(user => String(user.username).toLowerCase()))
  const create = [], conflicts = []
  for (const employee of directory) {
    if (accounts.has(employee.id)) continue
    const organization = resolveOrganization(employee, departments)
    if (!organization) continue
    if (usernames.has(companyUsername(employee))) conflicts.push(employee.id)
    else create.push({ employee, organization })
  }
  const remove = [], restore = []
  for (const user of accounts.values()) {
    if (!present.has(user.employee_id) && !user.company_removed_at) remove.push(user.id)
    if (present.has(user.employee_id) && user.company_removed_at) restore.push(user.id)
  }
  return { create, remove, restore, conflicts }
}

/** 公司目录里还没有智能体账号、自动同步也定不了归属的员工；同部门有建号员工时附带建议，由管理员确认。 */
export function pendingCompanyEmployees(directory, users) {
  const accounts = companyAccounts(users), departments = departmentOrganizations(directory, accounts)
  const usernames = new Set(users.map(user => String(user.username).toLowerCase()))
  return directory.filter(employee => !accounts.has(employee.id) && !resolveOrganization(employee, departments)).map(employee => {
    const peers = employee.departmentId ? departments.get(employee.departmentId) : undefined
    return { employee_id: employee.id, name: employee.name, account: employee.account, department_name: employee.departmentName, position_name: employee.positionName,
      department_organizations: peers ? [...peers].sort() : [], username_conflict: usernames.has(companyUsername(employee)) }
  })
}

/** 应用目录同步；没有变化时不写账号库。被停用的账号同时撤销登录和工作进程。 */
export async function syncCompanyAccounts(store, directory) {
  if (!store.organizations || !store.company) return null
  const preview = planCompanySync(directory, store.users)
  if (!preview.create.length && !preview.remove.length && !preview.restore.length) return { created: [], removed: [], restored: [], conflicts: preview.conflicts, removal_blocked: 0 }
  const revoke = []
  return store.mutate(async users => {
    const plan = planCompanySync(directory, users), at = new Date().toISOString()
    const byId = new Map(users.map(user => [user.id, user])), created = [], conflicts = [...plan.conflicts]
    for (const { employee, organization } of plan.create) {
      try { created.push((await store.companyUser(users, employee, organization)).employee_id) }
      catch (error) { if (error instanceof StudioError && error.status === 409) conflicts.push(employee.id); else throw error }
    }
    // 空目录只可能是上游异常（能登录的员工必在授权目录里），一律不停用。
    const blocked = plan.remove.length > MAX_REMOVALS || !directory.length && plan.remove.length > 0
    if (!blocked) for (const id of plan.remove) {
      const user = byId.get(id)
      user.company_removed_at = at; user.updated_at = at
      if (user.enabled) { user.enabled = false; user.company_sync_disabled = true; user.version++; revoke.push(id) }
    }
    for (const id of plan.restore) {
      const user = byId.get(id)
      delete user.company_removed_at; user.updated_at = at
      if (user.company_sync_disabled) { user.enabled = true; delete user.company_sync_disabled; user.version++ }
    }
    const employeeIds = ids => ids.map(id => byId.get(id).employee_id)
    return { created, removed: blocked ? [] : employeeIds(plan.remove), restored: employeeIds(plan.restore), conflicts, removal_blocked: blocked ? plan.remove.length : 0 }
  }, null, async () => { for (const id of revoke) await store.revokeInQueue(id) })
}

/** 定时读取公司目录并同步账号；目录读取失败只记日志，不改账号。 */
export function startCompanySync({ store, company, intervalMs = 5 * 60_000, firstDelayMs = 30_000 }) {
  let running = null, stopped = false
  const run = () => {
    if (stopped) return Promise.resolve(null)
    running ??= company.directory()
      .then(directory => syncCompanyAccounts(store, directory))
      .then(summary => {
        if (summary && (summary.created.length || summary.removed.length || summary.restored.length || summary.removal_blocked)) console.log('COMPANY_SYNC ' + JSON.stringify(summary))
        return summary
      }, error => { console.error('COMPANY_SYNC_FAILED ' + (error?.message || error?.name || 'unknown')); return null })
      .finally(() => { running = null })
    return running
  }
  const first = setTimeout(() => void run(), firstDelayMs), timer = setInterval(() => void run(), intervalMs)
  first.unref?.(); timer.unref?.()
  return { run, async close() { stopped = true; clearTimeout(first); clearInterval(timer); await running } }
}

/** 人员管理「待分配公司员工」：打开时先同步一次目录，再列出仍需人工分配的人；管理员选定横店/重庆后预先建号。 */
export async function handleCompanyEmployees({ req, url, user, auth, body, store, company }) {
  if (url.pathname !== '/studio/admin/company-employees') return null
  if (!['admin', 'super_admin'].includes(user.role)) fail(403, '此操作需要管理员权限。')
  const available = Boolean(store.organizations && company)
  if (req.method === 'GET') {
    if (!available) return { status: 200, data: { available, employees: [] } }
    const directory = await company.directory()
    const summary = await syncCompanyAccounts(store, directory)
    const changed = Boolean(summary.created.length || summary.removed.length || summary.restored.length)
    return { status: 200, data: { available, changed, employees: pendingCompanyEmployees(directory, store.users) } }
  }
  if (req.method !== 'POST') fail(404, '此功能不存在。')
  if (Object.keys(body).some(key => !['employee_id', 'organization'].includes(key))) fail(400, '请求包含不支持的字段。')
  if (!available) fail(404, '此功能不存在。')
  if (typeof body.employee_id !== 'string' || !EMPLOYEE_ID.test(body.employee_id)) fail(400, '公司员工编号不正确。')
  const employee = (await company.directory()).find(row => row.id === body.employee_id)
  if (!employee) fail(404, '公司员工目录中没有这位员工，请确认公司后台已授权本应用。')
  return { status: 201, data: { user: await store.assignCompany(auth, employee, body.organization) } }
}

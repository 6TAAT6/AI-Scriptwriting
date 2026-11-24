import { validOrganization } from '../shared/organizations.mjs'

const EMPLOYEE_ID = /^[1-9][0-9]{0,19}$/

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组。`)
  return value
}

function indexUnique(rows, key, message) {
  const result = new Map()
  for (const row of rows) {
    const value = row?.[key]
    if (typeof value !== 'string' || !value) throw new Error(`${message}包含无效${key}。`)
    if (result.has(value)) throw new Error(`${message}存在重复 ${key}：${value}`)
    result.set(value, row)
  }
  return result
}

/**
 * 生成目录同步预览，不写账号库、不创建 profile、不修改历史数据。
 * employee_id 是唯一绑定键；账号只用于定位现有本地账号候选。
 */
export function previewDirectorySync(users, employees, organizationByEmployee = {}) {
  const userRows = requireArray(users, '智能体账号')
  const directoryRows = requireArray(employees, '后台员工目录')
  const directoryById = indexUnique(directoryRows, 'employeeId', '后台目录')
  const accountOwners = new Map()
  for (const employee of directoryRows) {
    const account = typeof employee.account === 'string' ? employee.account.trim().toLowerCase() : ''
    if (!account) continue
    const previous = accountOwners.get(account)
    if (previous && previous.employeeId !== employee.employeeId) throw new Error(`账号已被多个员工目录记录使用：${account}`)
    accountOwners.set(account, employee)
  }
  const companyByEmployee = indexUnique(userRows.filter(user => user.auth_source === 'company' && user.employee_id), 'employee_id', '智能体公司绑定')
  const localByUsername = new Map()
  for (const user of userRows) {
    if (typeof user.username !== 'string' || !user.username) continue
    const key = user.username.trim().toLowerCase()
    const previous = localByUsername.get(key)
    if (previous && previous.id !== user.id) throw new Error(`智能体账号重复：${key}`)
    localByUsername.set(key, user)
  }
  const rows = []
  const matchedUserIds = new Set()
  for (const employee of directoryRows) {
    const employeeId = employee.employeeId
    if (!EMPLOYEE_ID.test(employeeId)) throw new Error(`后台 employee_id 无效：${employeeId}`)
    const mapped = employee.organization ?? organizationByEmployee[employeeId]
    if (!validOrganization(mapped) || mapped === 'unassigned') throw new Error(`员工组织资料缺失：${employeeId}`)
    const existingCompany = companyByEmployee.get(employeeId)
    if (existingCompany) {
      if (existingCompany.organization !== mapped) throw new Error(`公司绑定组织冲突：${employeeId}`)
      matchedUserIds.add(existingCompany.id)
      rows.push({ employee_id: employeeId, account: employee.account ?? '', name: employee.name ?? '', organization: mapped,
        department_id: employee.departmentId ?? null, department_name: employee.departmentName ?? null,
        target_user_id: existingCompany.id, target_profile: existingCompany.profile, action: 'existing_company' })
      continue
    }
    const account = typeof employee.account === 'string' ? employee.account.trim().toLowerCase() : ''
    const local = account ? localByUsername.get(account) : undefined
    if (local) {
      if (local.auth_source !== 'local' || local.role !== 'employee') throw new Error(`现有账号不能绑定为员工：${account}`)
      matchedUserIds.add(local.id)
      rows.push({ employee_id: employeeId, account: employee.account ?? '', name: employee.name ?? '', organization: mapped,
        department_id: employee.departmentId ?? null, department_name: employee.departmentName ?? null,
        target_user_id: local.id, target_profile: local.profile, action: 'bind_existing_local' })
    } else {
      rows.push({ employee_id: employeeId, account: employee.account ?? '', name: employee.name ?? '', organization: mapped,
        department_id: employee.departmentId ?? null, department_name: employee.departmentName ?? null,
        target_user_id: null, target_profile: null, action: 'create_company' })
    }
  }
  const skippedLocalAccounts = userRows.filter(user => user.auth_source === 'local' && !matchedUserIds.has(user.id)).map(user => user.username).sort()
  return { rows, skipped_local_accounts: skippedLocalAccounts, conflicts: [] }
}

/**
 * 将已审核的预览应用到账号对象副本；调用方负责备份、profile 创建和原子落盘。
 * 原地绑定保留 UUID/profile/业务字段，并递增 version 让旧本地会话失效。
 */
export function applyDirectorySync(users, preview, { idFactory, profileFactory, passwordHashFactory = () => undefined } = {}) {
  if (typeof idFactory !== 'function' || typeof profileFactory !== 'function') throw new Error('账号同步缺少 ID/profile 生成器。')
  if (!preview || !Array.isArray(preview.rows) || preview.conflicts?.length) throw new Error('账号同步预览无效或存在冲突。')
  const next = users.map(user => ({ ...user }))
  const byId = new Map(next.map(user => [user.id, user]))
  const usernames = new Set(next.map(user => String(user.username).toLowerCase()))
  const bound = [], created = []
  for (const row of preview.rows) {
    if (row.action === 'existing_company') continue
    if (row.action === 'bind_existing_local') {
      const user = byId.get(row.target_user_id)
      if (!user || user.auth_source !== 'local' || user.role !== 'employee') throw new Error(`绑定目标账号无效：${row.target_user_id}`)
      user.auth_source = 'company'
      user.employee_id = row.employee_id
      user.organization = row.organization
      user.display_name = row.name || user.display_name
      user.version = Math.max(1, Number(user.version) || 1) + 1
      delete user.passwordHash
      bound.push({ id: user.id, employee_id: row.employee_id, profile: user.profile })
      continue
    }
    if (row.action !== 'create_company') throw new Error(`未知同步动作：${row.action}`)
    const username = String(row.account || '').trim().toLowerCase()
    if (!username || usernames.has(username)) throw new Error(`新建账号用户名冲突：${username}`)
    const id = idFactory()
    const profile = profileFactory(id)
    if (typeof id !== 'string' || !id || typeof profile !== 'string' || !profile) throw new Error('新账号身份生成器返回无效值。')
    usernames.add(username)
    const user = { id, username, display_name: row.name, role: 'employee', enabled: true, activated_at: null,
      profile, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_login_at: null,
      version: 1, organization: row.organization, auth_source: 'company', employee_id: row.employee_id,
      managed_organizations: [], conversation_organizations: [] }
    const passwordHash = passwordHashFactory(user)
    if (passwordHash !== undefined) user.passwordHash = passwordHash
    next.push(user); created.push({ id, employee_id: row.employee_id, profile, organization: row.organization })
  }
  return { users: next, bound, created, skipped_local_accounts: preview.skipped_local_accounts ?? [] }
}

import { validOrganization, validScope } from '../shared/organizations.mjs'

// Verified legacy business IDs. Names and phone numbers never become identity keys.
const companyBindings = new Map(Object.entries({
  "8f6f3b35-8270-4f8c-b268-833273414fb8": "79",
  "377a7d0f-f1a3-4151-abbe-38701ecf694d": "226",
  "18b801d5-ac80-4182-84fe-2cb612ffd940": "123",
  "bc388f96-b913-469a-b336-d1c626cfb4e5": "91",
  "1f491edb-44c3-452a-a785-fea91f616850": "80",
  "f61a9469-021e-4127-a2e5-916e8c5b49e6": "137",
  "27be4588-5f79-4a5c-ad23-fee915a93121": "115",
  "1de1c587-7c35-4ce3-9802-cb3ef3856f75": "150",
  "91375be0-a573-4b95-8b25-1acf42c015e0": "124",
  "465ef9ac-e7c0-4452-afb3-8abd3843f796": "122",
  "ea097168-5f27-41f2-8051-3d3be81e23f2": "112",
  "ce48f078-ac17-410b-a3c9-fd5c97e16fbc": "221",
  "52caffe1-ee72-4e1f-ad23-9739ef65a868": "194",
  "4a8a695c-3e6b-4afd-8c11-1d1ae0a456c1": "146",
  "e1f23701-9c32-40c0-a96f-7c3a44bc6acc": "139",
  "c421cd4d-2416-4d7e-89e9-bea3eb8d3b9a": "107",
  "2130cdc2-f833-4dfb-b11d-613c0b20cfbf": "106",
  "a348fe3b-9602-40c2-abe7-d5343e881800": "103",
  "be09ebce-ce02-4d6d-a5ee-bab40fbba9e4": "136",
  "5f51b278-15f1-47d2-8b0d-dd21c666f5bb": "125",
  "528cb685-9523-43dc-a6a1-cdf5b4f7b567": "119",
  "eb9c3984-d361-4b97-9406-a56ce224a488": "186",
  "a697cfcc-fb3e-4ec5-b711-9801c005f29b": "184",
  "182b279d-ac88-4b1c-8bae-552d70a1761c": "148",
  "09a1b1c0-8658-4d01-8a44-84dd5a0997ff": "135",
  "5d56b23e-f410-423d-a9e9-2d2851645968": "118",
  "25e7bfe4-0a3a-4804-88e7-c4e9452d22c4": "175",
  "55bc4397-264f-46ee-aa87-e96603799359": "249",
  "97ccaa05-5cda-442b-bdd0-f50bcd999727": "147",
  "3a2c109f-eaf1-42e7-a1fd-01294b0e1569": "110",
  "18311314-470b-471f-a907-199af477d6cb": "104",
  "bc0824ea-e267-4e78-8da1-91648e5f2bed": "138",
  "32e1b647-5ae4-419d-8857-2598612eba95": "127"
}))
const branchMembers = new Set([
  "d64dc6c0-9fc6-4c8f-911c-61957f4a4c63",
  "6c393c30-d527-4ce8-a3a1-b16e961ce737",
  "c7ca9715-8f4c-47bb-9e2f-111dad7397f5",
  "8d4f3a54-f513-40db-9afa-c36494f4e816",
  "1c2c7a40-fa40-43cc-8976-2343228410d2",
  "c8188a90-823d-4be8-a7ae-944f7a7a5796",
  "38cdb4be-9d49-4e55-8ab1-228b62f345b4",
  "5709ff89-bca5-4ccb-b862-7d3273d301fd",
  "5ad26313-6806-4c42-b711-3e79312eee35",
  "28682fdf-7bfc-4dea-bf79-9640bf6ecffc",
  "7a58a8ca-eb93-4b6e-9de5-16e973dcda86",
  "a3b2bbd8-5946-4c00-b5d2-4e24876bf622"
])
const crossCompanyManager = '18311314-470b-471f-a907-199af477d6cb'
const retiredTestAccount = '98697a06-648b-4dfa-be0b-2fbc0aef92fa'
const localTestMembers = new Set([
  '16654975-9fad-40e2-b2ec-cdd1eb4be5f1',
  'd8ad984a-dad3-41ca-a1a2-2ceb65a8c764',
  '50b60813-3e2d-4eba-9dcc-083294603ea9',
  'cca3cc27-e330-4037-8770-9caf4f150158',
  '7b60d6ab-6dce-4730-96d5-78e5a3b90c15'
])

/** Returns a copy; running this against live state performs no writes. */
export function previewIdentityMigration(saved, access = { assignments: [] }, options = {}) {
  const retireTestAccount = options.retireTestAccount === true
  if (!saved || saved.version !== 2 || !Array.isArray(saved.users) || !Array.isArray(saved.activation_codes)) throw new Error('账号文件格式不受支持。')
  if (!Array.isArray(access.assignments)) throw new Error('对话查看授权格式不正确。')
  if (saved.users.some(user => !Number.isInteger(user.version) || user.version < 1)) throw new Error('账号版本缺失或无效。')
  const next = structuredClone(saved), ids = new Set()
  const retirementCandidates = next.users.filter(user => user.id === retiredTestAccount).map(user => ({ id: user.id, username: user.username, name: user.display_name, profile: user.profile }))
  if (retireTestAccount && retirementCandidates.length && access.assignments.some(row => row.employeeId === retiredTestAccount || row.createdBy === retiredTestAccount)) throw new Error('已确认删除的测试账号仍有关联查看分配，请通过原删除流程先处理。')
  if (retireTestAccount) next.users = next.users.filter(user => user.id !== retiredTestAccount)
  const retired = retireTestAccount ? retirementCandidates : []
  for (const user of next.users) {
    if (typeof user.id !== 'string' || ids.has(user.id)) throw new Error('业务账号ID重复。')
    ids.add(user.id)
    const existingIdentity = 'organization' in user
    if (existingIdentity && (!validOrganization(user.organization) || !validScope(user.managed_organizations) || !['local', 'company'].includes(user.auth_source))) throw new Error('已有组织字段不完整。')
    const employeeId = companyBindings.get(user.id)
    if (!existingIdentity) {
      user.organization = 'unassigned'; user.auth_source = 'local'; user.managed_organizations = []
    }
    if (employeeId) {
      if (user.auth_source === 'company' && user.employee_id !== employeeId) throw new Error('公司员工身份与既有绑定冲突。')
      if (user.auth_source !== 'company') user.version += 1
      user.organization = 'hangzhou'; user.auth_source = 'company'; user.employee_id = employeeId
      delete user.local_login_reason
    } else if (branchMembers.has(user.id)) {
      if (user.auth_source === 'company') throw new Error('重庆本地身份与既有公司绑定冲突。')
      user.organization = 'chongqing'
    } else if (localTestMembers.has(user.id) || user.role === 'super_admin' && user.username === 'root') {
      if (user.auth_source !== 'local') throw new Error('系统测试账号存在公司绑定，请先核对。')
      user.organization = 'unassigned'; user.local_login_reason = 'test'
    }
    if (!existingIdentity && user.role === 'admin' && user.organization !== 'unassigned') user.managed_organizations = [user.organization]
    if (user.id === crossCompanyManager) user.managed_organizations = ['chongqing']
  }
  const bindings = next.users.filter(user => user.auth_source === 'company').map(user => user.employee_id)
  if (bindings.some(value => typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) || new Set(bindings).size !== bindings.length) throw new Error('公司身份绑定不正确或重复。')
  const fields = ['organization', 'auth_source', 'employee_id', 'managed_organizations', 'local_login_reason']
  const rows = next.users.map(user => ({ id: user.id, ...Object.fromEntries(fields.filter(key => key in user).map(key => [key, user[key]])) }))
  return { next, rows, retired, retirementCandidates, summary: { accounts: next.users.length, company: bindings.length, branch: next.users.filter(user => user.organization === 'chongqing').length,
    localCompanyPending: next.users.filter(user => user.local_login_reason === 'pending_company').length,
    localSystemTest: next.users.filter(user => user.local_login_reason === 'test').length,
    unassigned: next.users.filter(user => user.organization === 'unassigned').length, activationCodes: next.activation_codes.length, viewingAssignments: access.assignments.length,
    retiredAccounts: retired.length, retiredViewingAssignments: access.assignments.filter(row => row.employeeId === retiredTestAccount || row.createdBy === retiredTestAccount).length } }
}

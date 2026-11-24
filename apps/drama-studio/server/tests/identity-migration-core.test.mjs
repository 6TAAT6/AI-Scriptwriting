import assert from 'node:assert/strict'
import test from 'node:test'
import { previewIdentityMigration } from '../identity-migration.mjs'

test('身份迁移预览只生成副本并保留业务字段', () => {
  const saved = { version: 2, users: [
    { id: '55bc4397-264f-46ee-aa87-e96603799359', username: 'floor-user', display_name: '楼佳伟', role: 'employee', enabled: true, version: 1, profile: 'studio-floor', passwordHash: 'salt:hash' },
    { id: '18311314-470b-471f-a907-199af477d6cb', username: 'manager', display_name: '经理', role: 'admin', enabled: true, version: 1, profile: 'studio-manager', passwordHash: 'salt:hash' }
  ], activation_codes: [{ id: 'code-1' }] }
  const before = structuredClone(saved)
  const result = previewIdentityMigration(saved)
  assert.deepEqual(saved, before)
  const floor = result.next.users.find(user => user.username === 'floor-user')
  assert.equal(floor.auth_source, 'company')
  assert.equal(floor.employee_id, '249')
  assert.equal(floor.profile, 'studio-floor')
  assert.equal(floor.passwordHash, 'salt:hash')
  assert.equal(result.summary.company, 2)
})

test('迁移预览拒绝缺失账号版本，默认保留资料包曾删除的旧账号', () => {
  const oldId = '98697a06-648b-4dfa-be0b-2fbc0aef92fa'
  const saved = { version: 2, users: [{ id: oldId, username: 'admin6', display_name: '旧账号', role: 'employee', version: 1 }], activation_codes: [] }
  const preview = previewIdentityMigration(saved, { assignments: [{ employeeId: oldId }] })
  assert.equal(preview.next.users.some(user => user.id === oldId), true)
  assert.throws(() => previewIdentityMigration(saved, { assignments: [{ employeeId: oldId }] }, { retireTestAccount: true }), /关联查看分配/)
  const retired = previewIdentityMigration(saved, { assignments: [] }, { retireTestAccount: true })
  assert.equal(retired.next.users.some(user => user.id === oldId), false)
  const broken = { version: 2, users: [{ id: '55bc4397-264f-46ee-aa87-e96603799359', username: 'floor-user' }], activation_codes: [] }
  assert.throws(() => previewIdentityMigration(broken), /账号版本/)
})

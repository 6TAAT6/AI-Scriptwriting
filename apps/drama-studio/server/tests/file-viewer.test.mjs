import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { FileHandles } from '../file-handles.mjs'

test('管理员查看员工历史时，文件句柄归管理员但实际读取员工资料', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-file-viewer-'))
  const employee = { id: 'employee-1', role: 'employee', profile: 'studio-employee' }
  const admin = { id: 'admin-1', role: 'admin', profile: 'studio-admin' }
  const employeeHome = path.join(root, employee.profile)
  const adminHome = path.join(root, admin.profile)
  const image = path.join(employeeHome, 'cache/generated/images/scene.png')
  await mkdir(path.dirname(image), { recursive: true }); await mkdir(adminHome, { recursive: true }); await writeFile(image, 'image')
  const backend = {
    homeFor: user => path.join(root, user.profile),
    file: async (_user, rawPath) => realpath(rawPath)
  }
  const files = new FileHandles(backend)
  const handle = await files.registerAs(admin, employee, image, 'image')
  assert.match(handle, /^\/assets-data\/[A-Za-z0-9_-]{32}\//)
  const entry = await files.resolveEntry(admin, handle)
  assert.equal(entry.path, await realpath(image))
  assert.equal(entry.sourceUser.profile, employee.profile)
  await assert.rejects(() => files.resolveEntry(employee, handle), error => error.status === 403)
  await t.after(() => rm(root, { recursive: true, force: true }))
})

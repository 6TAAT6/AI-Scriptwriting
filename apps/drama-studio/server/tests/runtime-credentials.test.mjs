import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runtimeToken } from '../runtime-credentials.mjs'

test('服务凭证持久化为私有文件，前端重启不会改变后端凭证', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-service-token-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(await runtimeToken(root), '')
  const token = await runtimeToken(root, { create: true })
  assert.equal(await runtimeToken(root), token)
  assert.equal(await runtimeToken(root, { create: true }), token)
  assert.equal((await stat(path.join(root, 'runtime-token'))).mode & 0o777, 0o600)
})

test('服务凭证拒绝符号链接及不安全权限，不回退到公开页面取令牌', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-service-token-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outside = path.join(root, 'outside')
  await writeFile(outside, 'a'.repeat(43), { mode: 0o600 })
  await symlink(outside, path.join(root, 'runtime-token'))
  await assert.rejects(runtimeToken(root, { create: true }))
  await rm(path.join(root, 'runtime-token'))
  await writeFile(path.join(root, 'runtime-token'), 'a'.repeat(43), { mode: 0o644 })
  await assert.rejects(runtimeToken(root))
})

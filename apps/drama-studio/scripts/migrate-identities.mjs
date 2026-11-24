import { readFile, writeFile, open, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { previewIdentityMigration } from '../server/identity-migration.mjs'

const args = process.argv.slice(2)
const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }
const accountPath = value('--accounts'), accessPath = value('--access'), output = value('--output')
if (!accountPath || !path.isAbsolute(accountPath)) throw new Error('请以--accounts指定账号文件绝对路径；默认只读预览。')
const original = await readFile(accountPath), digest = data => createHash('sha256').update(data).digest('hex')
const access = accessPath ? JSON.parse(await readFile(accessPath, 'utf8')) : { assignments: [] }
const plan = previewIdentityMigration(JSON.parse(original), access)
const preview = { sourceSha256: digest(original), summary: plan.summary, rows: plan.rows, retired: plan.retired, mode: args.includes('--apply') ? 'apply' : 'preview' }
if (args.includes('--apply')) {
  if (!args.includes('--offline-confirmed') || !accessPath || value('--expected-sha256') !== digest(original) || !output || !path.isAbsolute(output)) throw new Error('应用迁移须停用写入服务，提供--offline-confirmed、原对话授权--access、预览摘要和绝对路径备份输出。')
  if (plan.summary.retiredViewingAssignments) throw new Error('已确认删除的测试账号仍有关联查看分配，请通过原删除流程先处理。')
  const lock = await open(accountPath + '.identity-migration.lock', 'wx', 0o600)
  const temp = accountPath + '.' + randomUUID() + '.tmp'
  try {
    if (digest(await readFile(accountPath)) !== preview.sourceSha256) throw new Error('账号文件已变化，请重新预览。')
    await writeFile(output, original, { flag: 'wx', mode: 0o600 })
    await writeFile(temp, JSON.stringify(plan.next), { flag: 'wx', mode: 0o600 })
    if (digest(await readFile(accountPath)) !== preview.sourceSha256) throw new Error('账号文件已变化，停止迁移。')
    await rename(temp, accountPath)
  } finally { await rm(temp, { force: true }); await lock.close(); await rm(accountPath + '.identity-migration.lock', { force: true }) }
} else if (output) await writeFile(output, JSON.stringify(preview, null, 2), { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ sourceSha256: preview.sourceSha256, ...plan.summary, mode: preview.mode }))

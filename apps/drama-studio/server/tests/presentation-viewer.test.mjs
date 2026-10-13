import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { FileHandles } from '../file-handles.mjs'
import { StudioPresentation } from '../presentation.mjs'

test('员工历史投影给管理员时，图片和附件转换为管理员可读句柄', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-presentation-viewer-'))
  const employee = { id: 'employee-1', role: 'employee', profile: 'studio-employee' }
  const admin = { id: 'admin-1', role: 'admin', profile: 'studio-admin' }
  const image = path.join(root, employee.profile, 'cache/generated/images/scene.png')
  const attachment = path.join(root, employee.profile, 'attachments/source.txt')
  await mkdir(path.dirname(image), { recursive: true }); await mkdir(path.dirname(attachment), { recursive: true })
  await writeFile(image, 'image'); await writeFile(attachment, 'source')
  const backend = {
    repoRoot: root,
    homeFor: user => path.join(root, user.profile),
    file: async (_user, rawPath) => realpath(rawPath),
    fetch: async () => { throw new Error('不应读取持久化回执') }
  }
  backend.files = new FileHandles(backend)
  const presentation = new StudioPresentation(backend)
  const rows = [
    { role: 'user', row_id: 1, text: `请查看 @file:${attachment}` },
    { role: 'assistant', row_id: 2, text: `已生成图片：![欧洲女性人像](${image})` },
    { role: 'tool', row_id: 3, name: 'image_generate', content: JSON.stringify({ success: true, image }) }
  ]
  const result = await presentation.messagesAs(admin, employee, rows)
  assert.match(result[0].text, /@file:`\/assets-data\//)
  assert.match(result[1].text, /!\[欧洲女性人像\]\(\/assets-data\/[A-Za-z0-9_-]{32}\//)
  assert.match(result[2].content.image, /^\/assets-data\/[A-Za-z0-9_-]{32}\//)
  const imageEntry = await backend.files.resolveEntry(admin, result[2].content.image)
  assert.equal(imageEntry.sourceUser.profile, employee.profile)
  await t.after(() => rm(root, { recursive: true, force: true }))
})

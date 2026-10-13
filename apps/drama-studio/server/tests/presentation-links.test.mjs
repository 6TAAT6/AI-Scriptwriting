import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { StudioBackend } from '../backend.mjs'
import { WorkerPool } from '../worker-pool.mjs'

test('正文完成与历史保留公开链接，隐藏当前及轮换前的模型服务来源', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'studio-origin-links-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  let settings = { baseUrl: 'https://private-model.invalid/v1', providers: [{ baseUrl: 'https://second-model.invalid/api' }] }
  const pool = new WorkerPool({ repoRoot: '/fixture', hermesHome: home, settingsLoader: async () => settings })
  const backend = new StudioBackend({ backend: 'http://127.0.0.1:10620', repoRoot: '/fixture', workerPool: pool })
  const publicText = '[外部说明](https://example.com/help)\n![图片预览](https://example.com/preview.png)'
  const privateText = '\nhttps://private-model.invalid/v1/responses\nhttps://second-model.invalid/api\nhttp://127.0.0.1:10620/api/ws\nhttp://127.0.0.1:45100/scope/' + 'a'.repeat(32) + '/v1\nsk-' + 'x'.repeat(30)
  const input = publicText + privateText
  for (const role of ['super_admin', 'employee']) {
    const user = { id: role, role, profile: 'studio-' + 'a'.repeat(20) }
    const output = await backend.presentation.finish(user, 'session', input, new Map())
    assert.ok(output.startsWith(publicText))
    assert.doesNotMatch(output, /private-model|second-model|127\.0\.0\.1|sk-x/)
    const punctuated = await backend.presentation.finish(user, 'session', '服务地址：https://private-model.invalid。', new Map())
    assert.equal(punctuated, '服务地址：当前模型服务地址。')
    assert.equal(await backend.presentation.finish(user, 'session', 'https://private-model.invalid，稍后重试。', new Map()), '当前模型服务地址，稍后重试。')
    for (const wrapper of ['"', "'", '`', ';']) assert.doesNotMatch(await backend.presentation.finish(user, 'session', wrapper + 'https://private-model.invalid' + wrapper, new Map()), /private-model/)
    const history = await backend.presentation.nativeMessages(user, [{ role: 'assistant', content: input }])
    assert.equal(history[0].content, output)
  }
  settings = { baseUrl: 'https://new-model.invalid/v1', providers: [] }
  await pool.readSettings()
  const output = await backend.presentation.finish({ id: 'root', role: 'super_admin' }, 'session', input + '\nhttps://new-model.invalid/v1', new Map())
  assert.ok(output.startsWith(publicText))
  assert.doesNotMatch(output, /private-model|second-model|new-model/)
  const restartedPool = new WorkerPool({ repoRoot: '/fixture', hermesHome: home, settingsLoader: async () => settings })
  const restarted = new StudioBackend({ backend: 'http://127.0.0.1:10620', repoRoot: '/fixture', workerPool: restartedPool })
  const history = await restarted.presentation.nativeMessages({ id: 'root', role: 'super_admin' }, [{ role: 'assistant', content: input }])
  assert.ok(history[0].content.startsWith(publicText))
  assert.doesNotMatch(history[0].content, /private-model|second-model|127\.0\.0\.1|sk-x/)
})

test('模型配置读取失败时沿用隐藏地址，恢复后公开链接可用且凭证型链接仍隐藏', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'studio-origin-recovery-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  let unavailable = true
  const pool = new WorkerPool({ repoRoot: '/fixture', hermesHome: home, settingsLoader: async () => {
    if (unavailable) throw new Error('配置暂不可用')
    return { baseUrl: 'https://model.invalid/v1' }
  } })
  const backend = new StudioBackend({ backend: 'http://127.0.0.1:10620', repoRoot: '/fixture', workerPool: pool })
  const user = { id: 'root', role: 'super_admin' }
  const render = text => backend.presentation.finish(user, 'session', text, new Map())
  assert.doesNotMatch(await render('https://example.com/help'), /https:/)
  unavailable = false
  assert.equal(await render('https://example.com/help'), 'https://example.com/help')
  assert.doesNotMatch(await render('https://name:password@example.com/help'), /password|https:/)
  await writeFile(path.join(home, 'studio/model-service-origins.json'), '损坏的记录')
  assert.equal((await pool.readSettings()).baseUrl, 'https://model.invalid/v1')
  assert.doesNotMatch(await render('https://model.invalid/v1\nhttps://example.com/help'), /https:/)
})


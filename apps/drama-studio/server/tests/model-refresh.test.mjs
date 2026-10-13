import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkerPool } from '../worker-pool.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

test('平台保存新接入后刷新真实账号配置，保留工作进程及账号代理凭证', { skip: process.platform !== 'darwin' }, async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-model-refresh-')))
  // 临时账号只隔离业务数据；沿用 PM 已预装的测试环境，避免每次测试都安装完整依赖。
  const python = execFileSync(path.join(repoRoot, '.venv/bin/python'), ['-B', '-c',
    'from pathlib import Path; from pm.environments import activation_environment; print(activation_environment(Path.cwd())["__HERMES_TEST_PYTHON"])'],
    { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 }).trim()
  const nativeRuntime = { python, pythonPath: repoRoot, pythonPaths: [repoRoot], runtimeDir: path.join(repoRoot, '.hermes-runtime') }
  let providers = []
  const settingsLoader = async () => ({ baseUrl: 'https://original.invalid/v1', apiKey: 'owner-private-fixture', defaultModel: 'original-model', models: ['original-model'], apiMode: 'chat_completions', providers: structuredClone(providers) })
  const pool = new WorkerPool({ repoRoot, hermesHome: home, settingsLoader, nativeRuntime })
  const profile = 'studio-' + 'c'.repeat(20)
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { detached: true })
  await once(child.stdout, 'data')
  t.after(async () => { await pool.close(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(home, { recursive: true, force: true }) })
  await pool.provision(profile)
  const workspace = pool.homeFor({ profile })
  const tokenBefore = await readFile(path.join(workspace, '.env'), 'utf8')
  const scopeBefore = pool.broker.scope(profile)
  pool.workers.set(profile, { child })
  providers = [{ id: 'additional', name: '新增写作模型', baseUrl: 'https://secondary.invalid/v1', apiKey: 'secondary-private-fixture', models: ['second-model'], defaultModel: 'second-model', apiMode: 'responses', modelMetadata: { 'second-model': { context_length: 1048576, supported_efforts: ['low', 'high'], default_reasoning_effort: 'high' } } }]
  await pool.refreshModels()
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
  assert.equal(pool.workers.get(profile).child, child)
  const config = await readFile(path.join(workspace, 'config.yaml'), 'utf8')
  assert.ok(config.includes('second-model') && config.includes('codex_responses'))
  assert.deepEqual(pool.broker.scope(profile).providers[0].model_metadata, { 'second-model': { context_length: 1048576, supported_efforts: ['low', 'high'], default_reasoning_effort: 'high' } })
  assert.ok(config.includes('1048576') && config.includes('default_reasoning_effort: high') && config.includes('reasoning_overrides:'))
  assert.equal(await readFile(path.join(workspace, '.env'), 'utf8'), tokenBefore)
  assert.equal(pool.broker.scope(profile).base_url, scopeBefore.base_url)
  for (const privateValue of ['owner-private-fixture', 'secondary-private-fixture', 'original.invalid', 'secondary.invalid']) assert.ok(!config.includes(privateValue) && !tokenBefore.includes(privateValue))
})

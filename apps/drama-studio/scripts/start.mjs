import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import path from 'node:path'
import { matchesBackendHome, shouldStartBackend } from './backend-lifecycle.mjs'
import { runtimeToken } from '../server/runtime-credentials.mjs'
import { startStudioServer } from '../server/serve.mjs'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = path.resolve(appRoot, '../..')
const suppliedBackend = process.argv.indexOf('--backend')
const backend = suppliedBackend >= 0 ? process.argv[suppliedBackend + 1] : 'http://127.0.0.1:10620'
if (!backend) throw new Error('--backend 需要填写本地服务地址。')
const endpoint = new URL(backend)
if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('请使用本机创作服务地址。')

async function requireFreePort(port) {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', () => reject(new Error(`端口 ${port} 已在使用，请先关闭此前启动的剧本工作区。`)))
    probe.listen(port, '127.0.0.1', () => probe.close(resolve))
  })
}

await requireFreePort(10619)
const dataDir = process.env.SCRIPT_STUDIO_DATA_DIR || path.join(repoRoot, '.hermes/studio')
const backendToken = await runtimeToken(dataDir, { create: true })
const startBackend = suppliedBackend < 0 && await shouldStartBackend(backend, repoRoot, backendToken)
if (suppliedBackend < 0 && !startBackend) console.log('已识别当前工作区的创作服务，保留正在进行的创作并复用连接。')

console.log('正在准备剧本工作区…')
await new Promise((resolve, reject) => {
  const build = spawn('npm', ['run', 'build'], { cwd: appRoot, stdio: 'inherit' })
  build.once('error', reject)
  build.once('exit', code => code === 0 ? resolve() : reject(new Error('前端构建失败，请查看上方提示。')))
})

let backendProcess
let frontend
let exiting = false
const stop = async () => {
  if (exiting) return
  exiting = true
  await frontend?.close()
  backendProcess?.kill('SIGTERM')
}
process.once('SIGINT', () => void stop().then(() => process.exit(0)))
process.once('SIGTERM', () => void stop().then(() => process.exit(0)))

try {
  if (startBackend) {
    const logs = path.join(repoRoot, '.cache/drama-studio')
    await mkdir(logs, { recursive: true })
    const log = await open(path.join(logs, 'service.log'), 'a')
    backendProcess = spawn(path.join(repoRoot, 'scripts/run-in-hermes-env'), ['python', path.join(appRoot, 'server/runtime.py'), '--host', '127.0.0.1', '--port', '10620', '--isolated'], {
      cwd: repoRoot,
      env: { ...process.env, HERMES_DASHBOARD_SESSION_TOKEN: backendToken, HERMES_HOME: path.join(repoRoot, '.hermes'), HERMES_RUNTIME_DIR: path.join(repoRoot, '.hermes-runtime') },
      stdio: ['ignore', log.fd, log.fd]
    })
    backendProcess.once('error', error => { console.error(`创作服务启动失败：${error.message}`); void stop().then(() => process.exit(1)) })
    backendProcess.once('exit', () => { if (!exiting) { console.error('创作服务已退出，请查看 .cache/drama-studio/service.log。'); void stop().then(() => process.exit(1)) } })
    await log.close()
  }
  const deadline = Date.now() + 60_000
  let ready = false
  while (Date.now() < deadline && !exiting) {
    try {
      ready = await matchesBackendHome(backend, repoRoot, backendToken)
    } catch { ready = false }
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (!ready) throw new Error('创作服务未能就绪，请检查 .cache/drama-studio/service.log。')
  process.env.SCRIPT_STUDIO_BACKEND = backend
  process.env.SCRIPT_STUDIO_BACKEND_TOKEN = backendToken
  frontend = await startStudioServer({ repoRoot, appRoot, backend, backendToken, dataDir, host: '127.0.0.1', port: 10619 })
  console.log('\n巨豹智能体已就绪：http://localhost:10619/\n保持此窗口运行。按 Ctrl+C 可关闭本次启动的服务。')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  await stop()
  process.exit(1)
}

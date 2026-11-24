import { readFile, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startStudioServer } from '../server/serve.mjs'
import { WorkerPool } from '../server/worker-pool.mjs'
import { runtimeToken } from '../server/runtime-credentials.mjs'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = path.resolve(appRoot, '../..')
if (process.argv.length !== 4 || process.argv[2] !== '--config' || !path.isAbsolute(process.argv[3])) {
  throw new Error('请使用 --config 指定部署配置的绝对路径。')
}
const config = JSON.parse(await readFile(process.argv[3], 'utf8'))
if (!config || typeof config.hermesHome !== 'string' || !path.isAbsolute(config.hermesHome)
  || !config.nativeRuntime || !config.publicOrigin || !config.backend) throw new Error('部署配置不完整。')
const hermesHome = config.hermesHome
const identity = config.identity ? structuredClone(config.identity) : undefined
if (identity?.company) {
  const file = identity.company.secretFile
  if (typeof file !== 'string' || !path.isAbsolute(file) || 'secret' in identity.company) throw new Error('公司登录密钥必须从受保护文件读取。')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.mode & 0o077 || info.size > 4096) throw new Error('公司登录密钥文件权限或大小不正确。')
    identity.company.secret = (await handle.readFile('utf8')).trim()
  } finally { await handle.close() }
  delete identity.company.secretFile
}
const dataDir = path.join(hermesHome, 'studio')
const backendToken = await runtimeToken(dataDir, { create: true })
const workerPool = new WorkerPool({ repoRoot, hermesHome, nativeRuntime: config.nativeRuntime,
  linuxWorkerImage: config.linuxWorkerImage, ipcRoot: config.ipcRoot })
const service = await startStudioServer({ repoRoot, appRoot, hermesHome, dataDir, backendToken, workerPool,
  backend: config.backend, host: config.host, port: config.port, publicOrigin: config.publicOrigin,
  cookieName: config.cookieName, identity })
console.log(`巨豹智能体已启动：${config.publicOrigin}`)
let closing = false
const close = () => {
  if (closing) return
  closing = true
  void service.close().then(() => process.exit(0), () => process.exit(1))
}
process.once('SIGINT', close)
process.once('SIGTERM', close)

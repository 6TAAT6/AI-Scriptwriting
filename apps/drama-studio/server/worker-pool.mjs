import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, open, lstat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInferenceBroker } from './inference-broker.mjs'
import { profileProvisioner, inferenceRefresher } from './provision.mjs'
import { pythonInvocation, activePythonPath } from './python-runtime.mjs'
import { rememberModelOrigins } from './model-origins.mjs'

const exec = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const safeEnv = () => Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
const stopTree = (child, signal) => {
  if (!child.pid) return
  try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}

/** 每个非超级管理员使用独立进程树；无法建立隔离时不回退到共享后端。 */
export class WorkerPool {
  constructor({ repoRoot, hermesHome, settingsLoader, linuxWorkerImage, nativeRuntime, ipcRoot }) {
    this.repoRoot = path.resolve(repoRoot)
    this.home = hermesHome
    this.settingsLoader = settingsLoader
    this.linuxWorkerImage = linuxWorkerImage
    // 发布目录才是当前代码的权威来源。部署配置可能跨 release 保留，
    // 不能让旧 pythonPath 把 worker 的模块导入切回过期版本。
    this.nativeRuntime = nativeRuntime ? { ...nativeRuntime, pythonPath: activePythonPath(this.repoRoot) } : nativeRuntime
    if (ipcRoot !== undefined && (typeof ipcRoot !== 'string' || !path.isAbsolute(ipcRoot))) throw new Error('员工通信目录必须使用绝对路径。')
    this.ipcRoot = ipcRoot
    this.workers = new Map()
    this.pending = new Map()
    this.scopeOwners = new Map()
    this.generations = new Map()
    this.revoking = new Map()
    this.startingChildren = new Map()
    this.stopping = new WeakMap()
    this.initializing = null
    this.broker = null
    this.closed = false
    this.provision = profileProvisioner(repoRoot, hermesHome, async profile => {
      const generation = this.generations.get(profile) || 0
      await this.initialize()
      this.assertGeneration(profile, generation)
      return this.broker.scope(profile)
    }, nativeRuntime)
    this.refresh = inferenceRefresher(repoRoot, hermesHome, profile => {
      if (this.closed || this.revoking.has(profile)) throw new Error('账号工作进程已撤销。')
      return this.broker.scope(profile)
    }, nativeRuntime)
  }
  homeFor(user) {
    if (!/^studio-[a-f0-9]{20}$/.test(user.profile)) throw new Error('账号创作目录无效。')
    return path.join(this.home, 'studio-workers', user.profile)
  }
  async readSettings() {
    let settings
    try {
      if (this.settingsLoader) settings = await this.settingsLoader()
      else {
        const invocation = pythonInvocation(this.repoRoot, this.home, path.join(here, 'worker-settings.py'), [this.home, ...(this.nativeRuntime ? ['--native-runtime'] : [])], this.nativeRuntime)
        const result = await exec(invocation.command, invocation.args, {
          cwd: this.repoRoot, env: invocation.env, timeout: 120_000, maxBuffer: 1024 * 1024
        })
        settings = JSON.parse(result.stdout.trim().split('\n').at(-1))
      }
      // 仅保留来源用于正文脱敏；轮换前的地址仍可能出现在历史记录中。
      const origins = [settings, ...(settings.providers || [])].map(row => new URL(row.baseUrl).origin)
      const update = (this.originsUpdate ?? Promise.resolve()).catch(() => {}).then(async () => {
        // 展示元数据不可写时隐藏全部地址，不能阻断有效的创作模型配置。
        this.modelServiceOrigins = await rememberModelOrigins(this.home, origins).catch(() => null)
      })
      this.originsUpdate = update
      await update
      return settings
    } catch { throw new Error('无法读取员工创作模型连接。') }
  }
  refreshModels() {
    const pending = (this.modelRefresh ?? Promise.resolve()).catch(() => {}).then(async () => {
      await this.initialize()
      const settings = await this.readSettings()
      if (this.closed) throw new Error('创作服务已关闭。')
      this.broker.updateProviders(settings.providers || [], settings)
      settings.apiKey = ''
      for (const provider of settings.providers || []) provider.apiKey = ''
      await Promise.all([...new Set([...this.workers.keys(), ...this.pending.keys()])].filter(profile => !this.revoking.has(profile)).map(profile => this.refresh(profile)))
    })
    this.modelRefresh = pending
    return pending
  }
  async initialize() {
    if (this.closed) throw new Error('创作服务已关闭。')
    if (this.broker) return
    if (this.initializing) return this.initializing
    this.initializing = (async () => {
      if (!['darwin', 'linux'].includes(process.platform)) throw new Error('此主机尚未配置员工进程隔离。')
      if (process.platform === 'linux' && !/^(?:sha256:|[^\s]+@sha256:)[a-f0-9]{64}$/.test(this.linuxWorkerImage || '')) throw new Error('Linux 员工镜像必须配置固定 sha256 标识。')
      const settings = await this.readSettings()
      if (this.closed) throw new Error('创作服务已关闭。')
      this.runtime = this.nativeRuntime ?? { python: settings.python, pythonPath: settings.pythonPath, pythonPaths: settings.pythonPaths }
      let broker
      try {
        if (process.platform === 'linux') {
          this.ipcRoot ??= path.join(this.home, 'studio', 'worker-ipc')
          await mkdir(this.ipcRoot, { mode: 0o700, recursive: true })
          const info = await lstat(this.ipcRoot)
          if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('员工通信目录未安全配置。')
          this.brokerIPC = await mkdtemp(path.join(this.ipcRoot, 'b-'))
          settings.unixSocket = path.join(this.brokerIPC, 'broker.sock')
          // Linux sockaddr_un 的 108 字节包含结尾空字节，中文路径需按 UTF-8 计长。
          if (Buffer.byteLength(settings.unixSocket, 'utf8') >= 108) throw new Error('员工通信目录过长，请将 ipcRoot 配置为较短的绝对路径。')
        }
        broker = await createInferenceBroker(settings)
      } catch (error) {
        if (this.brokerIPC) await rm(this.brokerIPC, { recursive: true, force: true })
        throw error
      }
      settings.apiKey = ''
      for (const provider of settings.providers || []) provider.apiKey = ''
      if (this.closed) {
        await broker.close()
        if (this.brokerIPC) await rm(this.brokerIPC, { recursive: true, force: true })
        throw new Error('创作服务已关闭。')
      }
      this.broker = broker
    })().finally(() => { this.initializing = null })
    return this.initializing
  }
  async get(user) {
    if (this.closed) throw new Error('创作服务已关闭。')
    const home = this.homeFor(user)
    const generation = this.generations.get(user.profile) || 0
    const cleanup = this.revoking.get(user.profile)
    if (cleanup) await cleanup
    this.assertGeneration(user.profile, generation)
    const existing = this.workers.get(user.profile)
    if (existing) return existing
    if (this.pending.has(user.profile)) return this.pending.get(user.profile)
    const promise = this.start(user, home, generation).finally(() => { if (this.pending.get(user.profile) === promise) this.pending.delete(user.profile) })
    this.pending.set(user.profile, promise)
    return promise
  }
  assertGeneration(profile, generation) {
    if (this.closed) throw new Error('创作服务已关闭。')
    if ((this.generations.get(profile) || 0) !== generation) throw new Error('账号权限已撤销，请重新登录。')
  }
  stopChild(child) {
    if (!child) return Promise.resolve()
    if (this.stopping.has(child)) return this.stopping.get(child)
    const stopped = new Promise(resolve => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true; clearTimeout(timer); child.off('exit', finish); stopTree(child, 'SIGKILL'); resolve()
      }
      const timer = setTimeout(finish, 5000)
      if (child.exitCode !== null || child.signalCode !== null) { finish(); return }
      child.once('exit', finish)
      stopTree(child, 'SIGTERM')
    })
    this.stopping.set(child, stopped)
    return stopped
  }
  revoke(profile) {
    this.generations.set(profile, (this.generations.get(profile) || 0) + 1)
    this.scopeOwners.delete(profile)
    this.broker?.revoke(profile)
    const existing = this.revoking.get(profile)
    if (existing) return existing
    const worker = this.workers.get(profile)
    this.workers.delete(profile)
    const pending = this.pending.get(profile)
    const children = [...new Set([worker?.child, this.startingChildren.get(profile)].filter(Boolean))]
    const cleanup = (async () => {
      await Promise.allSettled([...(pending ? [pending] : []), ...children.map(child => this.stopChild(child))])
    })().finally(() => { if (this.revoking.get(profile) === cleanup) this.revoking.delete(profile) })
    this.revoking.set(profile, cleanup)
    return cleanup
  }
  async start(user, home, generation) {
    await this.initialize()
    this.assertGeneration(user.profile, generation)
    const scopeOwner = Symbol(user.profile)
    this.scopeOwners.set(user.profile, scopeOwner)
    const releaseScope = () => {
      if (this.scopeOwners.get(user.profile) !== scopeOwner) return
      this.scopeOwners.delete(user.profile)
      this.broker?.revoke(user.profile)
    }
    let log
    try {
      const directory = await lstat(home)
      this.assertGeneration(user.profile, generation)
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077) throw new Error('账号创作目录未安全配置。')
      await this.refresh(user.profile)
      this.assertGeneration(user.profile, generation)
      const logs = path.join(this.home, 'studio', 'worker-logs')
      await mkdir(logs, { mode: 0o700, recursive: true })
      this.assertGeneration(user.profile, generation)
      log = await open(path.join(logs, `${user.profile}.log`), 'a', 0o600)
      this.assertGeneration(user.profile, generation)
    } catch (error) { await log?.close(); releaseScope(); throw error }
    const token = randomBytes(32).toString('base64url')
    const child = spawn(this.runtime.python, [path.join(here, 'worker-launch.py')], {
      cwd: this.repoRoot, env: { ...safeEnv(), PYTHONPATH: this.runtime.pythonPath, PYTHONDONTWRITEBYTECODE: '1',
        ...(this.nativeRuntime ? { HERMES_HOME: this.home, HERMES_RUNTIME_DIR: this.nativeRuntime.runtimeDir, PYTHONNOUSERSITE: '1' } : {}) },
      stdio: ['pipe', 'pipe', log.fd], detached: true
    })
    this.startingChildren.set(user.profile, child)
    let ended = false, spawnError = false, worker
    child.once('error', () => { spawnError = true })
    child.once('exit', () => {
      ended = true
      if (worker && this.workers.get(user.profile) === worker) this.workers.delete(user.profile)
      if (this.startingChildren.get(user.profile) === child) this.startingChildren.delete(user.profile)
      releaseScope()
    })
    await log.close()
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ home, repoRoot: this.repoRoot, token, ...this.runtime,
      brokerPort: Number(new URL(this.broker.baseUrl).port), linuxWorkerImage: this.linuxWorkerImage,
      brokerSocket: this.broker.unixSocket, ipcRoot: this.ipcRoot }))
    let info
    try {
      this.assertGeneration(user.profile, generation)
      if (ended || spawnError) throw new Error('账号创作进程无法启动。')
      info = await new Promise((resolve, reject) => {
        let output = ''
        const timeout = setTimeout(() => { stopTree(child, 'SIGTERM'); reject(new Error('账号创作进程启动超时。')) }, 20_000)
        const done = value => { clearTimeout(timeout); resolve(value) }
        child.once('error', () => { clearTimeout(timeout); reject(new Error('账号创作进程无法启动。')) })
        child.once('exit', () => { clearTimeout(timeout); reject(new Error('账号创作进程未通过隔离检查。')) })
        child.stdout.on('data', chunk => {
          output += chunk.toString()
          if (output.length > 8192) { stopTree(child, 'SIGTERM'); clearTimeout(timeout); reject(new Error('账号创作进程响应无效。')); return }
          const line = output.split('\n')[0]
          if (!output.includes('\n')) return
          try { const value = JSON.parse(line); if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error(); done(value) }
          catch { clearTimeout(timeout); reject(new Error('账号创作进程响应无效。')) }
        })
      })
      const endpoint = new URL(`http://127.0.0.1:${info.port}`)
      const deadline = Date.now() + 60_000
      let ready = false
      while (Date.now() < deadline && !ended && !spawnError && !this.closed && (this.generations.get(user.profile) || 0) === generation) {
        try {
          const response = await fetch(endpoint, { headers: { 'X-Hermes-Session-Token': token }, signal: AbortSignal.timeout(1500), redirect: 'error' })
          ready = response.ok && (await response.json()).service === 'studio-runtime'
        } catch { ready = false }
        if (ready) break
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      this.assertGeneration(user.profile, generation)
      if (!ready || ended || spawnError || child.exitCode !== null || child.signalCode !== null || this.closed) throw new Error('账号创作进程未能就绪，请联系超级管理员。')
      worker = { endpoint, token, profile: 'default', home, child }
      if (this.startingChildren.get(user.profile) === child) this.startingChildren.delete(user.profile)
      this.workers.set(user.profile, worker)
      return worker
    } catch (error) { await this.stopChild(child); releaseScope(); throw error }
  }
  async close() {
    this.closed = true
    const profiles = new Set([...this.workers.keys(), ...this.pending.keys(), ...this.startingChildren.keys(), ...this.scopeOwners.keys()])
    const revocations = [...profiles].map(profile => this.revoke(profile))
    if (this.initializing) await Promise.allSettled([this.initializing])
    await Promise.allSettled([...revocations, ...this.revoking.values(), ...this.pending.values()])
    this.workers.clear()
    await this.broker?.close()
    if (this.brokerIPC) await rm(this.brokerIPC, { recursive: true, force: true })
  }
}

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pythonInvocation } from './python-runtime.mjs'

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export function safeCapabilities(value, models) {
  return Object.fromEntries(models.map(model => {
    const entry = value?.[model] ?? {}
    const levels = Array.isArray(entry.supported_efforts) ? entry.supported_efforts.filter(level => EFFORTS.has(level)) : []
    return [model, { reasoning: entry.reasoning === true && levels.length > 0, can_disable_reasoning: entry.can_disable_reasoning !== false, fast: entry.fast === true, supported_efforts: levels,
      ...(levels.includes(entry.default_reasoning_effort) ? { default_reasoning_effort: entry.default_reasoning_effort } : {}),
      ...(Number.isSafeInteger(entry.context_length) && entry.context_length > 0 ? { context_length: entry.context_length } : {}) }]
  }))
}

export async function enrichReasoning(catalog, home, repoRoot, nativeRuntime) {
  const invocation = pythonInvocation(repoRoot, home, path.join(repoRoot, 'apps/drama-studio/server/reasoning-catalog.py'), [home], nativeRuntime)
  if (!existsSync(invocation.command)) return catalog
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: repoRoot, env: nativeRuntime ? invocation.env : { ...process.env, ...invocation.env }, stdio: ['pipe', 'pipe', 'pipe']
    })
    let output = '', failed = false
    const timer = setTimeout(() => { failed = true; child.kill('SIGTERM'); reject(new Error('模型能力读取超时。')) }, 30_000)
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 2 * 1024 * 1024) { failed = true; child.kill('SIGTERM'); reject(new Error('模型目录过大。')) } })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.once('error', () => { clearTimeout(timer); reject(new Error('模型能力读取失败。')) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (failed) return
      try { if (code !== 0) throw new Error(); resolve(JSON.parse(output.trim().split('\n').at(-1))) }
      catch { reject(new Error('模型能力读取失败。')) }
    })
    child.stdin.end(JSON.stringify(catalog))
  })
}

export function supportedEfforts(catalog, info) {
  if (!catalog || !info) return []
  const provider = info.provider === 'custom' ? catalog.provider : info.provider || catalog.provider
  const rows = catalog.providers.filter(row => row.slug === provider || row.aliases?.includes(provider))
  const caps = rows.length === 1 ? rows[0].capabilities?.[info.model || catalog.model] : null
  return caps?.reasoning === true ? caps.supported_efforts || [] : []
}

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fail } from './accounts.mjs'
import { pythonInvocation } from './python-runtime.mjs'
function profileOperation(repoRoot, hermesHome, inferenceForProfile, refresh = false, nativeRuntime) {
  return async profile => {
    try {
      if (typeof inferenceForProfile !== 'function') fail(503, '安全创作服务尚未配置。')
      const inference = await inferenceForProfile(profile)
      const invocation = pythonInvocation(repoRoot, hermesHome, fileURLToPath(new URL('./profiles.py', import.meta.url)), [profile, ...(refresh ? ['--refresh'] : [])], nativeRuntime)
      const result = await new Promise((resolve, reject) => {
        const child = execFile(invocation.command, invocation.args, {
          cwd: repoRoot, env: invocation.env, timeout: 60_000, maxBuffer: 1024 * 1024
        }, (error, stdout) => error ? reject(error) : resolve(stdout))
        child.stdin.on('error', reject)
        child.stdin.end(JSON.stringify(inference))
      })
      return JSON.parse(result.trim().split('\n').at(-1))
    } catch { fail(503, '无法准备账号工作区，请稍后重试。') }
  }
}

export function profileProvisioner(repoRoot, hermesHome, inferenceForProfile, nativeRuntime) {
  return profileOperation(repoRoot, hermesHome, inferenceForProfile, false, nativeRuntime)
}

export function inferenceRefresher(repoRoot, hermesHome, inferenceForProfile, nativeRuntime) {
  return profileOperation(repoRoot, hermesHome, inferenceForProfile, true, nativeRuntime)
}

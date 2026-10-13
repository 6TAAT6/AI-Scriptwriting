import path from 'node:path'

export function activePythonPath(repoRoot) {
  return path.resolve(repoRoot)
}

/** 预装环境由启动配置指定，后台请求不负责安装或同步 Python 依赖。 */
export function pythonInvocation(repoRoot, home, script, args = [], nativeRuntime) {
  const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { HERMES_HOME: home, HERMES_RUNTIME_DIR: nativeRuntime?.runtimeDir ?? path.join(repoRoot, '.hermes-runtime') })
  if (!nativeRuntime) return { command: path.join(repoRoot, 'scripts/run-in-hermes-env'), args: ['python', script, ...args], env }
  if (![nativeRuntime.python, nativeRuntime.runtimeDir].every(value => typeof value === 'string' && path.isAbsolute(value)) ||
      typeof nativeRuntime.pythonPath !== 'string' || !nativeRuntime.pythonPath ||
      !Array.isArray(nativeRuntime.pythonPaths) || !nativeRuntime.pythonPaths.length ||
      !nativeRuntime.pythonPaths.every(value => typeof value === 'string' && path.isAbsolute(value))) {
    throw new Error('预装 Python 运行环境配置不完整。')
  }
  // 入口脚本和 worker 必须从同一冻结 release 导入代码；配置中的旧
  // pythonPath 可能在切换 current 时遗留，不能让它造成跨 release 混用。
  Object.assign(env, { PYTHONPATH: activePythonPath(repoRoot), PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' })
  return { command: nativeRuntime.python, args: [script, ...args], env }
}

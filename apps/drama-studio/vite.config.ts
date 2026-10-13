import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStudioEdge } from './server/index.mjs'
import { runtimeToken } from './server/runtime-credentials.mjs'
import { WorkerPool } from './server/worker-pool.mjs'
import { staticBoundary } from './server/static-boundary.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const backend = process.env.SCRIPT_STUDIO_BACKEND || 'http://127.0.0.1:10620'
const dataDir = process.env.SCRIPT_STUDIO_DATA_DIR || path.join(repoRoot, '.hermes/studio')

function accountRuntime(): Plugin {
  const install = async (server: Parameters<Awaited<ReturnType<typeof createStudioEdge>>['install']>[0]) => {
    const backendToken = process.env.SCRIPT_STUDIO_BACKEND_TOKEN || await runtimeToken(dataDir)
    const workerPool = new WorkerPool({ repoRoot, hermesHome: path.join(repoRoot, '.hermes') })
    const edge = await createStudioEdge({ backend, dataDir, repoRoot, backendToken, workerPool })
    edge.install(server)
    server.httpServer?.once('close', () => { void edge.close() })
  }
  return { name: 'script-studio-accounts', configureServer: install, configurePreviewServer: async server => {
    server.middlewares.use(staticBoundary)
    await install(server)
  } }
}

export default defineConfig({
  plugins: [react(), accountRuntime()],
  server: {
    host: '127.0.0.1',
    // 开发服务器的源码访问也不能绕开人员系统读取运行态资料。
    fs: { deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '**/.hermes/**', '**/.hermes-runtime/**', '**/.cache/**', `${dataDir}/**`] }
  },
  preview: { host: '127.0.0.1' },
  build: { sourcemap: false, chunkSizeWarningLimit: 750 }
})

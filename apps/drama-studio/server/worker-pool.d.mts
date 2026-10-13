export interface NativeRuntime {
  python: string
  pythonPath: string
  pythonPaths: string[]
  runtimeDir: string
}
export class WorkerPool {
  constructor(options: { repoRoot: string; hermesHome: string; linuxWorkerImage?: string; nativeRuntime?: NativeRuntime; ipcRoot?: string })
  nativeRuntime?: NativeRuntime
  provision(profile: string): Promise<unknown>
  refreshModels(): Promise<void>
  close(): Promise<void>
}

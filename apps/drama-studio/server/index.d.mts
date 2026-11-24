import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EventEmitter } from 'node:events'

export interface StudioUser {
  id: string
  username: string
  display_name: string
  role: 'super_admin' | 'admin' | 'employee'
  enabled: boolean
  profile: string
  created_at: string
  updated_at: string
  last_login_at: string | null
  organization?: 'hangzhou' | 'chongqing' | 'unassigned'
  auth_source?: 'local' | 'company'
}
export interface StudioEdge {
  store: { listUsers(): StudioUser[]; user(id: string): StudioUser | null }
  seedRoot(password: string): Promise<StudioUser>
  install(server: {
    middlewares: { use(handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void): unknown }
    httpServer?: EventEmitter | null
  }): void
  close(): Promise<void>
}
export function createStudioEdge(options: {
  backend: string
  backendToken?: string
  workerPool?: { provision(profile: string): Promise<unknown>; revoke?(profile: string): Promise<void>; close(): Promise<void> }
  dataDir: string
  repoRoot: string
  hermesHome?: string
  publicOrigin?: string
  cookieName?: string
  identity?: { enabled: boolean; company?: { serverUrl: string; callbackUrl: string; appId: string; secret: string } }
  provisionProfile?: (profile: string) => Promise<unknown>
}): Promise<StudioEdge>

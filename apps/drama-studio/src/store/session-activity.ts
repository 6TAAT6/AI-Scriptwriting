import { atom, computed } from 'nanostores'
import type { StudioEvent } from '../lib/transcript'

interface ActivityRecord { storedId: string; running: boolean; revision: number }
interface ActiveRow { id: string; session_key: string; status: string }
interface SnapshotTicket { epoch: number; revision: number; request: number }
const ACTIVE = new Set(['starting', 'waiting', 'working', 'streaming', 'resuming'])

/** 运行态按真实会话身份保存，切换聊天不清除；迟到快照不能覆盖更新的事件。 */
export class SessionActivity {
  private readonly records = atom<Record<string, ActivityRecord>>({})
  readonly running = computed(this.records, records => new Set(Object.values(records).filter(row => row.running && row.storedId).map(row => row.storedId)))
  readonly unread = atom<Set<string>>(new Set())
  private storageKey = ''
  private revision = 0
  private epoch = 0
  private request = 0

  scope(profile: string) {
    const key = profile ? `drama-studio:${profile}:unread-v1` : ''
    if (key === this.storageKey) return
    this.storageKey = key
    let ids: unknown = []
    try { ids = key ? JSON.parse(localStorage.getItem(key) || '[]') : [] } catch { /* 损坏的本地标记不影响会话读取。 */ }
    this.unread.set(new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(-1000) : []))
  }
  private saveUnread(ids: Set<string>) {
    this.unread.set(ids)
    try { if (this.storageKey) localStorage.setItem(this.storageKey, JSON.stringify([...ids].slice(-1000))) } catch { /* 浏览器存储不可写时本页仍可记录已读。 */ }
  }
  markRead(storedId: string) {
    if (!this.unread.get().has(storedId)) return
    const next = new Set(this.unread.get()); next.delete(storedId); this.saveUnread(next)
  }
  reset() { this.epoch++; this.request++; this.records.set({}); this.storageKey = ''; this.unread.set(new Set()) }
  forget(storedId: string) {
    this.markRead(storedId)
    this.records.set(Object.fromEntries(Object.entries(this.records.get()).filter(([, row]) => row.storedId !== storedId)))
  }
  bind(runtimeId: string, storedId: string, running: boolean) {
    if (!runtimeId || !storedId) return
    this.records.set({ ...this.records.get(), [runtimeId]: { storedId, running, revision: ++this.revision } })
  }
  observe(event: StudioEvent, selected?: { runtimeId: string; storedId: string }, viewed = true, asyncPending = 0) {
    if (!event.session_id) return
    const running = event.type === 'message.start' || event.type.startsWith('subagent.') && event.type !== 'subagent.complete' ? true
      : event.type === 'message.complete' && asyncPending > 0 ? true
      : ['message.complete', 'error'].includes(event.type) ? false
      : event.type === 'session.info' && typeof event.payload.running === 'boolean' ? event.payload.running : undefined
    if (running === undefined) return
    const old = this.records.get()[event.session_id]
    const storedId = old?.storedId || (selected?.runtimeId === event.session_id ? selected.storedId : '')
    this.records.set({ ...this.records.get(), [event.session_id]: { storedId, running, revision: ++this.revision } })
    if (event.type === 'message.complete' && event.payload.status === 'complete' && !event.replayed && storedId) {
      if (viewed && selected?.storedId === storedId) this.markRead(storedId)
      else this.saveUnread(new Set([...this.unread.get(), storedId]))
    }
  }
  ticket(): SnapshotTicket { return { epoch: this.epoch, revision: this.revision, request: ++this.request } }
  reconcile(rows: ActiveRow[], ticket: SnapshotTicket) {
    if (ticket.epoch !== this.epoch || ticket.request !== this.request) return
    const current = this.records.get(), next: Record<string, ActivityRecord> = {}
    for (const [id, row] of Object.entries(current)) next[id] = row.revision > ticket.revision ? row : { ...row, running: false, revision: ticket.revision }
    for (const row of rows) {
      if (typeof row.id !== 'string' || !row.id || typeof row.session_key !== 'string' || !row.session_key || !['idle', ...ACTIVE].includes(row.status)) continue
      const newer = current[row.id]?.revision > ticket.revision ? current[row.id] : undefined
      next[row.id] = newer ? { ...newer, storedId: row.session_key } : { storedId: row.session_key, running: ACTIVE.has(row.status), revision: ticket.revision }
    }
    this.records.set(next)
  }
}

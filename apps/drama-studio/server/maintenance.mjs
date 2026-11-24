/** 运维账号通过私有原子文件发布维护状态，网页不提供写入接口。 */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { fail } from './accounts.mjs'

const fields = ['phase', 'version', 'message', 'id', 'deadline']
const inactive = () => ({ phase: 'inactive', version: '', message: '', id: '', deadline: null })
const invalid = () => { throw new Error('维护状态文件无效。') }

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))
    || !['inactive', 'announced', 'paused'].includes(value.phase)) invalid()
  for (const [key, limit] of [['version', 64], ['id', 128], ['message', 2000]]) {
    if (typeof value[key] !== 'string' || value[key].length > limit
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value[key])) invalid()
  }
  if (value.id && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.id)) invalid()
  if (value.phase !== 'inactive' && (!value.id || !value.version.trim() || !value.message.trim())) invalid()
  let deadline = null
  if (value.deadline !== null) {
    if (typeof value.deadline !== 'string' || value.deadline.length > 40
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.deadline)
      || !Number.isFinite(Date.parse(value.deadline))) invalid()
    deadline = new Date(value.deadline).toISOString()
  }
  return { phase: value.phase, version: value.version, message: value.message, id: value.id, deadline }
}

async function readState(file) {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()
      || info.nlink !== 1 || info.size > 8192) invalid()
    const bytes = Buffer.alloc(8193)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 8192) invalid()
    return validate(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')))
  } catch (error) {
    // 删除是明确解除状态；格式、权限或读取失败不清除进程内最后有效公告。
    if (error.code === 'ENOENT') return inactive()
    throw error
  } finally { await handle?.close() }
}

export async function createMaintenance({ dataDir, store }) {
  const file = path.join(dataDir, 'maintenance.json')
  const listeners = new Set()
  let current = inactive(), published = JSON.stringify(current), revokedId = null
  let queue = Promise.resolve(), stopped = false, warned = false
  const snapshot = () => ({ ...current })
  const refresh = () => {
    const pending = queue.catch(() => {}).then(async () => {
      if (stopped) return snapshot()
      let next
      try { next = await readState(file) }
      catch {
        if (!warned) { console.error('维护状态文件读取失败，保留最后有效状态。'); warned = true }
        return snapshot()
      }
      warned = false
      current = next
      if (current.phase === 'inactive') revokedId = null
      // 公告即置门禁；全局注销只清登录，后台任务由独立运维保存。
      if (current.phase !== 'inactive' && revokedId !== current.id) {
        try { await store.revoke(null); revokedId = current.id }
        catch { console.error('维护登录撤销未完成，将再次尝试。'); return snapshot() }
      }
      const encoded = JSON.stringify(current)
      if (encoded !== published) {
        published = encoded
        for (const listener of listeners) listener(snapshot())
      }
      return snapshot()
    })
    queue = pending
    return pending
  }
  await refresh()
  const timer = setInterval(() => { void refresh().catch(() => { console.error('维护状态更新未完成。') }) }, 2000)
  timer.unref()
  return {
    snapshot, refresh,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    assertLogin() { if (current.phase !== 'inactive') fail(503, '系统维护中，请稍后重新登录。') },
    assertPrompt(frame) {
      if (current.phase !== 'inactive' && frame?.method === 'prompt.submit') fail(503, '系统维护中，暂不接受新的创作，请保存草稿并稍后继续。')
    },
    async close() { stopped = true; clearInterval(timer); await queue; listeners.clear() }
  }
}

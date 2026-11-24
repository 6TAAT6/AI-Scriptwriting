import { $currentUser } from '../accounts/api'
import { gateway } from '../lib/gateway'
import { $updateAvailable, checkWorkspaceUpdate } from '../lib/workspace-update'
import { connectWorkspace, workspace } from './workspace'
import { loadEmployeeConversations, resetEmployeeConversations } from '../employee-access/api'

let stop = () => {}

export function stopWorkspaceSync() { stop(); stop = () => {}; $updateAvailable.set(false) }

export function startWorkspaceSync() {
  stopWorkspaceSync()
  let disposed = false, syncing = false, reloading = false
  let lastModels = Date.now(), lastVersion = 0
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined
  const active = () => !disposed && Boolean($currentUser.get())
  const employeeAccess = () => $currentUser.get()?.role !== 'employee'
  const syncEmployeeConversations = async () => {
    if (!employeeAccess()) return
    try { await loadEmployeeConversations() } catch { /* 员工查看区在下次同步时重试，不影响当前创作。 */ }
  }
  const recover = () => {
    if (!active()) return
    clearTimeout(recoveryTimer)
    if (workspace.composer.get().busy || workspace.navigation.get().loading) {
      recoveryTimer = setTimeout(recover, 1000)
      return
    }
    void connectWorkspace().then(syncEmployeeConversations)
  }
  const synchronize = async (restore = false, models = false) => {
    if (!active() || document.visibilityState === 'hidden' || syncing || reloading) return
    if (gateway.connectionState !== 'open') { recover(); return }
    if (workspace.preparing.get() || workspace.navigation.get().loading || workspace.composer.get().busy) return
    syncing = true
    try {
      const refreshModels = models || Date.now() - lastModels >= 60_000
      if (refreshModels) lastModels = Date.now()
      await workspace.synchronize({ models: refreshModels, restore })
      await syncEmployeeConversations()
      if (active() && ($updateAvailable.get() || Date.now() - lastVersion >= 60_000)) {
        lastVersion = Date.now()
        if (await checkWorkspaceUpdate() && active()) { reloading = true; window.location.reload() }
      }
    } catch { /* 下次可见页面校准或恢复连接时再次读取，保留当前画面和草稿。 */ }
    finally { syncing = false }
  }
  const wake = () => { if (document.visibilityState !== 'hidden') void synchronize(true, true) }
  // 目录下架在生成过程中也要及时可见，只刷新目录，不恢复历史或切换当前模型。
  const modelsChanged = () => { if (active() && gateway.connectionState === 'open') void workspace.refreshModels() }
  const unsubscribeModels = gateway.onAny(event => { if ((event.type as string) === 'studio.models.changed') modelsChanged() })
  const poll = setInterval(() => { void synchronize() }, 20_000)
  window.addEventListener('focus', wake)
  window.addEventListener('online', wake)
  window.addEventListener('studio:reconnected', recover)
  window.addEventListener('studio:models-changed', modelsChanged)
  document.addEventListener('visibilitychange', wake)
  stop = () => {
    disposed = true; clearInterval(poll); clearTimeout(recoveryTimer)
    unsubscribeModels()
    window.removeEventListener('focus', wake)
    window.removeEventListener('online', wake)
    window.removeEventListener('studio:reconnected', recover)
    window.removeEventListener('studio:models-changed', modelsChanged)
    document.removeEventListener('visibilitychange', wake)
    resetEmployeeConversations()
  }
  recover()
}

import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { disconnectWorkspace } from './store/workspace'
import { startWorkspaceSync, stopWorkspaceSync } from './store/workspace-sync'
import { AuthGate } from './accounts/AuthGate'
import { gateway } from './lib/gateway'
import { applySkin, introduceYaoye } from './lib/skins'
import markGradient from './assets/jubao-mark-dark.png?inline'
import { MaintenanceGate } from './maintenance/MaintenanceGate'
import './styles.css'
import './motion.css'
import './skins.css'
import './skin-yaoye.css'

class WorkspaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <div className="boot-error"><h1>工作区暂时无法显示</h1><p>已保存的创作记录仍在，可以刷新后继续。</p><button onClick={() => location.reload()}>重新打开工作区</button></div> : this.props.children }
}

const root = createRoot(document.getElementById('root')!)
introduceYaoye()
// V2.6 起默认浅色主题；只有本浏览器明确选过暗色才用暗色。
document.documentElement.dataset.theme = localStorage.getItem('drama-studio:theme') === 'dark' ? 'dark' : 'light'
// 皮肤选择已下线，统一使用曜夜；明暗主题仍可在侧栏切换。
applySkin('yaoye')
// 曜夜暗色标识（渐变线框）以内联数据提供给样式使用：测试版静态边界不放行单独的图片文件。
document.documentElement.style.setProperty('--yy-mark-dark', `url("${markGradient}")`)
function disconnected() { stopWorkspaceSync(); disconnectWorkspace() }
function authenticated() { disconnected(); startWorkspaceSync() }
root.render(<WorkspaceBoundary><MaintenanceGate><AuthGate onAuthenticated={authenticated} onLogout={disconnected}><App /></AuthGate></MaintenanceGate></WorkspaceBoundary>)
if (import.meta.hot) import.meta.hot.dispose(() => { stopWorkspaceSync(); root.unmount(); gateway.stop() })

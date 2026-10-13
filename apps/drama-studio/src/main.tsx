import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { disconnectWorkspace } from './store/workspace'
import { startWorkspaceSync, stopWorkspaceSync } from './store/workspace-sync'
import { AuthGate } from './accounts/AuthGate'
import { gateway } from './lib/gateway'
import './styles.css'
import './motion.css'

class WorkspaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <div className="boot-error"><h1>工作区暂时无法显示</h1><p>已保存的创作记录仍在，可以刷新后继续。</p><button onClick={() => location.reload()}>重新打开工作区</button></div> : this.props.children }
}

const root = createRoot(document.getElementById('root')!)
document.documentElement.dataset.theme = localStorage.getItem('drama-studio:theme') === 'dark' ? 'dark' : 'light'
function disconnected() { stopWorkspaceSync(); disconnectWorkspace() }
function authenticated() { disconnected(); startWorkspaceSync() }
root.render(<WorkspaceBoundary><AuthGate onAuthenticated={authenticated} onLogout={disconnected}><App /></AuthGate></WorkspaceBoundary>)
if (import.meta.hot) import.meta.hot.dispose(() => { stopWorkspaceSync(); root.unmount(); gateway.stop() })

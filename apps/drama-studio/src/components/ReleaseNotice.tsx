import { useState } from 'react'

const noticeKey = 'drama-studio:release-notice:20261010-reliability-r1'
const noticeUntil = Date.parse('2026-10-12T00:00:00+08:00')

export function ReleaseNotice() {
  const [visible, setVisible] = useState(() => Date.now() < noticeUntil && !localStorage.getItem(noticeKey))
  const dismiss = () => { localStorage.setItem(noticeKey, 'read'); setVisible(false) }
  if (!visible) return null
  return <div className="update-banner" role="note" aria-label="工具更新提示">
    <strong>工具已更新，请刷新页面后继续使用。</strong>
    <div>若刚才的生成被中断，请打开原对话检查已保存内容，再发送“继续”。刷新前请先保留输入框中尚未发送的内容。</div>
    <button className="text-button" onClick={() => { dismiss(); window.location.reload() }}>刷新页面</button>
    <button className="text-button" onClick={dismiss}>知道了</button>
  </div>
}

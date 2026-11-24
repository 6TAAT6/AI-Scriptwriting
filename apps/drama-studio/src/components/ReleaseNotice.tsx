import { useState } from 'react'

const noticeKey = 'drama-studio:release-notice:20261120-v2.6.4'
const noticeUntil = Date.parse('2026-11-28T00:00:00+08:00')

export function ReleaseNotice() {
  const [visible, setVisible] = useState(() => Date.now() < noticeUntil && !localStorage.getItem(noticeKey))
  const dismiss = () => { localStorage.setItem(noticeKey, 'read'); setVisible(false) }
  if (!visible) return null
  return <div className="update-banner" role="note" aria-label="工具更新提示">
    <ol>
      <li>新增 小说 Agent V1.0：通用中文小说创作，短篇长篇从构思到逐章成稿。</li>
    </ol>
    <button className="text-button" onClick={dismiss}>知道了</button>
  </div>
}

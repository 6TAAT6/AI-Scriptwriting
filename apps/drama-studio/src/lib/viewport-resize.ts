/**
 * 窗口尺寸变化期间暂停面板宽度过渡。跨过手机/桌面断点时，收起的侧栏和资料面板会从抽屉宽度（资料面板最宽整屏）
 * 回落到 0，过渡期间仍占文档流，中间栏会被挤到 0 宽、文字竖排。尺寸稳定后恢复，只保留用户主动开关面板时的动画。
 * resize 事件在浏览器重算样式之前派发，所以同步加上的类能让这一帧的宽度变化不起过渡。
 */
export function trackViewportResize(root: HTMLElement = document.documentElement, settleMs = 200) {
  let timer = 0
  const resize = () => {
    root.classList.add('viewport-resizing')
    window.clearTimeout(timer)
    timer = window.setTimeout(() => root.classList.remove('viewport-resizing'), settleMs)
  }
  window.addEventListener('resize', resize)
  return () => {
    window.removeEventListener('resize', resize)
    window.clearTimeout(timer)
    root.classList.remove('viewport-resizing')
  }
}

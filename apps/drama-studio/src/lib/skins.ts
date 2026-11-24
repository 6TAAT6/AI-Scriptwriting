// 测试版皮肤对比：只换颜色、字体、圆角与动效节奏；选择保存在本浏览器，和明暗主题互相独立。
export type SkinId = 'default' | 'yaoye' | 'paper' | 'studio' | 'clear'

export interface Skin { id: SkinId; name: string; description: string; swatches: string[] }

export const SKINS: Skin[] = [
  { id: 'yaoye', name: '曜夜', description: '玻璃质感与输入框光带，默认浅色，暗色主题同样适配', swatches: ['#16181e', '#8c9bff', '#3cc9b0'] },
  { id: 'default', name: '经典', description: '浅紫与青绿，原有样式', swatches: ['#f8f7fb', '#7655d8', '#248c80'] },
  { id: 'paper', name: '稿纸', description: '暖白纸色、朱批红、宋体正文，动效舒缓', swatches: ['#f5f0e6', '#a8402a', '#3d7357'] },
  { id: 'studio', name: '片场', description: '冷灰焦橙，深色下黑底金字；利落圆角、等宽场次', swatches: ['#18181b', '#c2410c', '#fbbf24'] },
  { id: 'clear', name: '清透', description: '冷白湛蓝，大圆角、柔和阴影，悬停轻微回弹', swatches: ['#f4f7fb', '#2563eb', '#0e7c74'] },
]

const STORAGE_KEY = 'drama-studio:skin'
const YAOYE_INTRO_KEY = 'drama-studio:yaoye-intro'

/** 没有保存过皮肤时用曜夜；保存的是已下架或未知的皮肤时回到经典样式。 */
export function storedSkin(): SkinId {
  const value = localStorage.getItem(STORAGE_KEY)
  if (value === null) return 'yaoye'
  return SKINS.find(skin => skin.id === value)?.id ?? 'default'
}

/** 曜夜上线后本浏览器第一次打开：切到曜夜一次；明暗主题不改（V2.6 起默认浅色），之后完全按本浏览器里的选择。 */
export function introduceYaoye(storage: Storage = localStorage) {
  try {
    if (storage.getItem(YAOYE_INTRO_KEY)) return
    storage.setItem(STORAGE_KEY, 'yaoye')
    storage.setItem(YAOYE_INTRO_KEY, '1')
  } catch { /* 本地存储不可用时沿用默认：曜夜浅色。 */ }
}

export function applySkin(id: SkinId, root: HTMLElement = document.documentElement) {
  if (id === 'default') delete root.dataset.skin
  else root.dataset.skin = id
}

/** 支持视图过渡的浏览器整页交叉淡化；减少动态效果时直接切换。 */
export function switchSkin(id: SkinId) {
  const apply = () => { applySkin(id); localStorage.setItem(STORAGE_KEY, id) }
  if (typeof document.startViewTransition === 'function' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(apply)
  else apply()
}

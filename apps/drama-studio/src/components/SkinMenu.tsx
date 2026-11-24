import { Check, Palette } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SKINS, storedSkin, switchSkin, type SkinId } from '../lib/skins'

/** 侧栏底部的皮肤选择；只影响本浏览器的显示，不写入账号或创作资料。 */
export function SkinMenu() {
  const [open, setOpen] = useState(false)
  const [skin, setSkin] = useState<SkinId>(storedSkin)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  const choose = (id: SkinId) => { setSkin(id); switchSkin(id); setOpen(false) }
  return <div className="skin-menu" ref={root}>
    <button type="button" className="icon-button sidebar-skin" aria-label="切换皮肤" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><Palette size={16} /></button>
    {open && <div className="skin-menu-panel" role="menu" aria-label="皮肤">
      <p className="skin-menu-heading">皮肤（仅本浏览器）</p>
      {SKINS.map(row => <button key={row.id} type="button" role="menuitemradio" aria-checked={row.id === skin} className={row.id === skin ? 'is-active' : ''} onClick={() => choose(row.id)}>
        <span className="skin-swatches" aria-hidden="true">{row.swatches.map(color => <i key={color} style={{ background: color }} />)}</span>
        <span className="skin-copy"><strong>{row.name}</strong><small>{row.description}</small></span>
        {row.id === skin && <Check size={14} aria-hidden="true" />}
      </button>)}
    </div>}
  </div>
}

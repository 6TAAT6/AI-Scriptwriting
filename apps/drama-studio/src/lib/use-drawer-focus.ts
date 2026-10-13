import { useEffect } from 'react'

export function useDrawerFocus(selector: string, active: boolean) {
  useEffect(() => {
    if (!active) return
    const drawer = document.querySelector<HTMLElement>(selector)
    if (!drawer) return
    const previous = document.activeElement as HTMLElement | null
    const focusable = () => Array.from(drawer.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], summary, [tabindex="0"]'))
      .filter(element => !element.hasAttribute('disabled') && element.getClientRects().length > 0)
    focusable()[0]?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
        event.preventDefault(); last?.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))) {
        event.preventDefault(); first?.focus()
      }
    }
    document.addEventListener('keydown', trap)
    return () => { document.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus() }
  }, [selector, active])
}

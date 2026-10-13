import { atom } from 'nanostores'
import { workspace } from '../store/workspace'

export const $updateAvailable = atom(false)

function applicationAsset(page: Document): string | null {
  const source = page.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src')
  if (!source) return null
  const url = new URL(source, window.location.href)
  return url.origin === window.location.origin && /^\/assets\/index-[\w-]+\.js$/.test(url.pathname) ? url.pathname : null
}

export async function checkWorkspaceUpdate(): Promise<boolean> {
  const current = applicationAsset(document), epoch = workspace.accountEpoch
  if (!current) return false
  try {
    const response = await fetch('/', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(5000) })
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return false
    const latest = applicationAsset(new DOMParser().parseFromString(await response.text(), 'text/html'))
    if (epoch !== workspace.accountEpoch || !latest) return false
    $updateAvailable.set(latest !== current)
    const focused = document.activeElement
    const editing = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || focused?.getAttribute('contenteditable') === 'true'
    const openControl = [...document.querySelectorAll('dialog[open], [role="listbox"], [role="menu"]')]
      .some(element => !element.closest('[hidden], [inert], [aria-hidden="true"]'))
    return latest !== current && workspace.canAutoUpdate && !editing && !openControl
  } catch { return false }
}

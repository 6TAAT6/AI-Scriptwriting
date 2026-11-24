export async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return }
  } catch { /* embedded/HTTP contexts may deny Clipboard API */ }
  const textarea = document.createElement('textarea')
  textarea.value = text; textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'; textarea.style.opacity = '0'; textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea); textarea.focus(); textarea.select(); textarea.setSelectionRange(0, textarea.value.length)
  const copied = document.execCommand?.('copy') === true
  textarea.remove()
  if (!copied) throw new Error('无法复制')
}

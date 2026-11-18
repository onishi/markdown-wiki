/**
 * Copy text; the button (if given) shows 「コピーしました」 for a moment through
 * `data-state` (CSS), so React's own content of the button is never touched.
 */
export async function copyText(text: string, button?: HTMLElement): Promise<boolean> {
  let ok = true
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    ok = legacyCopy(text)
  }
  if (button) {
    button.dataset.state = ok ? 'ok' : 'ng'
    clearTimeout(Number(button.dataset.timer))
    button.dataset.timer = String(setTimeout(() => delete button.dataset.state, 1400))
  }
  return ok
}

/** Fallback when the Clipboard API is refused: copy through a hidden textarea. */
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  document.body.appendChild(ta)
  const prev = document.activeElement as HTMLElement | null
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  prev?.focus?.({ preventScroll: true })
  return ok
}

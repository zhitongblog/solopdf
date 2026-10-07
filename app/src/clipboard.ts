/**
 * Plain-text copy with a fallback: the async Clipboard API is missing or
 * permission-gated in some webviews (and in a backgrounded tab), where the
 * old execCommand path still works from a click handler.
 */
export const clipboardLog = { last: '' }

export async function copyText(text: string): Promise<boolean> {
  clipboardLog.last = text
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    ta.remove()
    return ok
  }
}

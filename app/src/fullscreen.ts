/**
 * Window-level full screen, one call for every shell we ship in:
 *
 *   desktop Tauri  → the real native window full screen (setFullscreen)
 *   web / dev      → the Fullscreen API on <html>
 *   phones         → nothing: the app already owns the whole screen, and the
 *                    "immersive" part (hiding our own chrome, painting the
 *                    safe areas) is done by the caller in CSS — see the
 *                    WKWebView notes in BookView/styles.css
 *
 * The window can also leave full screen without us (browser Esc, the macOS
 * green button, a three-finger swipe); watchFullscreenExit reports that so the
 * reading/presentation mode it belonged to can end with it.
 */
import { isMobile, isTauri } from './platform'

/** we asked for full screen and haven't asked to leave */
let wanted = false
/** native full screen was actually observed since we asked (macOS animates
 *  for ~0.7s: resize events during the transition still read "not full") */
let seenFull = false

async function tauriWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

export async function setWindowFullscreen(on: boolean): Promise<void> {
  wanted = on
  seenFull = false
  if (isTauri()) {
    if (isMobile()) return
    try {
      const w = await tauriWindow()
      const full = await w.isFullscreen()
      if (full === on) seenFull = on // already there: no resize is coming
      else await w.setFullscreen(on)
    } catch { /* capability missing / platform refuses — in-app mode still works */ }
    return
  }
  try {
    if (on) {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.()
    } else if (document.fullscreenElement) {
      await document.exitFullscreen()
    }
  } catch { /* needs a user gesture / not allowed in this frame — stay in-app */ }
}

/** is the window (not just our chrome) currently full screen? */
export async function windowIsFullscreen(): Promise<boolean> {
  if (isTauri()) {
    if (isMobile()) return false
    try { return await (await tauriWindow()).isFullscreen() } catch { return false }
  }
  return !!document.fullscreenElement
}

/** call `cb` when the window leaves full screen by some other route */
export function watchFullscreenExit(cb: () => void): () => void {
  if (isTauri()) {
    if (isMobile()) return () => {}
    const onResize = (): void => {
      if (!wanted) return
      void windowIsFullscreen().then((full) => {
        if (full) seenFull = true
        else if (seenFull && wanted) {
          wanted = false
          seenFull = false
          cb()
        }
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }
  const onChange = (): void => {
    if (document.fullscreenElement) return
    if (wanted) {
      wanted = false
      cb()
    }
  }
  document.addEventListener('fullscreenchange', onChange)
  return () => document.removeEventListener('fullscreenchange', onChange)
}

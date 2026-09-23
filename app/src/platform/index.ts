import type { PlatformBackend } from './types'
import { TauriBackend } from './tauri'
import { WebBackend } from './web'

export * from './types'

export function isMobile(): boolean {
  return /iPhone|iPad|Android/i.test(navigator.userAgent)
}

export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window
}

/**
 * Open a web link in the SYSTEM browser. The webview itself must never
 * navigate away — that would unload the reader and every open tab.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } else {
    window.open(url, '_blank', 'noopener')
  }
}

/**
 * macOS draws its traffic lights on top of the window content (the window is
 * configured titleBarStyle: Overlay + hiddenTitle), so the tab bar has to leave
 * room for them. Nothing sits there on Windows or Linux — the same spacer is
 * just a 70px hole at the top-left of the title bar, which is what it was until
 * this gate existed.
 */
export function isMacDesktop(): boolean {
  return isTauri() && !isMobile() && /Macintosh|Mac OS X/i.test(navigator.userAgent)
}

let backend: PlatformBackend | null = null

export function platform(): PlatformBackend {
  if (!backend) backend = isTauri() ? new TauriBackend() : new WebBackend()
  return backend
}

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

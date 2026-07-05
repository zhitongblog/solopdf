import type { PlatformBackend } from './types'
import { TauriBackend } from './tauri'
import { WebBackend } from './web'

export * from './types'

export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window
}

let backend: PlatformBackend | null = null

export function platform(): PlatformBackend {
  if (!backend) backend = isTauri() ? new TauriBackend() : new WebBackend()
  return backend
}

/**
 * Keep the screen awake while reading.
 *
 * Screen Wake Lock is available in every webview we ship on (WKWebView 16.4+,
 * WebView2, recent webkit2gtk); where it isn't, the request throws and we stay
 * silent — a reader that can't hold the backlight is still a reader.
 *
 * The lock is released by the system whenever the page is hidden, so we
 * re-acquire on visibilitychange rather than assuming ours survived.
 */

type WakeLockSentinel = { released: boolean; release(): Promise<void> }

let sentinel: WakeLockSentinel | null = null
let wanted = false

function api(): { request(type: 'screen'): Promise<WakeLockSentinel> } | undefined {
  return (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<WakeLockSentinel> } }).wakeLock
}

export function wakeLockSupported(): boolean {
  return !!api()
}

async function acquire(): Promise<void> {
  if (!wanted || sentinel || document.visibilityState !== 'visible') return
  try {
    sentinel = (await api()?.request('screen')) ?? null
  } catch {
    sentinel = null // denied (battery saver, unsupported) — not an error we surface
  }
}

/** Turn the lock on or off. Idempotent; safe to call on every settings change. */
export function setKeepAwake(on: boolean): void {
  wanted = on
  if (on) {
    void acquire()
  } else if (sentinel) {
    void sentinel.release().catch(() => {})
    sentinel = null
  }
}

export function initWakeLock(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sentinel = null // the system dropped it while we were hidden
      void acquire()
    }
  })
}

/**
 * Translate a selection.
 *
 * Engines, in order:
 *  1. Apple's on-device Translation framework (macOS 15+ / iOS 18+) through
 *     the native shim — nothing leaves the device.
 *  2. The reader's own provider (DeepL key, or any OpenAI-compatible chat
 *     endpoint) — OFF by default, configured in Settings, and the only path
 *     here that sends text over the network. Its request is built by
 *     @solopdf/core (shared with the CLI); Rust carries it on desktop/iOS
 *     because DeepL refuses WebView CORS, the WebView fetch does on Android.
 *  3. Web build (vite dev / E2E): a stub engine, so the UI flow is testable
 *     in a plain browser.
 *
 * With none available the result is { code: 'noEngine' } and the popup
 * explains how to turn a provider on (and offers the offline dictionary for
 * single words).
 */
import {
  baseLang, guessLang, pickTarget, providerReady, translateWithProvider,
  type ProviderRequest, type TranslateResult,
} from '@solopdf/core'
import { isTauri } from './platform'
import { store } from './store'
import { currentLocale } from './i18n'

export type { TranslateResult }

let engineCache: Promise<string> | null = null

/** "apple" | "apple-hosted" | "none" (native) — "stub" in the web build */
export function nativeEngine(): Promise<string> {
  if (!isTauri()) return Promise.resolve(stubEnabled ? 'stub' : 'none')
  engineCache ??= import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke<string>('translate_engine'))
    .catch(() => 'none')
  return engineCache
}

/** web-build stub switch — the E2E harness turns it off to test the
 *  "nothing configured" state */
let stubEnabled = true
export function setTranslateStub(on: boolean): void {
  stubEnabled = on
}

const isAndroid = (): boolean => /Android/i.test(navigator.userAgent)

async function send(req: ProviderRequest): Promise<{ status: number; body: string }> {
  if (isTauri() && !isAndroid()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<{ status: number; body: string }>('translate_http', {
      url: req.url, headers: req.headers, body: req.body,
    })
  }
  const res = await fetch(req.url, {
    method: 'POST',
    headers: Object.fromEntries([...req.headers, ['Content-Type', 'application/json']]),
    body: req.body,
  })
  return { status: res.status, body: await res.text() }
}

/** the stub "translates" by tagging — enough to see the whole flow work */
function stub(text: string, target: string, fallback: string): TranslateResult {
  // same "already in target → fallback" rule as the real engines; Latin
  // script counts as English here
  const source = guessLang(text) ?? 'en'
  const into = baseLang(source) === baseLang(target) ? fallback : target
  return { text: `[${into}] ${text.trim()}`, source, target: into, engine: 'stub' }
}

/**
 * Translate `text`. `targetOverride` is the language picked in the popup;
 * otherwise the setting, otherwise the UI language (English when the text is
 * already in it).
 */
export async function translateText(text: string, targetOverride = ''): Promise<TranslateResult> {
  const clean = text.trim()
  if (!clean) return { error: 'nothing to translate', code: 'empty' }
  const cfg = store.settings.translate
  const { target, fallback } = pickTarget(targetOverride || cfg.target, currentLocale.value, guessLang(clean))
  const provider = providerReady(cfg.provider) ? cfg.provider : null

  const engine = await nativeEngine()
  if (engine === 'stub') return stub(clean, target, fallback)
  let native: TranslateResult | null = null
  if (engine !== 'none') {
    const { invoke } = await import('@tauri-apps/api/core')
    try {
      native = { ...(await invoke<TranslateResult>('translate_text', { text: clean, target, fallback })), engine: 'apple' }
    } catch (e) {
      native = { error: String(e), code: 'failed', engine: 'apple' }
    }
    // a missing language pack is the reader's call (download, or the
    // provider) — never silently send the text out instead
    if (!native.error || native.code === 'notInstalled' || native.code === 'same' || native.code === 'cancelled') {
      return native
    }
  }
  if (provider) return await translateWithProvider(provider, clean, target, fallback, send)
  return native && native.code !== 'unavailable' ? native : { code: 'noEngine', error: 'no translation engine', target }
}

/** Translate through the provider explicitly (the "use online provider"
 *  button when the on-device pack is missing). */
export async function translateOnline(text: string, targetOverride = ''): Promise<TranslateResult> {
  const cfg = store.settings.translate
  if (!providerReady(cfg.provider)) return { code: 'noEngine', error: 'no provider configured' }
  const { target, fallback } = pickTarget(targetOverride || cfg.target, currentLocale.value, guessLang(text))
  return await translateWithProvider(cfg.provider, text, target, fallback, send)
}

export function hasProvider(): boolean {
  return providerReady(store.settings.translate.provider)
}

/** Ask the OS to download a language pair; resolves true when it's ready. */
export async function downloadLanguages(source: string, target: string): Promise<boolean> {
  if (!isTauri()) return false
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    const r = await invoke<TranslateResult & { ok?: string }>('translate_prepare', { source, target })
    return !!r.ok
  } catch {
    return false
  }
}

/** macOS: open System Settings → Language & Region (Translation Languages). */
export async function openLanguageSettings(): Promise<boolean> {
  if (!isTauri() || /iPhone|iPad|Android/i.test(navigator.userAgent)) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<boolean>('translate_open_settings')
  } catch {
    return false
  }
}

/** a "word" worth offering the dictionary for: one token, or a short CJK run */
export function isSingleWord(text: string): boolean {
  const s = text.trim()
  if (!s) return false
  if (/[㐀-鿿぀-ヿ가-힯]/.test(s)) return [...s].length <= 8 && !/\s/.test(s)
  return !/\s/.test(s) && s.length <= 40
}

/**
 * Translation helpers shared by the app, the CLI and the MCP server.
 *
 * The on-device engine (Apple Translation) lives in the native shim; what is
 * here is everything around it that must behave the same in all three
 * surfaces:
 *  - which language to translate into (UI language, or English when the text
 *    is already in the UI language)
 *  - the optional network provider — DeepL or any OpenAI-compatible chat
 *    endpoint — as a pure request builder + response parser. The caller
 *    carries the bytes (Rust in the app, because a WebView fetch to DeepL is
 *    blocked by CORS; plain fetch in Node).
 *
 * The provider is off unless the reader configures it. Nothing in this file
 * performs I/O.
 */

/** Same shape the native shim returns. */
export interface TranslateResult {
  text?: string
  /** detected source language tag, e.g. "en", "zh-Hans" */
  source?: string
  /** target language tag actually used */
  target?: string
  error?: string
  /** notInstalled | unsupported | unavailable | same | empty | cancelled | failed | auth | network */
  code?: string
  /** which engine answered: "apple" | "deepl" | "openai" | "stub" */
  engine?: string
}

export type ProviderKind = 'off' | 'deepl' | 'openai'

export interface ProviderConfig {
  kind: ProviderKind
  /** DeepL auth key; keys ending in ":fx" are the free plan (api-free host) */
  deeplKey?: string
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
  baseUrl?: string
  apiKey?: string
  model?: string
}

export interface ProviderRequest {
  url: string
  headers: [string, string][]
  body: string
}

/** Target languages offered in the UI (BCP-47 tags Apple and DeepL both know). */
export const TRANSLATE_LANGS = [
  'zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'ar', 'th', 'vi', 'id', 'tr', 'pl', 'nl', 'uk', 'hi',
] as const

/** app UI language ("zh-CN" | "zh-TW" | "en" | "ja") → translation tag */
export function uiLangToTarget(ui: string): string {
  if (/^zh[-_](TW|HK|MO|Hant)/i.test(ui)) return 'zh-Hant'
  if (/^zh/i.test(ui)) return 'zh-Hans'
  return ui.split(/[-_]/)[0].toLowerCase() || 'en'
}

/** "zh-Hans-CN" → "zh" — whether two tags are "the same language" */
export function baseLang(tag: string): string {
  return (tag.split(/[-_]/)[0] ?? '').toLowerCase()
}

/**
 * Cheap script-based guess, for providers that cannot tell us the source
 * before we pick a target. Only answers when the script is unambiguous;
 * Latin text returns null (English and French look alike to a regex).
 */
export function guessLang(text: string): string | null {
  const s = text.replace(/\s+/g, '')
  if (!s) return null
  const count = (re: RegExp): number => (s.match(re) ?? []).length
  const kana = count(/[぀-ヿ]/g)
  const hangul = count(/[가-힯ᄀ-ᇿ]/g)
  const han = count(/[㐀-鿿豈-﫿]/g)
  const cyr = count(/[Ѐ-ӿ]/g)
  const arabic = count(/[؀-ۿ]/g)
  const thai = count(/[฀-๿]/g)
  const n = s.length
  if (kana > 0 && (kana + han) / n > 0.3) return 'ja'
  if (hangul / n > 0.3) return 'ko'
  if (han / n > 0.3) return 'zh'
  if (cyr / n > 0.3) return 'ru'
  if (arabic / n > 0.3) return 'ar'
  if (thai / n > 0.3) return 'th'
  return null
}

/**
 * The effective target: `preferred` (a setting; '' = follow the UI), unless
 * the text is already in it, in which case English — or, when both are
 * English, Chinese (the other language this app's readers most often read).
 * `detected` comes from the engine when it knows, else from guessLang.
 */
export function pickTarget(preferred: string, uiLang: string, detected: string | null): { target: string; fallback: string } {
  const ui = uiLangToTarget(uiLang)
  const target = preferred || ui
  let fallback = 'en'
  if (baseLang(target) === 'en') fallback = baseLang(ui) === 'en' ? 'zh-Hans' : ui
  if (detected && baseLang(detected) === baseLang(target)) return { target: fallback, fallback: target }
  return { target, fallback }
}

/** English name of a language tag, for prompts ("zh-Hans" → "Simplified Chinese") */
export function languageName(tag: string): string {
  if (tag === 'zh-Hans') return 'Simplified Chinese'
  if (tag === 'zh-Hant') return 'Traditional Chinese'
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}

/** our tag → DeepL target_lang code */
export function deeplTarget(tag: string): string {
  const map: Record<string, string> = {
    'zh-Hans': 'ZH-HANS', 'zh-Hant': 'ZH-HANT', zh: 'ZH-HANS', en: 'EN-US', pt: 'PT-BR',
  }
  return map[tag] ?? tag.toUpperCase()
}

/** DeepL source code ("EN", "ZH") → our tag */
function fromDeepl(code: string | undefined): string | undefined {
  if (!code) return undefined
  const c = code.toUpperCase()
  if (c === 'ZH' || c === 'ZH-HANS') return 'zh-Hans'
  if (c === 'ZH-HANT') return 'zh-Hant'
  return c.split('-')[0].toLowerCase()
}

export function providerReady(cfg: ProviderConfig | undefined): boolean {
  if (!cfg) return false
  if (cfg.kind === 'deepl') return !!cfg.deeplKey?.trim()
  if (cfg.kind === 'openai') return !!cfg.baseUrl?.trim() && !!cfg.model?.trim()
  return false
}

/** Build the provider HTTP request. Throws when the provider is not configured. */
export function buildProviderRequest(cfg: ProviderConfig, text: string, target: string, fallback = ''): ProviderRequest {
  if (cfg.kind === 'deepl') {
    const key = cfg.deeplKey?.trim()
    if (!key) throw new Error('DeepL key missing')
    const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com'
    return {
      url: `${host}/v2/translate`,
      headers: [['Authorization', `DeepL-Auth-Key ${key}`]],
      body: JSON.stringify({ text: [text], target_lang: deeplTarget(target) }),
    }
  }
  if (cfg.kind === 'openai') {
    const base = cfg.baseUrl?.trim().replace(/\/+$/, '')
    if (!base || !cfg.model?.trim()) throw new Error('endpoint or model missing')
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
    const into = languageName(target)
    const alt = fallback && baseLang(fallback) !== baseLang(target)
      ? ` If the text is already in ${into}, translate it into ${languageName(fallback)} instead.`
      : ''
    const headers: [string, string][] = []
    if (cfg.apiKey?.trim()) headers.push(['Authorization', `Bearer ${cfg.apiKey.trim()}`])
    return {
      url,
      headers,
      body: JSON.stringify({
        model: cfg.model.trim(),
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              `You are a translation engine. Translate the user's text into ${into}.${alt} ` +
              'Reply with the translation only — no quotes, notes, or explanations. Keep line breaks.',
          },
          { role: 'user', content: text },
        ],
      }),
    }
  }
  throw new Error('no translation provider configured')
}

/** Turn the provider's HTTP answer into a TranslateResult. */
export function parseProviderResponse(cfg: ProviderConfig, status: number, body: string, target: string): TranslateResult {
  const engine = cfg.kind
  if (status === 401 || status === 403) {
    return { error: 'the provider rejected the API key', code: 'auth', engine, target }
  }
  if (status === 456) return { error: 'DeepL quota exceeded', code: 'failed', engine, target }
  if (status < 200 || status >= 300) {
    let msg = body.slice(0, 200)
    try {
      const j = JSON.parse(body)
      msg = j?.error?.message ?? j?.message ?? msg
    } catch { /* keep raw text */ }
    return { error: `HTTP ${status}: ${msg}`, code: 'failed', engine, target }
  }
  try {
    const j = JSON.parse(body)
    if (engine === 'deepl') {
      const t = j?.translations?.[0]
      if (!t?.text) return { error: 'empty response', code: 'failed', engine, target }
      return { text: t.text, source: fromDeepl(t.detected_source_language), target, engine }
    }
    const content = j?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      return { error: 'empty response', code: 'failed', engine, target }
    }
    // reasoning models sometimes leak their scratchpad; the answer follows it
    const text = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    return { text, target, engine }
  } catch {
    return { error: 'unreadable response', code: 'failed', engine, target }
  }
}

/** Carry a ProviderRequest: fetch-shaped transport, injected by the caller. */
export type ProviderTransport = (req: ProviderRequest) => Promise<{ status: number; body: string }>

/**
 * Translate through the configured provider. For DeepL, when the detected
 * source turns out to be the target language, one more request goes to the
 * fallback — the same "already in target → fallback" rule the Apple engine
 * applies before translating.
 */
export async function translateWithProvider(
  cfg: ProviderConfig,
  text: string,
  target: string,
  fallback: string,
  send: ProviderTransport,
): Promise<TranslateResult> {
  const clean = text.trim()
  if (!clean) return { error: 'nothing to translate', code: 'empty', engine: cfg.kind }
  let res: { status: number; body: string }
  try {
    res = await send(buildProviderRequest(cfg, clean, target, fallback))
  } catch (e) {
    return { error: String((e as Error)?.message ?? e), code: 'network', engine: cfg.kind, target }
  }
  const out = parseProviderResponse(cfg, res.status, res.body, target)
  if (cfg.kind === 'deepl' && out.source && fallback && baseLang(out.source) === baseLang(target)
      && baseLang(fallback) !== baseLang(target)) {
    try {
      const again = await send(buildProviderRequest(cfg, clean, fallback))
      return parseProviderResponse(cfg, again.status, again.body, fallback)
    } catch (e) {
      return { error: String((e as Error)?.message ?? e), code: 'network', engine: cfg.kind, target: fallback }
    }
  }
  return out
}

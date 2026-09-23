import { describe, it, expect } from 'vitest'
import {
  uiLangToTarget, pickTarget, guessLang, buildProviderRequest, parseProviderResponse,
  translateWithProvider, providerReady, deeplTarget,
} from '../src/translate.js'

describe('target language', () => {
  it('maps UI languages to translation tags', () => {
    expect(uiLangToTarget('zh-CN')).toBe('zh-Hans')
    expect(uiLangToTarget('zh-TW')).toBe('zh-Hant')
    expect(uiLangToTarget('ja')).toBe('ja')
    expect(uiLangToTarget('en')).toBe('en')
  })

  it('defaults to the UI language, English when the text is already in it', () => {
    expect(pickTarget('', 'zh-CN', 'en')).toEqual({ target: 'zh-Hans', fallback: 'en' })
    expect(pickTarget('', 'zh-CN', 'zh')).toEqual({ target: 'en', fallback: 'zh-Hans' })
    expect(pickTarget('', 'ja', null)).toEqual({ target: 'ja', fallback: 'en' })
  })

  it('English UI reading English text falls back to Chinese', () => {
    expect(pickTarget('', 'en', 'en')).toEqual({ target: 'zh-Hans', fallback: 'en' })
  })

  it('an explicit setting wins over the UI language', () => {
    expect(pickTarget('fr', 'zh-CN', 'en').target).toBe('fr')
  })

  it('guesses only unambiguous scripts', () => {
    expect(guessLang('汉字文化圈')).toBe('zh')
    expect(guessLang('ひらがなと漢字')).toBe('ja')
    expect(guessLang('한국어 문장')).toBe('ko')
    expect(guessLang('Hello there')).toBeNull()
  })
})

describe('providers', () => {
  it('is not ready until configured', () => {
    expect(providerReady(undefined)).toBe(false)
    expect(providerReady({ kind: 'off' })).toBe(false)
    expect(providerReady({ kind: 'deepl', deeplKey: '' })).toBe(false)
    expect(providerReady({ kind: 'deepl', deeplKey: 'k:fx' })).toBe(true)
    expect(providerReady({ kind: 'openai', baseUrl: 'https://x/v1', model: 'm' })).toBe(true)
  })

  it('builds a DeepL request on the right host', () => {
    const free = buildProviderRequest({ kind: 'deepl', deeplKey: 'abc:fx' }, 'Hi', 'zh-Hans')
    expect(free.url).toBe('https://api-free.deepl.com/v2/translate')
    expect(free.headers).toEqual([['Authorization', 'DeepL-Auth-Key abc:fx']])
    expect(JSON.parse(free.body)).toEqual({ text: ['Hi'], target_lang: 'ZH-HANS' })
    const pro = buildProviderRequest({ kind: 'deepl', deeplKey: 'abc' }, 'Hi', 'en')
    expect(pro.url).toBe('https://api.deepl.com/v2/translate')
    expect(deeplTarget('en')).toBe('EN-US')
  })

  it('builds an OpenAI-compatible chat request', () => {
    const r = buildProviderRequest(
      { kind: 'openai', baseUrl: 'https://api.example.com/v1/', apiKey: 'sk', model: 'gpt-x' }, 'Hi', 'ja', 'en')
    expect(r.url).toBe('https://api.example.com/v1/chat/completions')
    expect(r.headers).toEqual([['Authorization', 'Bearer sk']])
    const body = JSON.parse(r.body)
    expect(body.model).toBe('gpt-x')
    expect(body.messages[0].content).toContain('Japanese')
    expect(body.messages[0].content).toContain('English instead')
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Hi' })
  })

  it('parses answers and errors', () => {
    const deepl = { kind: 'deepl' as const, deeplKey: 'k' }
    expect(parseProviderResponse(deepl, 200,
      JSON.stringify({ translations: [{ text: '你好', detected_source_language: 'EN' }] }), 'zh-Hans'))
      .toEqual({ text: '你好', source: 'en', target: 'zh-Hans', engine: 'deepl' })
    expect(parseProviderResponse(deepl, 403, '', 'en').code).toBe('auth')
    const oa = { kind: 'openai' as const, baseUrl: 'https://x', model: 'm' }
    expect(parseProviderResponse(oa, 200,
      JSON.stringify({ choices: [{ message: { content: '<think>hmm</think>\nBonjour' } }] }), 'fr').text).toBe('Bonjour')
    expect(parseProviderResponse(oa, 500, '{"error":{"message":"boom"}}', 'fr').error).toBe('HTTP 500: boom')
  })

  it('DeepL retries into the fallback when the text was already in the target', async () => {
    const sent: string[] = []
    const r = await translateWithProvider({ kind: 'deepl', deeplKey: 'k' }, 'Bonjour', 'fr', 'en', async (req) => {
      const lang = JSON.parse(req.body).target_lang
      sent.push(lang)
      return lang === 'FR'
        ? { status: 200, body: JSON.stringify({ translations: [{ text: 'Bonjour', detected_source_language: 'FR' }] }) }
        : { status: 200, body: JSON.stringify({ translations: [{ text: 'Hello', detected_source_language: 'FR' }] }) }
    })
    expect(sent).toEqual(['FR', 'EN-US'])
    expect(r).toMatchObject({ text: 'Hello', target: 'en' })
  })

  it('reports transport failures as network errors', async () => {
    const r = await translateWithProvider({ kind: 'deepl', deeplKey: 'k' }, 'x', 'en', '', async () => {
      throw new Error('offline')
    })
    expect(r).toMatchObject({ code: 'network', error: 'offline' })
  })
})

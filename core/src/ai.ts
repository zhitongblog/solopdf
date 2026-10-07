/**
 * "Ask AI" — everything that must behave the same in the app, the CLI and
 * the MCP server, and none of the I/O:
 *
 *   pages ─► chunkPages ─► buildIndex ─► searchChunks(q) ─► top-k chunks
 *                                                     │
 *   buildAskMessages / buildExplainMessages / … ◄─────┘   (cite as [p.N])
 *        │
 *   chatRequest ─► transport (caller's: Rust in the app, fetch in Node)
 *        │
 *   ChatStreamParser ─► text ─► parseCitations ─► clickable [p.N]
 *
 * Retrieval is a plain local BM25 over page chunks. Latin text is split into
 * words (lower-cased, NFKC, tiny stemmer, stop-words dropped); CJK has no
 * spaces, so Han / kana / Hangul runs become overlapping bigrams — the usual
 * cheap trick that makes "损失函数" match "损失" and "函数". Nothing here
 * talks to the network: the provider is the reader's own, off by default,
 * and only the excerpts retrieval picked are ever sent.
 */
import { chatCompletionsUrl, bearerHeaders, type ProviderRequest } from './translate.js'

// ── text ────────────────────────────────────────────────────────────────

export interface PageText {
  /** 1-based page (PDF) or chapter (EPUB/TXT/MOBI) number */
  page: number
  text: string
}

/** pdf.js getTextContent() items → plain text, same join the CLI uses */
export function textFromItems(items: ReadonlyArray<{ str?: string; hasEOL?: boolean }>): string {
  let out = ''
  for (const it of items) {
    if (typeof it.str !== 'string') continue
    out += it.str + (it.hasEOL ? '\n' : '')
  }
  return out
}

/** NFKC, re-join words hyphenated across lines, collapse whitespace */
export function cleanText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/([A-Za-z])-\n([a-z])/g, '$1$2')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── chunking ────────────────────────────────────────────────────────────

export interface Chunk {
  /** index into the chunk list */
  id: number
  page: number
  text: string
}

export interface ChunkOptions {
  /** target size of one chunk in characters */
  maxChars?: number
  /** characters repeated at the start of the next chunk of the same page */
  overlap?: number
}

/** where to cut `s` at or before `max`: paragraph > sentence > space > hard */
function cutPoint(s: string, max: number): number {
  if (s.length <= max) return s.length
  const window = s.slice(0, max)
  const floor = Math.floor(max * 0.5)
  for (const re of [/\n\n/g, /[.!?。！？；;]\s*/g, /\n/g, /[\s,，、]/g]) {
    let best = -1
    for (const m of window.matchAll(re)) {
      const end = m.index! + m[0].length
      if (end >= floor) best = end
    }
    if (best > 0) return best
  }
  return max
}

/**
 * Split page texts into retrieval chunks. Chunks never span pages — a
 * citation has to name ONE page — so a short page is one small chunk and a
 * long page becomes several, cut at paragraph/sentence boundaries.
 */
export function chunkPages(pages: readonly PageText[], opts: ChunkOptions = {}): Chunk[] {
  const max = Math.max(200, opts.maxChars ?? 1200)
  const overlap = Math.min(Math.max(0, opts.overlap ?? 150), Math.floor(max / 3))
  const out: Chunk[] = []
  for (const p of pages) {
    let rest = cleanText(p.text)
    while (rest.length) {
      const cut = cutPoint(rest, max)
      const piece = rest.slice(0, cut).trim()
      if (piece) out.push({ id: out.length, page: p.page, text: piece })
      if (cut >= rest.length) break
      // back up a little (to a word boundary) so a sentence split across
      // two chunks is still findable from either side; cut ≥ max/2 > overlap,
      // so this always moves forward
      let back = cut - overlap
      if (overlap) {
        const sp = rest.indexOf(' ', back)
        if (sp >= 0 && sp < cut) back = sp + 1
      }
      rest = rest.slice(back)
    }
  }
  return out
}

// ── tokenizer ───────────────────────────────────────────────────────────

const STOP = new Set((
  'a an and are as at be been but by can did do does for from had has have he her his how i if in into is it its ' +
  'me my no not of on or our she so than that the their them then there these they this those to too was we were ' +
  'what when where which who whom why will with would you your about also any each more most other some such only ' +
  'own same very just should could may might must shall being does doing over under again further once here both ' +
  'between through during before after above below up down out off'
).split(' '))

/** tiny English stemmer: enough that "pages"/"page" and "studies"/"study" meet */
function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y'
  if (w.endsWith('sses')) return w.slice(0, -2)
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1)
  return w
}

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]+/gu
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu

/**
 * Query/document tokens. Latin: stemmed lower-case words minus stop-words.
 * CJK runs: overlapping bigrams (a one-character run stays a unigram).
 */
export function tokenize(text: string): string[] {
  const s = text.normalize('NFKC').toLowerCase()
  const out: string[] = []
  // CJK first, then blank those runs out so WORD doesn't see them again
  const rest = s.replace(CJK_RUN, (run) => {
    const chars = [...run]
    if (chars.length === 1) out.push(chars[0])
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1])
    return ' '
  })
  for (const m of rest.matchAll(WORD)) {
    const w = m[0].replace(/['’]s$/, '')
    if (STOP.has(w)) continue
    if (w.length < 2 && !/\d/.test(w)) continue
    out.push(stem(w))
  }
  return out
}

// ── BM25 ────────────────────────────────────────────────────────────────

export interface LexIndex {
  chunks: Chunk[]
  /** term frequencies per chunk */
  tf: Map<string, number>[]
  len: number[]
  df: Map<string, number>
  avgLen: number
}

export function buildIndex(chunks: Chunk[]): LexIndex {
  const tf: Map<string, number>[] = []
  const len: number[] = []
  const df = new Map<string, number>()
  for (const c of chunks) {
    const m = new Map<string, number>()
    const toks = tokenize(c.text)
    for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1)
    for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    tf.push(m)
    len.push(toks.length)
  }
  const avgLen = len.length ? len.reduce((a, b) => a + b, 0) / len.length : 0
  return { chunks, tf, len, df, avgLen }
}

export interface Scored {
  chunk: Chunk
  score: number
}

/** BM25 (k1 = 1.2, b = 0.75). Chunks with no query term are not returned. */
export function searchChunks(index: LexIndex, query: string, k = 6): Scored[] {
  const terms = [...new Set(tokenize(query))]
  if (!terms.length || !index.chunks.length) return []
  const N = index.chunks.length
  const k1 = 1.2
  const b = 0.75
  const idf = new Map<string, number>()
  for (const t of terms) {
    const n = index.df.get(t) ?? 0
    if (n) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)))
  }
  const out: Scored[] = []
  for (let i = 0; i < N; i++) {
    const m = index.tf[i]
    let score = 0
    for (const [t, w] of idf) {
      const f = m.get(t)
      if (!f) continue
      score += w * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (index.len[i] / (index.avgLen || 1))))
    }
    if (score > 0) out.push({ chunk: index.chunks[i], score })
  }
  out.sort((a, b2) => b2.score - a.score || a.chunk.id - b2.chunk.id)
  return out.slice(0, Math.max(1, k))
}

/**
 * Top-k chunks for a query, with a fallback: a question that shares no word
 * with the document ("what is this about?") still gets the opening pages,
 * so the model has something to read instead of nothing.
 */
export function retrieve(index: LexIndex, query: string, k = 6): Scored[] {
  const hits = searchChunks(index, query, k)
  if (hits.length) return hits
  return index.chunks.slice(0, k).map((chunk) => ({ chunk, score: 0 }))
}

// ── prompts ─────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** "pages" for PDFs; EPUB/TXT/MOBI number chapters, the citation stays [p.N] */
export type CiteUnit = 'page' | 'chapter'

export interface PromptContext {
  /** document title / file name, shown to the model */
  docName: string
  unit?: CiteUnit
  /** language tag for summaries ("zh-Hans", "en", …); questions are answered
   *  in the language they were asked in */
  lang?: string
}

function unitWord(u: CiteUnit | undefined): string {
  return u === 'chapter' ? 'chapter' : 'page'
}

function langName(tag: string): string {
  if (tag === 'zh-Hans') return 'Simplified Chinese'
  if (tag === 'zh-Hant') return 'Traditional Chinese'
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}

function citeRule(ctx: PromptContext): string {
  const u = unitWord(ctx.unit)
  return `Every excerpt is labelled with its ${u} number like [p.12]. ` +
    `Cite the ${u}s you use inline, in exactly that form — [p.12], or [p.12, p.15] for several — ` +
    `right after the sentence they support. Never cite a ${u} that is not among the excerpts.`
}

/** excerpts in reading order, each under its [p.N] label */
export function formatExcerpts(chunks: readonly Chunk[]): string {
  const sorted = [...chunks].sort((a, b) => a.page - b.page || a.id - b.id)
  return sorted.map((c) => `[p.${c.page}]\n${c.text}`).join('\n\n---\n\n')
}

export function buildAskMessages(ctx: PromptContext & { question: string; chunks: readonly Chunk[] }): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        `You answer questions about the document "${ctx.docName}" using ONLY the excerpts provided. ` +
        citeRule(ctx) + ' ' +
        'If the excerpts do not contain the answer, say so plainly instead of guessing. ' +
        'Answer in the same language as the question. Be concise; use short paragraphs or bullet lists.',
    },
    {
      role: 'user',
      content: `Excerpts:\n\n${formatExcerpts(ctx.chunks)}\n\n===\n\nQuestion: ${ctx.question.trim()}`,
    },
  ]
}

export function buildExplainMessages(ctx: PromptContext & {
  selection: string
  page: number
  chunks: readonly Chunk[]
}): ChatMessage[] {
  const lang = ctx.lang ? `Write in ${langName(ctx.lang)}.` : ''
  return [
    {
      role: 'system',
      content:
        `You help a reader understand a passage of the document "${ctx.docName}". ` +
        'Explain what the passage means in plain words: define terms, unpack notation, and give the context ' +
        'the surrounding excerpts provide. ' + citeRule(ctx) + ' ' + lang,
    },
    {
      role: 'user',
      content:
        `Context excerpts:\n\n${formatExcerpts(ctx.chunks)}\n\n===\n\n` +
        `Passage to explain (from [p.${ctx.page}]):\n"""\n${ctx.selection.trim()}\n"""`,
    },
  ]
}

export function buildPageSummaryMessages(ctx: PromptContext & { page: number; text: string; maxChars?: number }): ChatMessage[] {
  const u = unitWord(ctx.unit)
  const lang = ctx.lang ? `Write in ${langName(ctx.lang)}.` : ''
  const body = cleanText(ctx.text).slice(0, ctx.maxChars ?? 12000)
  return [
    {
      role: 'system',
      content:
        `Summarise ${u} ${ctx.page} of the document "${ctx.docName}" in a few bullet points: the key claims, ` +
        `results and definitions. Cite it as [p.${ctx.page}]. ${lang}`,
    },
    { role: 'user', content: `[p.${ctx.page}]\n${body}` },
  ]
}

export interface SummaryPlan {
  /** one model call per group (the "map" step); a single group needs no reduce */
  groups: PageText[][]
  /** true when pages had to be shortened to fit the budget */
  truncated: boolean
  /** characters that will be sent across all map calls */
  chars: number
}

/**
 * Fit a document into the summary budget. Every page keeps at least its
 * opening (so every page can still be cited) and the remaining budget is
 * shared in proportion to page length; the result is packed into groups of
 * at most `callChars` — one model call each.
 */
export function planSummary(
  pages: readonly PageText[],
  opts: { budgetChars?: number; callChars?: number; minPerPage?: number } = {},
): SummaryPlan {
  const budget = Math.max(2000, opts.budgetChars ?? 48000)
  const callChars = Math.max(1000, Math.min(opts.callChars ?? 12000, budget))
  const minPer = opts.minPerPage ?? 300
  const clean = pages.map((p) => ({ page: p.page, text: cleanText(p.text) })).filter((p) => p.text)
  const total = clean.reduce((n, p) => n + p.text.length, 0)
  let truncated = false
  let fitted = clean
  if (total > budget) {
    truncated = true
    const share = budget / total
    fitted = clean.map((p) => {
      const keep = Math.max(Math.min(minPer, p.text.length), Math.floor(p.text.length * share))
      return keep >= p.text.length ? p : { page: p.page, text: p.text.slice(0, cutPoint(p.text, keep)).trim() + ' …' }
    })
    // a very long document can still overshoot on the per-page minimum alone:
    // sample pages evenly rather than blow the budget
    const sum = fitted.reduce((n, p) => n + p.text.length, 0)
    if (sum > budget) {
      const step = sum / budget
      const sampled: PageText[] = []
      let acc = 0
      for (let i = 0; i < fitted.length; i += step) {
        const p = fitted[Math.floor(i)]
        if (acc + p.text.length > budget) break
        sampled.push(p)
        acc += p.text.length
      }
      fitted = sampled
    }
  }
  const groups: PageText[][] = []
  let cur: PageText[] = []
  let curLen = 0
  for (const p of fitted) {
    const text = p.text.length > callChars ? p.text.slice(0, cutPoint(p.text, callChars)) : p.text
    if (cur.length && curLen + text.length > callChars) {
      groups.push(cur)
      cur = []
      curLen = 0
    }
    cur.push({ page: p.page, text })
    curLen += text.length
  }
  if (cur.length) groups.push(cur)
  const chars = groups.reduce((n, g) => n + g.reduce((m, p) => m + p.text.length, 0), 0)
  return { groups, truncated, chars }
}

function groupText(group: readonly PageText[]): string {
  return group.map((p) => `[p.${p.page}]\n${p.text}`).join('\n\n---\n\n')
}

/** one-call summary of a document that fits a single request */
export function buildDocSummaryMessages(ctx: PromptContext & { group: readonly PageText[]; truncated?: boolean }): ChatMessage[] {
  const lang = ctx.lang ? `Write in ${langName(ctx.lang)}.` : ''
  const note = ctx.truncated ? ' Some pages are shortened (marked …); do not speculate about what was cut.' : ''
  return [
    {
      role: 'system',
      content:
        `Summarise the document "${ctx.docName}". Start with a one-sentence overview, then 4–8 bullet points ` +
        `covering the main ideas, methods, results and conclusions. ${citeRule(ctx)}${note} ${lang}`,
    },
    { role: 'user', content: groupText(ctx.group) },
  ]
}

/** map step: notes on one part of a long document */
export function buildMapMessages(ctx: PromptContext & { group: readonly PageText[]; part: number; parts: number }): ChatMessage[] {
  const u = unitWord(ctx.unit)
  const first = ctx.group[0]?.page
  const last = ctx.group[ctx.group.length - 1]?.page
  return [
    {
      role: 'system',
      content:
        `You are reading part ${ctx.part} of ${ctx.parts} (${u}s ${first}–${last}) of the document "${ctx.docName}". ` +
        `Write compact notes (at most 8 bullets) on what this part says: claims, definitions, results. ` +
        citeRule(ctx) + ' Write in English; another step will combine the notes.',
    },
    { role: 'user', content: groupText(ctx.group) },
  ]
}

/** reduce step: the notes of every part → one summary, citations preserved */
export function buildReduceMessages(ctx: PromptContext & { partials: readonly string[] }): ChatMessage[] {
  const lang = ctx.lang ? `Write in ${langName(ctx.lang)}.` : ''
  return [
    {
      role: 'system',
      content:
        `Below are notes on consecutive parts of the document "${ctx.docName}". Combine them into one summary: ` +
        'a one-sentence overview, then 5–10 bullet points in the order the document presents them. ' +
        'Keep the [p.N] citations from the notes on the statements they support; do not invent new ones. ' + lang,
    },
    {
      role: 'user',
      content: ctx.partials.map((p, i) => `## Part ${i + 1}\n${p.trim()}`).join('\n\n'),
    },
  ]
}

// ── citations ───────────────────────────────────────────────────────────

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'cite'; text: string; pages: number[] }

const CITE_RE =
  /[[【]\s*(?:pp?|pages?|页|頁|ページ)\s*\.?\s*(\d{1,5}(?:\s*[-–—~]\s*\d{1,5})?(?:\s*[,，;；、]\s*(?:pp?\s*\.?\s*)?\d{1,5}(?:\s*[-–—~]\s*\d{1,5})?)*)\s*[\]】]/giu

function expandPages(list: string, maxPage: number): number[] {
  const out: number[] = []
  for (const part of list.split(/[,，;；、]/)) {
    const m = part.replace(/pp?\s*\.?/i, '').match(/(\d+)(?:\s*[-–—~]\s*(\d+))?/)
    if (!m) continue
    const a = parseInt(m[1], 10)
    const b = m[2] ? parseInt(m[2], 10) : a
    const lo = Math.min(a, b)
    const hi = Math.min(Math.max(a, b), lo + 19) // a runaway range is not 500 links
    for (let p = lo; p <= hi; p++) if (p >= 1 && p <= maxPage && !out.includes(p)) out.push(p)
  }
  return out
}

/**
 * Split model output into text and citation segments. Accepts the forms
 * models actually produce: [p.3] [p. 3] [pp. 3-4] [p.3, p.7] [p3; 5] 【p.3】
 * [page 3] [页 3]. A citation naming no page inside 1..maxPage stays text —
 * a hallucinated [p.999] must not become a link to nowhere.
 */
export function parseCitations(text: string, maxPage = Number.MAX_SAFE_INTEGER): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(CITE_RE)) {
    const pages = expandPages(m[1], maxPage)
    if (!pages.length) continue
    if (m.index! > last) out.push({ type: 'text', text: text.slice(last, m.index) })
    out.push({ type: 'cite', text: m[0], pages })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  // merge adjacent text segments (skipped invalid citations split them)
  const merged: Segment[] = []
  for (const s of out) {
    const prev = merged[merged.length - 1]
    if (s.type === 'text' && prev?.type === 'text') prev.text += s.text
    else merged.push({ ...s } as Segment)
  }
  return merged
}

/** distinct cited pages in order of first appearance */
export function citedPages(text: string, maxPage = Number.MAX_SAFE_INTEGER): number[] {
  const out: number[] = []
  for (const s of parseCitations(text, maxPage)) {
    if (s.type === 'cite') for (const p of s.pages) if (!out.includes(p)) out.push(p)
  }
  return out
}

/** rewrite citations as Markdown links (for the sidecar note) */
export function linkCitations(text: string, toUrl: (page: number) => string, maxPage = Number.MAX_SAFE_INTEGER): string {
  return parseCitations(text, maxPage)
    .map((s) => (s.type === 'text' ? s.text : s.pages.map((p) => `[p.${p}](${toUrl(p)})`).join(' ')))
    .join('')
}

/**
 * Make model Markdown safe inside one sidecar section. The sidecar format
 * gives `## ` (a new section), a leading `>` (the excerpt) and our own
 * comments meaning; an answer must not be able to forge any of them.
 */
export function sidecarSafe(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => {
      const h = l.match(/^\s{0,3}#{1,6}\s+(.*)$/)
      if (h) return `**${h[1].replace(/\s*#+\s*$/, '').trim()}**`
      if (/^\s{0,3}>/.test(l)) return l.replace(/^(\s{0,3})>/, '$1\\>')
      return l
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** reasoning models stream a <think>…</think> scratchpad first: hide it */
export function stripThinking(text: string): string {
  let s = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const open = s.indexOf('<think>')
  if (open >= 0) s = s.slice(0, open)
  return s.replace(/^\s+/, '')
}

// ── provider request / response ─────────────────────────────────────────

/** an OpenAI-compatible chat endpoint (OpenAI, DeepSeek, Ollama, LM Studio …) */
export interface AiProvider {
  baseUrl: string
  apiKey?: string
  model: string
}

export function aiProviderReady(p: Partial<AiProvider> | undefined | null): p is AiProvider {
  return !!p?.baseUrl?.trim() && !!p?.model?.trim()
}

/** true for an endpoint on this machine — nothing leaves the device */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl.trim()).hostname.replace(/^\[|\]$/g, '')
    return h === 'localhost' || h === '::1' || /^127\./.test(h)
  } catch {
    return false
  }
}

/** "https://api.openai.com/v1" → "api.openai.com" (for the privacy line) */
export function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).host
  } catch {
    return baseUrl.trim()
  }
}

export function chatRequest(
  p: AiProvider,
  messages: readonly ChatMessage[],
  opts: { stream?: boolean; temperature?: number; maxTokens?: number } = {},
): ProviderRequest {
  if (!aiProviderReady(p)) throw new Error('endpoint or model missing')
  const body: Record<string, unknown> = {
    model: p.model.trim(),
    messages,
    temperature: opts.temperature ?? 0.2,
    stream: opts.stream ?? true,
  }
  if (opts.maxTokens) body.max_tokens = opts.maxTokens
  return { url: chatCompletionsUrl(p.baseUrl), headers: bearerHeaders(p.apiKey), body: JSON.stringify(body) }
}

export type AiErrorCode = 'network' | 'auth' | 'model' | 'http' | 'empty' | 'cancelled' | 'config'

export interface AiError {
  code: AiErrorCode
  message: string
  status?: number
}

/** a non-2xx answer → what to tell the reader */
export function classifyChatError(status: number, body: string): AiError {
  let msg = body.trim().slice(0, 300)
  try {
    const j = JSON.parse(body)
    const e = j?.error
    msg = (typeof e === 'string' ? e : e?.message) ?? j?.message ?? j?.detail ?? msg
  } catch { /* keep raw text */ }
  msg = String(msg)
  if (status === 401 || status === 403) return { code: 'auth', message: msg || `HTTP ${status}`, status }
  if (/model/i.test(msg) && /(not.?found|does not exist|not exist|unknown|no models? loaded|not loaded|invalid model|pull)/i.test(msg)) {
    return { code: 'model', message: msg, status }
  }
  return { code: 'http', message: `HTTP ${status}${msg ? ': ' + msg : ''}`, status }
}

/**
 * Incremental parser for a chat completion — SSE (`data: {…}` lines,
 * `data: [DONE]`) or, when the server ignored `stream: true`, one JSON body.
 * push() returns the text delta contained in this piece.
 */
export class ChatStreamParser {
  private buf = ''
  private mode: 'unknown' | 'sse' | 'json' = 'unknown'
  /** error object the server streamed instead of tokens */
  error: string | null = null
  done = false

  push(piece: string): string {
    this.buf += piece
    if (this.mode === 'unknown') {
      const head = this.buf.trimStart()
      if (!head) return ''
      this.mode = head.startsWith('{') ? 'json' : 'sse'
    }
    if (this.mode === 'json') return ''
    let out = ''
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '')
      this.buf = this.buf.slice(nl + 1)
      out += this.line(line)
    }
    return out
  }

  /** flush whatever is left; for a plain JSON body this is the whole answer */
  end(): string {
    const rest = this.buf
    this.buf = ''
    if (this.mode === 'json') {
      try {
        const j = JSON.parse(rest)
        if (j?.error) {
          this.error = typeof j.error === 'string' ? j.error : j.error.message ?? 'error'
          return ''
        }
        const c = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text ?? ''
        return typeof c === 'string' ? c : ''
      } catch {
        this.error = 'unreadable response'
        return ''
      }
    }
    return rest ? this.line(rest.replace(/\r$/, '')) : ''
  }

  private line(line: string): string {
    if (!line.startsWith('data:')) return ''
    const data = line.slice(5).trim()
    if (!data) return ''
    if (data === '[DONE]') { this.done = true; return '' }
    try {
      const j = JSON.parse(data)
      if (j?.error) {
        this.error = typeof j.error === 'string' ? j.error : j.error.message ?? 'error'
        return ''
      }
      const ch = j?.choices?.[0]
      const c = ch?.delta?.content ?? ch?.message?.content ?? ch?.text ?? ''
      return typeof c === 'string' ? c : ''
    } catch {
      return ''
    }
  }
}

// ── running a chat ──────────────────────────────────────────────────────

/**
 * Carries one request and hands back the status plus the body as it
 * arrives. Injected by the caller: Rust (Tauri channel) in the desktop app,
 * WebView fetch on Android/web, Node fetch in the CLI. It must reject with
 * an error named "AbortError" when `signal` fires.
 */
export type StreamTransport = (
  req: ProviderRequest,
  signal?: AbortSignal,
) => Promise<{ status: number; chunks: AsyncIterable<string> }>

export type ChatResult = { text: string; error?: undefined } | { text?: undefined; error: AiError }

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (e as Error)?.name === 'AbortError'
}

/** "fetch failed" says nothing; its cause (ECONNREFUSED, ENOTFOUND…) does */
function netMessage(e: unknown): string {
  const msg = String((e as Error)?.message ?? e)
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause
  const detail = cause?.code ?? cause?.message
  return detail && !msg.includes(detail) ? `${msg} (${detail})` : msg
}

export async function runChat(
  p: AiProvider,
  messages: readonly ChatMessage[],
  send: StreamTransport,
  opts: { signal?: AbortSignal; onText?: (text: string) => void; stream?: boolean; maxTokens?: number } = {},
): Promise<ChatResult> {
  if (!aiProviderReady(p)) return { error: { code: 'config', message: 'no AI provider configured' } }
  let res: { status: number; chunks: AsyncIterable<string> }
  try {
    res = await send(chatRequest(p, messages, { stream: opts.stream ?? true, maxTokens: opts.maxTokens }), opts.signal)
  } catch (e) {
    if (isAbort(e, opts.signal)) return { error: { code: 'cancelled', message: 'cancelled' } }
    return { error: { code: 'network', message: netMessage(e) } }
  }
  try {
    if (res.status < 200 || res.status >= 300) {
      let body = ''
      for await (const c of res.chunks) {
        body += c
        if (body.length > 64 * 1024) break
      }
      return { error: classifyChatError(res.status, body) }
    }
    const parser = new ChatStreamParser()
    let raw = ''
    for await (const c of res.chunks) {
      if (opts.signal?.aborted) return { error: { code: 'cancelled', message: 'cancelled' } }
      const d = parser.push(c)
      if (d) {
        raw += d
        opts.onText?.(stripThinking(raw))
      }
      if (parser.error) break
    }
    const tail = parser.end()
    if (tail) {
      raw += tail
      opts.onText?.(stripThinking(raw))
    }
    if (parser.error) return { error: classifyChatError(500, JSON.stringify({ error: parser.error })) }
    const text = stripThinking(raw).trim()
    if (!text) return { error: { code: 'empty', message: 'empty response' } }
    return { text }
  } catch (e) {
    if (isAbort(e, opts.signal)) return { error: { code: 'cancelled', message: 'cancelled' } }
    return { error: { code: 'network', message: netMessage(e) } }
  }
}

// ── tasks (shared by the app panel and the CLI) ─────────────────────────

export interface TaskHooks {
  signal?: AbortSignal
  /** streaming text of the FINAL answer */
  onText?: (text: string) => void
  /** map-reduce progress: done / total model calls */
  onProgress?: (done: number, total: number) => void
}

export interface TaskResult {
  text?: string
  error?: AiError
  /** pages (or chapters) whose text was sent */
  sources: number[]
  /** summary only: the budget forced pages to be shortened */
  truncated?: boolean
}

export interface DocIndex {
  pages: PageText[]
  index: LexIndex
}

export function indexDocument(pages: readonly PageText[], opts: ChunkOptions = {}): DocIndex {
  const clean = pages.map((p) => ({ page: p.page, text: p.text }))
  return { pages: clean, index: buildIndex(chunkPages(clean, opts)) }
}

const uniqPages = (chunks: readonly Chunk[]): number[] => [...new Set(chunks.map((c) => c.page))].sort((a, b) => a - b)

export async function askDocument(
  p: AiProvider, doc: DocIndex, question: string, ctx: PromptContext, send: StreamTransport,
  hooks: TaskHooks & { k?: number } = {},
): Promise<TaskResult> {
  const hits = retrieve(doc.index, question, hooks.k ?? 6).map((h) => h.chunk)
  const sources = uniqPages(hits)
  if (!hits.length) return { error: { code: 'empty', message: 'the document has no text' }, sources }
  const r = await runChat(p, buildAskMessages({ ...ctx, question, chunks: hits }), send, hooks)
  return { ...r, sources }
}

export async function explainPassage(
  p: AiProvider, doc: DocIndex, selection: string, page: number, ctx: PromptContext, send: StreamTransport,
  hooks: TaskHooks & { k?: number } = {},
): Promise<TaskResult> {
  const k = hooks.k ?? 4
  const hits = retrieve(doc.index, selection, k + 2).map((h) => h.chunk)
  // the passage's own page always comes first
  const own = doc.index.chunks.filter((c) => c.page === page && c.text.includes(selection.trim().slice(0, 40)))
  const chunks = [...own.slice(0, 1), ...hits.filter((c) => !own.slice(0, 1).includes(c))].slice(0, k)
  const r = await runChat(p, buildExplainMessages({ ...ctx, selection, page, chunks }), send, hooks)
  return { ...r, sources: uniqPages(chunks) }
}

export async function summarizePage(
  p: AiProvider, doc: DocIndex, page: number, ctx: PromptContext, send: StreamTransport, hooks: TaskHooks = {},
): Promise<TaskResult> {
  const text = doc.pages.find((x) => x.page === page)?.text ?? ''
  if (!cleanText(text)) return { error: { code: 'empty', message: 'this page has no text' }, sources: [] }
  const r = await runChat(p, buildPageSummaryMessages({ ...ctx, page, text }), send, hooks)
  return { ...r, sources: [page] }
}

/**
 * Whole-document summary. Fits in one call → one call. Otherwise map-reduce:
 * notes per group of pages (not streamed — progress instead), then one
 * streamed call that merges the notes, citations carried through.
 */
export async function summarizeDocument(
  p: AiProvider, doc: DocIndex, ctx: PromptContext, send: StreamTransport,
  hooks: TaskHooks & { budgetChars?: number; callChars?: number } = {},
): Promise<TaskResult> {
  const plan = planSummary(doc.pages, { budgetChars: hooks.budgetChars, callChars: hooks.callChars })
  const sources = [...new Set(plan.groups.flat().map((x) => x.page))]
  if (!plan.groups.length) return { error: { code: 'empty', message: 'the document has no text' }, sources }
  if (plan.groups.length === 1) {
    hooks.onProgress?.(0, 1)
    const r = await runChat(p, buildDocSummaryMessages({ ...ctx, group: plan.groups[0], truncated: plan.truncated }), send, hooks)
    hooks.onProgress?.(1, 1)
    return { ...r, sources, truncated: plan.truncated }
  }
  const total = plan.groups.length + 1
  const partials: string[] = []
  for (let i = 0; i < plan.groups.length; i++) {
    hooks.onProgress?.(i, total)
    const r = await runChat(
      p, buildMapMessages({ ...ctx, group: plan.groups[i], part: i + 1, parts: plan.groups.length }), send,
      { signal: hooks.signal },
    )
    if (r.error) return { error: r.error, sources, truncated: plan.truncated }
    partials.push(r.text)
  }
  hooks.onProgress?.(plan.groups.length, total)
  const r = await runChat(p, buildReduceMessages({ ...ctx, partials }), send, hooks)
  hooks.onProgress?.(total, total)
  return { ...r, sources, truncated: plan.truncated }
}

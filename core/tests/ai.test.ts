import { describe, it, expect } from 'vitest'
import {
  chunkPages, tokenize, buildIndex, searchChunks, retrieve, parseCitations, citedPages, linkCitations,
  sidecarSafe, stripThinking, ChatStreamParser, classifyChatError, chatRequest, planSummary,
  buildAskMessages, runChat, summarizeDocument, askDocument, indexDocument, isLocalEndpoint, textFromItems,
  type StreamTransport, type PageText,
} from '../src/ai.js'
import { buildProviderRequest } from '../src/translate.js'

describe('chunking', () => {
  it('keeps one chunk per short page and never spans pages', () => {
    const chunks = chunkPages([
      { page: 1, text: 'Alpha page.' },
      { page: 2, text: '' },
      { page: 3, text: 'Gamma page.' },
    ])
    expect(chunks.map((c) => [c.page, c.text])).toEqual([[1, 'Alpha page.'], [3, 'Gamma page.']])
    expect(chunks.map((c) => c.id)).toEqual([0, 1])
  })

  it('splits a long page at sentence boundaries with overlap', () => {
    const sentence = (i: number) => `Sentence number ${i} talks about topic ${i}.`
    const text = Array.from({ length: 60 }, (_, i) => sentence(i)).join(' ')
    const chunks = chunkPages([{ page: 7, text }], { maxChars: 300, overlap: 60 })
    expect(chunks.length).toBeGreaterThan(5)
    for (const c of chunks) {
      expect(c.page).toBe(7)
      expect(c.text.length).toBeLessThanOrEqual(300)
    }
    // every sentence survives somewhere
    for (let i = 0; i < 60; i++) expect(chunks.some((c) => c.text.includes(sentence(i)))).toBe(true)
    // cut on a sentence end, not mid-word
    expect(chunks[0].text.endsWith('.')).toBe(true)
  })

  it('terminates on text without any break opportunity', () => {
    const chunks = chunkPages([{ page: 1, text: 'x'.repeat(5000) }], { maxChars: 1000, overlap: 100 })
    expect(chunks.length).toBeGreaterThanOrEqual(5)
    expect(chunks.length).toBeLessThan(10)
  })

  it('re-joins hyphenated line breaks and normalises NFKC', () => {
    const [c] = chunkPages([{ page: 1, text: 'docu-\nment ＡＢＣ' }])
    expect(c.text).toBe('document ABC')
  })

  it('joins pdf.js text items like the CLI', () => {
    expect(textFromItems([{ str: 'a' }, { str: 'b', hasEOL: true }, {}, { str: 'c' }])).toBe('ab\nc')
  })
})

describe('tokenizer', () => {
  it('lower-cases, stems and drops stop-words', () => {
    expect(tokenize('The Studies of PAGES and the page')).toEqual(['study', 'page', 'page'])
  })

  it('turns CJK runs into bigrams', () => {
    expect(tokenize('损失函数')).toEqual(['损失', '失函', '函数'])
    expect(tokenize('图 3')).toEqual(['图', '3'])
  })

  it('handles mixed scripts', () => {
    const t = tokenize('BM25 排序 works')
    expect(t).toContain('bm25')
    expect(t).toContain('排序')
    expect(t).toContain('work')
  })
})

describe('BM25 ranking', () => {
  const pages: PageText[] = [
    { page: 1, text: 'Introduction. This paper is about reading documents at scale.' },
    { page: 2, text: 'The loss function is the squared error summed over the training set.' },
    { page: 3, text: '系统由三部分组成：编码器、核心和解码器。损失函数见公式 (2)。' },
    { page: 4, text: 'References. A survey of PDF viewers. Hyperlinks considered helpful.' },
  ]
  const index = buildIndex(chunkPages(pages))

  it('finds the page that answers an English question', () => {
    const hits = searchChunks(index, 'How is the loss function defined?', 2)
    expect(hits[0].chunk.page).toBe(2)
  })

  it('finds Chinese text through bigrams', () => {
    const hits = searchChunks(index, '系统有哪几部分？', 2)
    expect(hits[0].chunk.page).toBe(3)
    expect(searchChunks(index, '损失函数', 4).map((h) => h.chunk.page)).toContain(3)
  })

  it('rare terms outweigh common ones', () => {
    const idx = buildIndex(chunkPages([
      { page: 1, text: 'common common common' },
      { page: 2, text: 'common rare filler' },
      { page: 3, text: 'common filler filler' },
    ]))
    const hits = searchChunks(idx, 'common rare', 3)
    expect(hits[0].chunk.page).toBe(2)
    expect(hits).toHaveLength(3)
  })

  it('returns nothing for unrelated words, retrieve falls back to the opening', () => {
    expect(searchChunks(index, 'zebra', 3)).toEqual([])
    expect(retrieve(index, 'zebra', 2).map((h) => h.chunk.page)).toEqual([1, 2])
  })

  it('caps at k', () => {
    expect(searchChunks(index, 'the paper loss survey 系统', 2)).toHaveLength(2)
  })
})

describe('citations', () => {
  it('parses the forms models produce', () => {
    const segs = parseCitations('A [p.3] B [p. 4] C [pp. 5-6] D [p.7, p.9] E 【p.8】 F [page 2] G [p3; 1]', 20)
    const cites = segs.filter((s) => s.type === 'cite').map((s) => (s as { pages: number[] }).pages)
    expect(cites).toEqual([[3], [4], [5, 6], [7, 9], [8], [2], [3, 1]])
    expect(segs[0]).toEqual({ type: 'text', text: 'A ' })
  })

  it('leaves out-of-range and non-citation brackets as text', () => {
    const segs = parseCitations('see [p.99] and [1] and [0, 1]', 10)
    expect(segs).toEqual([{ type: 'text', text: 'see [p.99] and [1] and [0, 1]' }])
  })

  it('keeps the valid pages of a partly hallucinated list', () => {
    expect(citedPages('x [p.2, p.40] y [p.2]', 10)).toEqual([2])
  })

  it('caps runaway ranges', () => {
    expect(citedPages('[pp. 1-500]', 1000)).toHaveLength(20)
  })

  it('rewrites citations as links for the sidecar note', () => {
    expect(linkCitations('Fact [p.2, p.3].', (p) => `solopdf://open?page=${p}`, 5))
      .toBe('Fact [p.2](solopdf://open?page=2) [p.3](solopdf://open?page=3).')
  })
})

describe('sidecar safety', () => {
  it('neutralises headings, quotes and comments', () => {
    const md = '## Heading\nText\n> quoted\n<!-- solopdf:anchor x {} -->\n# Big #'
    expect(sidecarSafe(md)).toBe('**Heading**\nText\n\\> quoted\n\n**Big**')
  })
})

describe('stream parsing', () => {
  it('assembles SSE deltas across arbitrary splits', () => {
    const sse =
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      ': keep-alive\n\n' +
      'data: {"choices":[{"delta":{"content":"lo [p.1]"}}]}\r\n\r\n' +
      'data: [DONE]\n\n'
    for (const size of [1, 3, 7, 1000]) {
      const p = new ChatStreamParser()
      let out = ''
      for (let i = 0; i < sse.length; i += size) out += p.push(sse.slice(i, i + size))
      out += p.end()
      expect(out).toBe('Hello [p.1]')
      expect(p.done).toBe(true)
    }
  })

  it('accepts a plain JSON body when the server ignores stream:true', () => {
    const p = new ChatStreamParser()
    expect(p.push('{"choices":[{"message":{"content":"Whole answer"}}]}')).toBe('')
    expect(p.end()).toBe('Whole answer')
  })

  it('reports an error streamed instead of tokens', () => {
    const p = new ChatStreamParser()
    p.push('data: {"error":{"message":"model not loaded"}}\n\n')
    expect(p.error).toBe('model not loaded')
  })

  it('hides a reasoning scratchpad, also while it is still open', () => {
    expect(stripThinking('<think>hmm</think>Answer')).toBe('Answer')
    expect(stripThinking('<think>still thinking')).toBe('')
  })
})

describe('errors', () => {
  it('classifies auth / model / other', () => {
    expect(classifyChatError(401, '{"error":{"message":"Incorrect API key"}}').code).toBe('auth')
    expect(classifyChatError(404, '{"error":{"message":"model \\"llama9\\" not found, try pulling it first"}}').code).toBe('model')
    expect(classifyChatError(400, '{"error":"No models loaded. Please load a model"}').code).toBe('model')
    const other = classifyChatError(404, '404 page not found')
    expect(other.code).toBe('http')
    expect(other.message).toContain('404')
  })
})

describe('requests', () => {
  it('builds an OpenAI-compatible streaming request without a key for localhost', () => {
    const r = chatRequest({ baseUrl: 'http://localhost:11434/v1/', model: 'qwen2.5' }, [{ role: 'user', content: 'hi' }])
    expect(r.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(r.headers).toEqual([])
    const body = JSON.parse(r.body)
    expect(body.stream).toBe(true)
    expect(body.model).toBe('qwen2.5')
  })

  it('shares URL/header logic with the translation provider', () => {
    const cfg = { kind: 'openai' as const, baseUrl: 'https://api.example.com/v1/chat/completions', apiKey: 'k', model: 'm' }
    const tr = buildProviderRequest(cfg, 'x', 'en')
    const ai = chatRequest({ baseUrl: cfg.baseUrl, apiKey: 'k', model: 'm' }, [])
    expect(ai.url).toBe(tr.url)
    expect(ai.headers).toEqual(tr.headers)
  })

  it('knows a local endpoint', () => {
    expect(isLocalEndpoint('http://localhost:1234/v1')).toBe(true)
    expect(isLocalEndpoint('http://127.0.0.1:11434/v1')).toBe(true)
    expect(isLocalEndpoint('https://api.openai.com/v1')).toBe(false)
  })

  it('puts excerpts in page order under [p.N] labels', () => {
    const msgs = buildAskMessages({
      docName: 'Doc', question: 'q?',
      chunks: [{ id: 1, page: 5, text: 'five' }, { id: 0, page: 2, text: 'two' }],
    })
    expect(msgs[1].content.indexOf('[p.2]')).toBeLessThan(msgs[1].content.indexOf('[p.5]'))
    expect(msgs[0].content).toContain('[p.12]')
  })
})

describe('summary planning', () => {
  const pages = Array.from({ length: 40 }, (_, i) => ({ page: i + 1, text: `Page ${i + 1}. ` + 'word '.repeat(400) }))

  it('fits the budget and keeps every page citable', () => {
    const plan = planSummary(pages, { budgetChars: 20000, callChars: 6000 })
    expect(plan.truncated).toBe(true)
    expect(plan.chars).toBeLessThanOrEqual(20000 + 40 * 4)
    expect(plan.groups.length).toBeGreaterThan(1)
    expect(plan.groups.flat().map((p) => p.page)).toEqual(pages.map((p) => p.page))
    for (const g of plan.groups) expect(g.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(6000)
  })

  it('a short document is one group, untruncated', () => {
    const plan = planSummary(pages.slice(0, 2), { budgetChars: 20000, callChars: 12000 })
    expect(plan.groups).toHaveLength(1)
    expect(plan.truncated).toBe(false)
  })

  it('samples pages when even the minimum per page would overshoot', () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ page: i + 1, text: 'x '.repeat(500) }))
    const plan = planSummary(many, { budgetChars: 10000, callChars: 5000 })
    expect(plan.chars).toBeLessThanOrEqual(10000)
  })
})

/** fake transport: replies from a function of the request, streamed in pieces */
function fakeTransport(reply: (body: any) => { status?: number; text: string }, calls: any[] = []): StreamTransport {
  return async (req, signal) => {
    const body = JSON.parse(req.body)
    calls.push(body)
    const r = reply(body)
    const status = r.status ?? 200
    const pieces = status === 200
      ? r.text.split(/(?<= )/).map((w) => `data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`).concat('data: [DONE]\n\n')
      : [r.text]
    return {
      status,
      chunks: (async function* () {
        for (const p of pieces) {
          if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
          await Promise.resolve()
          yield p
        }
      })(),
    }
  }
}

const P = { baseUrl: 'http://localhost:9/v1', model: 'mock' }

describe('runChat / tasks', () => {
  it('streams text and returns it', async () => {
    const seen: string[] = []
    const r = await runChat(P, [], fakeTransport(() => ({ text: 'one two three' })), { onText: (t) => seen.push(t) })
    expect(r.text).toBe('one two three')
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[seen.length - 1]).toBe('one two three')
  })

  it('reports HTTP errors and network failures', async () => {
    const r = await runChat(P, [], fakeTransport(() => ({ status: 401, text: '{"error":{"message":"bad key"}}' })))
    expect(r.error?.code).toBe('auth')
    const n = await runChat(P, [], async () => { throw new TypeError('fetch failed') })
    expect(n.error?.code).toBe('network')
    const c = await runChat({ baseUrl: '', model: '' }, [], fakeTransport(() => ({ text: 'x' })))
    expect(c.error?.code).toBe('config')
  })

  it('cancels', async () => {
    const ac = new AbortController()
    const r = await runChat(P, [], fakeTransport(() => ({ text: 'a b c d e f g' })), {
      signal: ac.signal,
      onText: (t) => { if (t.length > 3) ac.abort() },
    })
    expect(r.error?.code).toBe('cancelled')
  })

  it('asks with retrieved excerpts only', async () => {
    const doc = indexDocument([
      { page: 1, text: 'Cats are mammals.' },
      { page: 2, text: 'Rockets burn fuel.' },
      { page: 3, text: 'Dogs are mammals too.' },
    ])
    const calls: any[] = []
    const r = await askDocument(P, doc, 'Which animals are mammals?', { docName: 'D' },
      fakeTransport(() => ({ text: 'Cats [p.1] and dogs [p.3].' }), calls), { k: 2 })
    expect(r.sources).toEqual([1, 3])
    expect(calls[0].messages[1].content).not.toContain('Rockets')
    expect(citedPages(r.text!, 3)).toEqual([1, 3])
  })

  it('map-reduces a long document with progress', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({ page: i + 1, text: `Topic ${i + 1}. ` + 'lorem '.repeat(300) }))
    const doc = indexDocument(pages)
    const calls: any[] = []
    const progress: [number, number][] = []
    const r = await summarizeDocument(P, doc, { docName: 'D', lang: 'en' }, fakeTransport((b) => {
      const sys = b.messages[0].content as string
      return { text: sys.startsWith('Below are notes') ? 'Overall [p.1] [p.12]' : 'note [p.2]' }
    }, calls), { budgetChars: 20000, callChars: 5000, onProgress: (d, t) => progress.push([d, t]) })
    expect(r.text).toBe('Overall [p.1] [p.12]')
    expect(calls.length).toBeGreaterThan(2)
    expect(calls[calls.length - 1].messages[1].content).toContain('## Part 1')
    expect(progress[progress.length - 1][0]).toBe(progress[progress.length - 1][1])
  })
})

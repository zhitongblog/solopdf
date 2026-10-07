#!/usr/bin/env node
/**
 * A tiny OpenAI-compatible chat server for testing Ask AI without a model.
 *
 *   node scripts/mock-llm.mjs [--port 11435] [--key secret] [--delay 40]
 *
 *   GET  /v1/models              → { data: [{ id: 'mock' }, { id: 'mock-slow' }] }
 *   POST /v1/chat/completions    → SSE stream (stream: true) or one JSON body
 *   GET  /__last                 → the last chat request body (what was sent)
 *   GET  /__count                → number of chat requests served
 *
 * It "answers" from the excerpts it is given, so the reply depends on what
 * retrieval sent: it quotes the first sentence of the best-matching [p.N]
 * excerpt and cites it — enough to check citations, streaming and
 * map-reduce end to end. Model "mock-slow" streams slowly (cancel tests);
 * any other unknown model gets the 404 Ollama sends; with --key, a wrong
 * Bearer token gets 401. CORS is open so the web build can call it.
 */
import http from 'node:http'

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : process.env['MOCK_' + name.toUpperCase()] ?? dflt
}
const PORT = parseInt(arg('port', '11435'), 10)
const KEY = arg('key', '')
const DELAY = parseInt(arg('delay', '40'), 10)
const MODELS = ['mock', 'mock-slow']

let last = null
let count = 0

/** "[p.N]\ntext" blocks out of a prompt */
function excerpts(content) {
  const out = []
  const re = /\[p\.(\d+)\]\n([\s\S]*?)(?=\n\n---\n\n|\n\n===|\n\n## |$)/g
  for (const m of content.matchAll(re)) out.push({ page: +m[1], text: m[2].trim() })
  return out
}

const firstSentence = (t) => (t.replace(/\s+/g, ' ').match(/^.{10,200}?[.!?。！？](\s|$)/)?.[0] ?? t.replace(/\s+/g, ' ').slice(0, 140)).trim()
const words = (s) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}|[\p{Script=Han}]/gu) ?? [])

function answer(messages) {
  const sys = messages.find((m) => m.role === 'system')?.content ?? ''
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
  if (sys.startsWith('Below are notes')) {
    // reduce: keep the citations the notes carried
    const cites = [...new Set(user.match(/\[p\.\d+\]/g) ?? [])]
    return `Overview of the document ${cites[0] ?? ''}.\n` +
      cites.map((c, i) => `- Point ${i + 1} from the notes ${c}`).join('\n')
  }
  const ex = excerpts(user)
  if (!ex.length) return 'The excerpts do not contain the answer.'
  if (/^You are reading part/.test(sys)) {
    return ex.slice(0, 3).map((e) => `- ${firstSentence(e.text)} [p.${e.page}]`).join('\n')
  }
  if (/^Summari[sz]e/.test(sys)) {
    const head = `This document covers ${ex.length} section(s) [p.${ex[0].page}].`
    return head + '\n' + ex.slice(0, 6).map((e) => `- **p.${e.page}**: ${firstSentence(e.text)} [p.${e.page}]`).join('\n')
  }
  if (/Passage to explain/.test(user)) {
    const passage = user.split('"""')[1]?.trim() ?? ''
    const own = user.match(/from \[p\.(\d+)\]/)?.[1]
    return `The passage “${passage.slice(0, 60)}” means what it says in context [p.${own ?? ex[0].page}].\n` +
      `Related: ${firstSentence(ex[ex.length - 1].text)} [p.${ex[ex.length - 1].page}]`
  }
  const q = user.split('Question:').pop() ?? ''
  const qw = words(q)
  const scored = ex.map((e) => ({ e, s: [...words(e.text)].filter((w) => qw.has(w)).length }))
    .sort((a, b) => b.s - a.s)
  const best = scored[0].e
  const second = scored[1]?.e
  return `According to the document, ${firstSentence(best.text)} [p.${best.page}]` +
    (second ? `\n\nSee also: ${firstSentence(second.text)} [p.${second.page}]` : '')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  const url = new URL(req.url, 'http://x')
  if (req.method === 'GET' && url.pathname === '/__last') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(last))
    return
  }
  if (req.method === 'GET' && url.pathname === '/__count') { res.end(String(count)); return }
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }))
    return
  }
  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('404 page not found')
    return
  }
  let raw = ''
  for await (const c of req) raw += c
  let body
  try { body = JSON.parse(raw) } catch { res.writeHead(400); res.end('{"error":{"message":"bad json"}}'); return }
  last = body
  count++
  process.stderr.write(`[mock-llm] #${count} model=${body.model} stream=${body.stream} chars=${raw.length}\n`)
  if (KEY && req.headers.authorization !== `Bearer ${KEY}`) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }))
    return
  }
  if (!MODELS.includes(body.model)) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `model "${body.model}" not found, try pulling it first` } }))
    return
  }
  const text = answer(body.messages ?? [])
  if (!body.stream) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const delay = body.model === 'mock-slow' ? Math.max(DELAY, 250) : DELAY
  let closed = false
  res.on('close', () => { closed = true })
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  send({ choices: [{ index: 0, delta: { role: 'assistant' } }] })
  for (const piece of text.split(/(?<=\s)/)) {
    if (closed) { process.stderr.write('[mock-llm] client went away mid-stream\n'); return }
    await sleep(delay)
    send({ choices: [{ index: 0, delta: { content: piece } }] })
  }
  send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  res.write('data: [DONE]\n\n')
  res.end()
})

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[mock-llm] http://127.0.0.1:${PORT}/v1  models=${MODELS.join(',')}${KEY ? ' (key required)' : ''}\n`)
})

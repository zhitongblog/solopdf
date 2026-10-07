/**
 * Document compare — text-based, the same algorithm for the app (viewer
 * highlights + change list) and the CLI/MCP (change list as JSON).
 *
 * Input is what pdf.js hands out: per page, the text items (`str`, `hasEOL`)
 * in content-stream order, with non-text marked-content entries already
 * dropped (the same filter the viewer applies, so item indices line up with
 * its text geometry). Output spans point back into those items, so the app
 * can turn a change into rectangles without re-tokenizing anything.
 *
 * Pipeline:
 *   1. tokenize every page — words for alphabetic scripts, ONE token per
 *      Han / kana character (CJK has no spaces, so word-level = char-level),
 *      punctuation as its own token, whitespace dropped (re-wrapped lines
 *      and doubled spaces are not changes). Keys are NFKC-normalized.
 *   2. align pages by text similarity (Dice over token bigrams, banded DP):
 *      a page that exists on one side only becomes an inserted / deleted
 *      page instead of shifting every later page out of step.
 *   3. diff each run of matched pages as ONE token stream (Myers O(ND)), so
 *      a paragraph that reflowed onto the next page is not a change; a run
 *      too different for the edit budget falls back to page-by-page, then
 *      to "whole page changed".
 *   4. group edits into hunks, merging hunks split by a lone common token
 *      ("thirty (30)" → "fifteen (15)" is one change, not two), classify as
 *      insert / delete / change.
 *
 * Printed page numbers (a bare number equal to the page index at the top or
 * bottom of a page) are ignored: they all shift after an inserted page.
 *
 * Pages with no text at all (scans without an OCR layer) cannot be compared
 * and are reported in `noText` — never silently treated as "unchanged".
 */

export interface CompareItem {
  str: string
  hasEOL?: boolean
}
/** one page = its text items, in pdf.js order */
export type ComparePage = CompareItem[]

/** a run of characters inside one text item: str.slice(from, to) */
export interface CompareSpan {
  /** 1-based page */
  page: number
  /** index into that page's items */
  item: number
  from: number
  to: number
}

export interface CompareSide {
  /** page the change starts on (or, for the empty side, where it would be) */
  page: number
  /** the affected text as it reads on this side ('' for the empty side) */
  text: string
  spans: CompareSpan[]
  /** empty side of an insert/delete: the point where the text went missing
   *  (zero-width span), so the viewer can draw a caret there */
  at?: CompareSpan
}

export type ChangeKind = 'insert' | 'delete' | 'change'

export interface CompareChange {
  /** 1-based, in reading order of the new document */
  id: number
  kind: ChangeKind
  /** old document (A) */
  a: CompareSide
  /** new document (B) */
  b: CompareSide
  /** a whole page that only exists in B (1-based B page) */
  pageInserted?: number
  /** a whole page that only exists in A (1-based A page) */
  pageDeleted?: number
}

export interface PagePair {
  a: number | null
  b: number | null
  /** 0–1 text similarity of the pair (0 for unmatched pages) */
  similarity: number
}

export interface CompareResult {
  pagesA: number
  pagesB: number
  /** page alignment, in order; a null side = page exists only on the other */
  pairs: PagePair[]
  changes: CompareChange[]
  /** pages with no text layer — they can't be compared by text */
  noTextA: number[]
  noTextB: number[]
  stats: {
    inserted: number
    deleted: number
    changed: number
    insertedPages: number
    deletedPages: number
  }
}

export interface CompareOptions {
  /** minimum similarity for two pages to be considered the same page */
  pageThreshold?: number
  /** edit budget for one diff (bigger runs fall back page by page) */
  maxEdits?: number
}

// ── tokenizer ────────────────────────────────────────────────────────────

export interface Token {
  /** text as it appears in the document */
  text: string
  /** comparison key (NFKC) */
  key: string
  page: number
  /** whitespace (or a line break) separated it from the previous token */
  space: boolean
  /** [item, from, to] runs — a token can straddle two adjacent text items */
  segs: [number, number, number][]
}

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々〆ー]/u
const WORD_RE = /[\p{L}\p{N}\p{M}_]/u
const JOINER_RE = /['’\-.,]/
const SPACE_RE = /\s/
const ASCII_RE = /^[\x00-\x7f]*$/

type CharClass = 0 | 1 | 2 | 3 // space | cjk | word | punct

/** BMP classes, filled lazily — regex property tests per char are the hot
 *  spot of tokenizing a 1000-page document */
const BMP_CLASS = new Int8Array(0x10000).fill(-1)

function classOf(ch: string): CharClass {
  const code = ch.length === 1 ? ch.charCodeAt(0) : -1
  if (code >= 0) {
    const c = BMP_CLASS[code]
    if (c >= 0) return c as CharClass
  }
  const cls: CharClass = SPACE_RE.test(ch) ? 0 : CJK_RE.test(ch) ? 1 : WORD_RE.test(ch) ? 2 : 3
  if (code >= 0) BMP_CLASS[code] = cls
  return cls
}

/**
 * Page items → tokens. Items are joined as pdf.js emits them (it supplies
 * its own space items) plus a line break after `hasEOL`; two runs that touch
 * with no space form one word — identically on both sides of a compare.
 */
export function tokenizePage(items: ComparePage, page: number): Token[] {
  const out: Token[] = []
  let space = true
  // the word under construction
  let wText = ''
  let wSegs: [number, number, number][] = []
  const addSeg = (segs: [number, number, number][], it: number, from: number, to: number): void => {
    const last = segs[segs.length - 1]
    if (last && last[0] === it && last[2] === from) last[2] = to
    else segs.push([it, from, to])
  }
  const emit = (text: string, segs: [number, number, number][]): void => {
    // NFKC only matters outside ASCII
    const key = ASCII_RE.test(text) ? text : text.normalize('NFKC')
    out.push({ text, key, page, space, segs })
    space = false
  }
  const flushWord = (): void => {
    if (!wText) return
    emit(wText, wSegs)
    wText = ''
    wSegs = []
  }
  /** class of the character after (i, k), across item boundaries */
  const nextClass = (i: number, k: number): CharClass => {
    for (let j = i; j < items.length; j++) {
      const str = items[j].str ?? ''
      const at = j === i ? k : 0
      if (at < str.length) return classOf(str[at])
      if (items[j].hasEOL) return 0
    }
    return 0
  }
  for (let i = 0; i < items.length; i++) {
    const str = items[i].str ?? ''
    for (let k = 0; k < str.length; k++) {
      let ch = str[k]
      const c = str.charCodeAt(k)
      // keep surrogate pairs together (CJK Extension B and up)
      if (c >= 0xd800 && c <= 0xdbff && k + 1 < str.length) ch = str.slice(k, k + 2)
      const end = k + ch.length
      const cls = classOf(ch)
      if (cls === 0) {
        flushWord()
        space = true
      } else if (cls === 2) {
        wText += ch
        addSeg(wSegs, i, k, end)
      } else if (cls === 3 && wText && JOINER_RE.test(ch) && nextClass(i, end) === 2) {
        // a joiner between two word characters stays inside the word:
        // don't, e-mail, 1,000.50, U.S.
        wText += ch
        addSeg(wSegs, i, k, end)
      } else {
        // CJK character or punctuation: a token of its own
        flushWord()
        emit(ch, [[i, k, end]])
      }
      k = end - 1
    }
    if (items[i].hasEOL) {
      flushWord()
      space = true
    }
  }
  flushWord()
  return out
}

/**
 * Drop a printed page number: a bare number equal to the page's own index,
 * first or last on the page (header / footer), standing alone in its text
 * item — "3  Confidentiality" opening page 3 is a heading, not a folio.
 * After an inserted page every later footer is off by one; reporting each
 * as a change would bury the real ones.
 */
export function stripPageNumber(tokens: Token[], page: number, items: ComparePage): Token[] {
  const n = String(page)
  const isFolio = (t: Token | undefined): boolean =>
    !!t && t.key === n && t.segs.length === 1 && (items[t.segs[0][0]]?.str ?? '').trim() === t.text
  let lo = 0
  let hi = tokens.length
  if (hi > 1 && isFolio(tokens[hi - 1])) hi--
  if (hi - lo > 1 && isFolio(tokens[0])) lo++
  return lo === 0 && hi === tokens.length ? tokens : tokens.slice(lo, hi)
}

/** the text of a token run as it reads (spaces where the document had them) */
export function tokensText(tokens: Token[]): string {
  let s = ''
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0 && (tokens[i].space || tokens[i].page !== tokens[i - 1].page)) s += ' '
    s += tokens[i].text
  }
  return s
}

// ── page alignment ───────────────────────────────────────────────────────

/** sorted unique bigram ids of a page (unigrams for very short pages) */
function shingles(tokens: Token[], intern: (k: string) => number): Float64Array {
  const ids: number[] = []
  if (tokens.length < 3) for (const t of tokens) ids.push(intern(t.key))
  else {
    let prev = intern(tokens[0].key)
    for (let i = 1; i < tokens.length; i++) {
      const cur = intern(tokens[i].key)
      ids.push(prev * 0x200000 + cur + 1) // + 1: never collides with a unigram id
      prev = cur
    }
  }
  const arr = Float64Array.from(ids).sort()
  let w = 0
  for (let r = 0; r < arr.length; r++) if (r === 0 || arr[r] !== arr[r - 1]) arr[w++] = arr[r]
  return arr.subarray(0, w)
}

/** Dice coefficient of two sorted unique shingle arrays */
export function pageSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a.length && !b.length) return 0
  let i = 0
  let j = 0
  let common = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { common++; i++; j++ } else if (a[i] < b[j]) i++
    else j++
  }
  return (2 * common) / (a.length + b.length)
}

/**
 * Order-preserving page alignment maximizing total similarity. Two pages
 * pair up only above `threshold`; two text-less pages pair by position (we
 * can't tell scans apart, and "both unchanged, both uncomparable" is the
 * honest reading). Banded around the diagonal so a 2000-page pair stays
 * cheap.
 */
export function alignPages(a: Token[][], b: Token[][], threshold = 0.2): PagePair[] {
  const n = a.length
  const m = b.length
  const ids = new Map<string, number>()
  const intern = (k: string): number => {
    let v = ids.get(k)
    if (v === undefined) { v = ids.size; ids.set(k, v) }
    return v
  }
  const sa = a.map((t) => shingles(t, intern))
  const sb = b.map((t) => shingles(t, intern))
  const band = Math.max(12, Math.abs(n - m) + 12)
  const sim = (i: number, j: number): number => {
    const expected = n ? (i * m) / n : 0
    if (Math.abs(j - expected) > band) return -1
    if (!a[i].length && !b[j].length) return 0.5
    if (!a[i].length || !b[j].length) return -1
    const s = pageSimilarity(sa[i], sb[j])
    return s >= threshold ? s : -1
  }
  // score[(i)*(m+1)+j] = best total over a[0..i), b[0..j)
  const W = m + 1
  const score = new Float64Array((n + 1) * W)
  const move = new Uint8Array((n + 1) * W) // 1 diag, 2 up (skip a), 3 left (skip b)
  const sims = new Float32Array(n * m).fill(-1)
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue
      // outside the band only gaps are possible: keep it a cheap copy
      if (i > 0 && j > 0 && Math.abs(j - 1 - (n ? ((i - 1) * m) / n : 0)) > band) {
        const up = score[(i - 1) * W + j]
        const left = score[i * W + (j - 1)]
        if (up >= left) { score[i * W + j] = up; move[i * W + j] = 2 } else { score[i * W + j] = left; move[i * W + j] = 3 }
        continue
      }
      let best = -Infinity
      let mv = 0
      if (i > 0 && j > 0) {
        const s = sim(i - 1, j - 1)
        sims[(i - 1) * m + (j - 1)] = s
        if (s >= 0) {
          const v = score[(i - 1) * W + (j - 1)] + s + 1e-6 // tiny bonus: prefer pairing
          if (v > best) { best = v; mv = 1 }
        }
      }
      if (i > 0) {
        const v = score[(i - 1) * W + j]
        if (v > best) { best = v; mv = 2 }
      }
      if (j > 0) {
        const v = score[i * W + (j - 1)]
        if (v > best) { best = v; mv = 3 }
      }
      score[i * W + j] = best
      move[i * W + j] = mv
    }
  }
  const pairs: PagePair[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const mv = move[i * W + j]
    if (mv === 1) {
      const s = sims[(i - 1) * m + (j - 1)]
      pairs.push({ a: i, b: j, similarity: Math.round(Math.max(0, s) * 1000) / 1000 })
      i--; j--
    } else if (mv === 2) {
      pairs.push({ a: i, b: null, similarity: 0 })
      i--
    } else {
      pairs.push({ a: null, b: j, similarity: 0 })
      j--
    }
  }
  pairs.reverse()
  // an unmatched A page and an unmatched B page that sit in the same gap and
  // are listed delete-then-insert read better insert-after-delete; keep the
  // DP's order but put B-only pages after A-only pages within a gap
  for (let k = 0; k + 1 < pairs.length; k++) {
    if (pairs[k].a === null && pairs[k + 1].b === null) {
      const t = pairs[k]; pairs[k] = pairs[k + 1]; pairs[k + 1] = t
      if (k > 0) k -= 2
    }
  }
  return pairs
}

// ── token diff (Myers) ───────────────────────────────────────────────────

/** 0 = equal, 1 = delete (a only), 2 = insert (b only) */
export type DiffOp = 0 | 1 | 2

/**
 * Minimal edit script between two int sequences, as ops in order.
 * Returns null when more than `maxD` edits would be needed (caller falls
 * back to a coarser comparison). Memory O(D²), time O((N+M)·D).
 */
export function diffSequences(a: ArrayLike<number>, b: ArrayLike<number>, maxD = 4000): DiffOp[] | null {
  const n0 = a.length
  const m0 = b.length
  // common prefix / suffix are free and usually most of the document
  let pre = 0
  while (pre < n0 && pre < m0 && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < n0 - pre && suf < m0 - pre && a[n0 - 1 - suf] === b[m0 - 1 - suf]) suf++
  const n = n0 - pre - suf
  const m = m0 - pre - suf
  const A = (x: number): number => a[pre + x]
  const B = (y: number): number => b[pre + y]
  const mid: DiffOp[] = []
  if (n === 0 || m === 0) {
    for (let k = 0; k < n; k++) mid.push(1)
    for (let k = 0; k < m; k++) mid.push(2)
  } else {
    const max = n + m
    const off = max + 1
    const v = new Int32Array(2 * max + 3)
    const trace: Int32Array[] = []
    let found = -1
    const limit = Math.min(max, maxD)
    outer: for (let d = 0; d <= limit; d++) {
      // snapshot of k ∈ [-d-1, d+1] before this round (what backtracking needs)
      trace.push(v.slice(off - d - 1, off + d + 2))
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
        let y = x - k
        while (x < n && y < m && A(x) === B(y)) { x++; y++ }
        v[off + k] = x
        if (x >= n && y >= m) { found = d; break outer }
      }
    }
    if (found < 0) return null
    // backtrack
    const rev: DiffOp[] = []
    let x = n
    let y = m
    for (let d = found; d > 0; d--) {
      const snap = trace[d]
      const at = (k: number): number => snap[k + d + 1]
      const k = x - y
      const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
      const prevX = at(prevK)
      const prevY = prevX - prevK
      while (x > prevX && y > prevY) { rev.push(0); x--; y-- }
      if (x === prevX) { rev.push(2); y-- } else { rev.push(1); x-- }
    }
    while (x > 0 && y > 0) { rev.push(0); x--; y-- }
    rev.reverse()
    for (const o of rev) mid.push(o) // no spread: rev can be 100k+ long
  }
  const ops: DiffOp[] = new Array(pre).fill(0)
  for (const o of mid) ops.push(o)
  for (let k = 0; k < suf; k++) ops.push(0)
  return ops
}

// ── hunks → changes ──────────────────────────────────────────────────────

interface Hunk {
  /** token index ranges [from, to) into the run's token arrays */
  a0: number; a1: number
  b0: number; b1: number
  /** at least one token was deleted / inserted (merged eq tokens don't count) */
  dels: number; ins: number
}

/**
 * A pure insertion / deletion is often ambiguous: deleting "remedy ." before
 * an equal "." is the same edit as deleting ". remedy" after it. Slide such
 * runs as far forward as they go, so a removed sentence carries its own full
 * stop and starts at its first word (". 2.3 Late …" → "2.3 Late … remedy.").
 */
export function slideEdits(ops: DiffOp[], a: ArrayLike<number>, b: ArrayLike<number>): DiffOp[] {
  const out = ops.slice()
  let x = 0
  let y = 0
  let i = 0
  while (i < out.length) {
    const o = out[i]
    if (o === 0) { x++; y++; i++; continue }
    let j = i
    while (j < out.length && out[j] === o) j++
    const pure = (i === 0 || out[i - 1] === 0) && (j === out.length || out[j] === 0)
    if (pure) {
      const seq = o === 1 ? a : b
      const len = j - i
      let start = o === 1 ? x : y
      while (j < out.length && out[j] === 0 && seq[start] === seq[start + len]) {
        // D(s) … E  →  E D(s+1) …: the equal op moves in front of the run
        out[i] = 0
        out[j] = o
        i++; j++; start++
        x++; y++
      }
    }
    if (o === 1) x += j - i; else y += j - i
    i = j
  }
  return out
}

function hunksOf(ops: DiffOp[], aTok: Token[]): Hunk[] {
  const raw: Hunk[] = []
  let x = 0
  let y = 0
  let cur: Hunk | null = null
  for (const o of ops) {
    if (o === 0) {
      if (cur) { raw.push(cur); cur = null }
      x++; y++
      continue
    }
    if (!cur) cur = { a0: x, a1: x, b0: y, b1: y, dels: 0, ins: 0 }
    if (o === 1) { x++; cur.a1 = x; cur.dels++ } else { y++; cur.b1 = y; cur.ins++ }
  }
  if (cur) raw.push(cur)
  // merge hunks split by a short run of common tokens, so a rewritten phrase
  // reads as one change ("thirty (30)" → "fifteen (15)")
  const merged: Hunk[] = []
  for (const h of raw) {
    const prev = merged[merged.length - 1]
    if (prev) {
      const gap = h.a0 - prev.a1 // equal-run length (same on both sides)
      const size = Math.max(prev.dels, prev.ins, h.dels, h.ins)
      const punctOnly = aTok.slice(prev.a1, h.a0).every((t) => classOf(t.key[0] ?? ' ') === 3)
      if (gap > 0 && ((gap <= 2 && gap <= size) || (punctOnly && gap <= 3))) {
        prev.a1 = h.a1; prev.b1 = h.b1
        prev.dels += h.dels; prev.ins += h.ins
        continue
      }
    }
    merged.push({ ...h })
  }
  return merged
}

function spansOf(tokens: Token[]): CompareSpan[] {
  const out: CompareSpan[] = []
  for (const t of tokens) {
    for (const [item, from, to] of t.segs) {
      const last = out[out.length - 1]
      // extend a span across tokens of the same item (covers the space too)
      if (last && last.page === t.page && last.item === item && from >= last.to && from - last.to <= 1) {
        last.to = to
      } else out.push({ page: t.page, item, from, to })
    }
  }
  return out
}

/** zero-width point after (or, at the start, before) a token */
function caretAt(tokens: Token[], index: number, fallbackPage: number): { page: number; at?: CompareSpan } {
  const after = tokens[index - 1]
  if (after) {
    const s = after.segs[after.segs.length - 1]
    if (s) return { page: after.page, at: { page: after.page, item: s[0], from: s[2], to: s[2] } }
    return { page: after.page }
  }
  const before = tokens[index]
  if (before) {
    const s = before.segs[0]
    if (s) return { page: before.page, at: { page: before.page, item: s[0], from: s[1], to: s[1] } }
    return { page: before.page }
  }
  return { page: fallbackPage }
}

const MAX_TEXT = 400
function clip(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT - 1) + '…' : s
}

function side(tokens: Token[], from: number, to: number, fallbackPage: number): CompareSide {
  if (to > from) {
    const run = tokens.slice(from, to)
    return { page: run[0].page, text: clip(tokensText(run)), spans: spansOf(run) }
  }
  const c = caretAt(tokens, from, fallbackPage)
  return { page: c.page, text: '', spans: [], ...(c.at ? { at: c.at } : {}) }
}

// ── driver ───────────────────────────────────────────────────────────────

export function compareDocuments(
  pagesA: ComparePage[],
  pagesB: ComparePage[],
  opts: CompareOptions = {},
): CompareResult {
  const threshold = opts.pageThreshold ?? 0.2
  const tokA = pagesA.map((p, i) => stripPageNumber(tokenizePage(p, i + 1), i + 1, p))
  const tokB = pagesB.map((p, i) => stripPageNumber(tokenizePage(p, i + 1), i + 1, p))
  const pairs = alignPages(tokA, tokB, threshold)

  // intern keys → ints once, shared by both sides
  const ids = new Map<string, number>()
  const idOf = (k: string): number => {
    let v = ids.get(k)
    if (v === undefined) { v = ids.size; ids.set(k, v) }
    return v
  }

  const changes: Omit<CompareChange, 'id'>[] = []
  // a budget for the whole compare: past it, diffs fall back page by page
  const maxD = opts.maxEdits ?? 4000

  /** last matched pages seen, to place a whole-page insert/delete */
  let lastA = 1
  let lastB = 1

  const diffRun = (aPages: number[], bPages: number[]): void => {
    const aTok = aPages.flatMap((p) => tokA[p - 1])
    const bTok = bPages.flatMap((p) => tokB[p - 1])
    const totalLen = aTok.length + bTok.length
    // keep worst-case work ~ 2e8 steps
    const budget = Math.max(200, Math.min(maxD, Math.floor(2e8 / Math.max(1, totalLen))))
    const aIds = aTok.map((t) => idOf(t.key))
    const bIds = bTok.map((t) => idOf(t.key))
    const raw = diffSequences(aIds, bIds, budget)
    const ops = raw && slideEdits(raw, aIds, bIds)
    if (ops) {
      for (const h of hunksOf(ops, aTok)) {
        const kind: ChangeKind = h.dels && h.ins ? 'change' : h.ins ? 'insert' : 'delete'
        const fallbackA = aPages[0] ?? lastA
        const fallbackB = bPages[0] ?? lastB
        changes.push({
          kind,
          a: side(aTok, h.a0, h.a1, fallbackA),
          b: side(bTok, h.b0, h.b1, fallbackB),
        })
      }
      return
    }
    if (aPages.length > 1 || bPages.length > 1) {
      // too different as one stream: compare page by page instead
      for (let k = 0; k < aPages.length; k++) diffRun([aPages[k]], [bPages[k]])
      return
    }
    // a single page pair beyond the budget: one change covering both pages
    changes.push({
      kind: 'change',
      a: side(aTok, 0, aTok.length, aPages[0]),
      b: side(bTok, 0, bTok.length, bPages[0]),
    })
  }

  let runA: number[] = []
  let runB: number[] = []
  const flushRun = (): void => {
    if (runA.length) diffRun(runA, runB)
    runA = []
    runB = []
  }
  for (const p of pairs) {
    if (p.a !== null && p.b !== null) {
      runA.push(p.a)
      runB.push(p.b)
      lastA = p.a
      lastB = p.b
      continue
    }
    flushRun()
    if (p.b !== null) {
      const toks = tokB[p.b - 1]
      changes.push({
        kind: 'insert',
        pageInserted: p.b,
        a: { page: lastA, text: '', spans: [] },
        b: toks.length
          ? { page: p.b, text: clip(tokensText(toks)), spans: spansOf(toks) }
          : { page: p.b, text: '', spans: [] },
      })
      lastB = p.b
    } else if (p.a !== null) {
      const toks = tokA[p.a - 1]
      changes.push({
        kind: 'delete',
        pageDeleted: p.a,
        a: toks.length
          ? { page: p.a, text: clip(tokensText(toks)), spans: spansOf(toks) }
          : { page: p.a, text: '', spans: [] },
        b: { page: lastB, text: '', spans: [] },
      })
      lastA = p.a
    }
  }
  flushRun()

  const numbered = changes.map((c, i) => ({ id: i + 1, ...c }))
  return {
    pagesA: pagesA.length,
    pagesB: pagesB.length,
    pairs,
    changes: numbered,
    noTextA: tokA.flatMap((t, i) => (t.length ? [] : [i + 1])),
    noTextB: tokB.flatMap((t, i) => (t.length ? [] : [i + 1])),
    stats: {
      inserted: numbered.filter((c) => c.kind === 'insert' && !c.pageInserted).length,
      deleted: numbered.filter((c) => c.kind === 'delete' && !c.pageDeleted).length,
      changed: numbered.filter((c) => c.kind === 'change').length,
      insertedPages: numbered.filter((c) => c.pageInserted).length,
      deletedPages: numbered.filter((c) => c.pageDeleted).length,
    },
  }
}

/**
 * Page on the other side that corresponds to `page` — for synchronized
 * scrolling. A page with no counterpart maps to the counterpart of the
 * nearest matched page before it (so the other pane waits at the gap).
 */
export function mapComparedPage(pairs: PagePair[], from: 'a' | 'b', page: number): number | null {
  const to = from === 'a' ? 'b' : 'a'
  let fallback: number | null = null
  for (const p of pairs) {
    const here = p[from]
    if (here !== null && here > page) break
    if (here === page && p[to] !== null) return p[to]
    if (p[to] !== null) fallback = p[to]
  }
  return fallback ?? pairs.find((p) => p[to] !== null)?.[to] ?? null
}

/**
 * Anchor resolution — the hard part of SoloPDF.
 *
 *   stored: { page, quads, pre, post, text }
 *   live:   page text items from pdf.js getTextContent()
 *
 * Resolution priority (design doc):
 *   1. fingerprint (pre + text + post) found on stored page  -> exact/moved match
 *   2. fingerprint found on another page (full-doc search is caller-driven,
 *      page by page, cheap pages first)                       -> relocated
 *   3. no fingerprint hit anywhere                            -> orphan
 *
 * When the annotation was privacy-stripped (no pre/post/text) we fall back
 * to page + quads directly (two-factor anchoring — documented tradeoff).
 */
import type { AnchorData } from './types.js'

export interface PageTextIndex {
  /** concatenated page text (normalized) */
  text: string
  /** map from concatenated-char-index -> text item index (for quad lookup) */
  charToItem: Int32Array
}

/**
 * Normalize text for fingerprint/search matching:
 *  - NFKC folds compatibility codepoints — real-world PDFs (e.g. Chrome/Skia
 *    exports) subset CJK fonts onto Kangxi-Radical codepoints (⼜ U+2F24)
 *    that LOOK identical to the ideograph (又 U+53C8) but never match a
 *    user's query; NFKC also folds fullwidth ASCII (Ａ→A).
 *  - then collapse all whitespace.
 */
export function normalize(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '')
}

/**
 * Build a searchable index from pdf.js text items.
 * `strings` is the array of TextItem.str in reading order.
 */
export function buildPageIndex(strings: string[]): PageTextIndex {
  let total = 0
  for (const s of strings) total += normalize(s).length
  const charToItem = new Int32Array(total)
  let text = ''
  let k = 0
  for (let i = 0; i < strings.length; i++) {
    const n = normalize(strings[i])
    for (let j = 0; j < n.length; j++) charToItem[k++] = i
    text += n
  }
  return { text, charToItem }
}

export type AnchorMatch =
  | { kind: 'exact'; startChar: number; endChar: number; itemRange: [number, number] }
  | { kind: 'quads-only' }
  | { kind: 'miss' }

/**
 * Try to locate the anchor's fingerprint inside one page index.
 * Returns char range of the highlighted text within the page.
 */
export function matchOnPage(anchor: AnchorData, idx: PageTextIndex): AnchorMatch {
  const text = anchor.text ? normalize(anchor.text) : ''
  const pre = normalize(anchor.pre ?? '')
  const post = normalize(anchor.post ?? '')

  if (!text) {
    // privacy-stripped: page+quads only
    return anchor.quads.length ? { kind: 'quads-only' } : { kind: 'miss' }
  }

  // search all occurrences of `text`, score by pre/post context agreement
  let best: { start: number; score: number } | null = null
  let from = 0
  while (true) {
    const at = idx.text.indexOf(text, from)
    if (at < 0) break
    let score = 0
    if (pre) {
      const got = idx.text.slice(Math.max(0, at - pre.length), at)
      score += commonSuffix(got, pre)
    }
    if (post) {
      const got = idx.text.slice(at + text.length, at + text.length + post.length)
      score += commonPrefix(got, post)
    }
    if (!best || score > best.score) best = { start: at, score }
    from = at + 1
  }
  if (!best) return { kind: 'miss' }
  const start = best.start
  const end = start + text.length
  return {
    kind: 'exact',
    startChar: start,
    endChar: end,
    itemRange: [idx.charToItem[start] ?? 0, idx.charToItem[Math.max(start, end - 1)] ?? 0],
  }
}

function commonPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

function commonSuffix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}

/** Fingerprint capture: clamp context windows to 32 chars. */
export function makeFingerprint(pre: string, text: string, post: string) {
  return {
    pre: pre.slice(-32),
    text,
    post: post.slice(0, 32),
  }
}

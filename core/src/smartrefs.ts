/**
 * Smart references (Sioyek-style) for PDFs that carry no link annotations.
 *
 * Two halves, both pure text so they are testable without a renderer:
 *
 *   findRefs(text)            "as shown in Figure 3 and [4, 7]"
 *                              → figure:3 @[12,20), citation:4, citation:7
 *
 *   targetScore(line, ref)    is this LINE where `ref` is defined?
 *                              figure/table → caption line starting "Figure 3:"
 *                              equation     → line ending "(4)"
 *                              citation     → bibliography line starting "[4]"
 *
 * The viewer feeds it pdf.js text lines page by page and keeps the best hit
 * (chooseTarget). Nothing is shown unless a target is found, which is what
 * keeps a loose pattern like a bare "(4)" from producing false positives.
 */

export type RefKind = 'figure' | 'table' | 'equation' | 'citation'

export interface TextRef {
  kind: RefKind
  /** normalized label: "3", "3.2", "II" (table roman numerals), "12" */
  label: string
  /** char range of the reference in the input text */
  start: number
  end: number
}

const FIG = String.raw`(?:Figures?|Figs?\.?|FIGURES?|FIGS?\.?)`
const TAB = String.raw`(?:Tables?|Tabs?\.|TABLES?)`
const EQ = String.raw`(?:Equations?|Eqs?\.|Eqns?\.|EQ\.)`
const NUM = String.raw`(\d{1,3}(?:\.\d{1,3})?)`
/** words after which a bare "(4)" is almost always an equation reference */
const EQ_LEAD = String.raw`(?:in|into|from|by|see|using|and|to|of|with|via|on|Substituting|substituting|cf\.)`

interface Pattern {
  kind: RefKind
  re: RegExp
  /** capture group holding the label */
  group: number
  /** the match starts with a lead word that is not part of the reference */
  lead?: boolean
}

const PATTERNS: Pattern[] = [
  { kind: 'figure', re: new RegExp(String.raw`\b${FIG}\s*${NUM}[a-z]?\b`, 'g'), group: 1 },
  { kind: 'table', re: new RegExp(String.raw`\b${TAB}\s*${NUM}\b`, 'g'), group: 1 },
  { kind: 'table', re: /\b(?:Table|TABLE)\s+([IVX]{1,6})\b/g, group: 1 },
  { kind: 'equation', re: new RegExp(String.raw`\b${EQ}\s*[(（]?\s*${NUM}\s*[)）]?`, 'g'), group: 1 },
  { kind: 'equation', re: new RegExp(String.raw`\b${EQ_LEAD}\s+\((\d{1,3})\)`, 'g'), group: 1, lead: true },
  { kind: 'figure', re: /[图圖]\s*(\d{1,3}(?:[.．-]\d{1,3})?)/g, group: 1 },
  { kind: 'table', re: /(?<![列代发發图圖])表\s*(\d{1,3}(?:[.．-]\d{1,3})?)/g, group: 1 },
  { kind: 'equation', re: /(?:公式|式)\s*[(（]\s*(\d{1,3}(?:[.．-]\d{1,3})?)\s*[)）]/g, group: 1 },
  { kind: 'equation', re: /公式\s*(\d{1,3})(?!\d)/g, group: 1 },
]

const normLabel = (s: string): string => s.replace(/[．]/g, '.').replace(/-/g, '.')

/**
 * All references in a run of text, sorted by position, non-overlapping.
 * Bracketed citations yield one ref per number so "[3, 7]" can preview
 * whichever number the pointer is on.
 */
export function findRefs(text: string): TextRef[] {
  const out: TextRef[] = []
  for (const p of PATTERNS) {
    p.re.lastIndex = 0
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
      const skip = p.lead ? m[0].indexOf('(') : 0
      out.push({ kind: p.kind, label: normLabel(m[p.group]), start: m.index + skip, end: m.index + m[0].length })
    }
  }
  // citations: [12], [3, 7], [2-5] (ranges expand to their endpoints only —
  // a range's middle numbers have no characters to hover)
  const cite = /\[(\d{1,3}(?:\s*[,;–-]\s*\d{1,3}){0,12})\]/g
  for (let m = cite.exec(text); m; m = cite.exec(text)) {
    const inner = m[1]
    const base = m.index + 1
    const nums = /\d{1,3}/g
    const found: TextRef[] = []
    // "[0, 1]" is an interval, not a citation
    if (/(^|\D)0+(\D|$)/.test(inner)) continue
    for (let n = nums.exec(inner); n; n = nums.exec(inner)) {
      found.push({ kind: 'citation', label: String(parseInt(n[0], 10)), start: base + n.index, end: base + n.index + n[0].length })
    }
    // a lone number owns the brackets too — easier to hit with a mouse
    if (found.length === 1) { found[0].start = m.index; found[0].end = m.index + m[0].length }
    out.push(...found)
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: TextRef[] = []
  let edge = -1
  for (const r of out) {
    if (r.start < edge) continue
    kept.push(r)
    edge = r.end
  }
  return kept
}

/** the ref covering `offset` in `text`, if any */
export function refAt(text: string, offset: number): TextRef | null {
  for (const r of findRefs(text)) if (offset >= r.start && offset < r.end) return r
  return null
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** "3.2" also matches "3-2" / "3．2" as printed */
const labelRe = (label: string): string => esc(label).replace(/\\\./g, '[.．-]')

/**
 * How strongly does `line` define `ref`? 0 = not at all.
 *   2 = caption/entry with a separator ("Figure 3:", "Table 2.", "[4] Author")
 *   1 = weaker form (caption word + number at line start, no separator)
 */
export function targetScore(line: string, ref: Pick<TextRef, 'kind' | 'label'>): number {
  const s = line.trim()
  if (!s) return 0
  const L = labelRe(ref.label)
  const tail = String.raw`(?![\d.．]\d)`
  switch (ref.kind) {
    case 'figure': {
      if (new RegExp(String.raw`^${FIG}\s*${L}${tail}[a-z]?\s*[:.．：|—–-]`).test(s)) return 2
      if (new RegExp(String.raw`^[图圖]\s*${L}${tail}`).test(s)) return 2
      if (new RegExp(String.raw`^${FIG}\s*${L}${tail}(?:\s|$)`).test(s)) return 1
      return 0
    }
    case 'table': {
      if (new RegExp(String.raw`^${TAB}\s*${L}${tail}\s*[:.．：|—–-]`).test(s)) return 2
      if (new RegExp(String.raw`^表\s*${L}${tail}`).test(s)) return 2
      // IEEE puts "TABLE II" alone on its own line
      if (new RegExp(String.raw`^${TAB}\s*${L}\s*$`).test(s)) return 2
      if (new RegExp(String.raw`^${TAB}\s*${L}${tail}(?:\s|$)`).test(s)) return 1
      return 0
    }
    case 'equation': {
      // the equation number sits at the end of the displayed formula line…
      const m = new RegExp(String.raw`[(（]\s*${L}\s*[)）]$`).exec(s)
      if (!m) return 0
      // a lone "(4)" line: the formula itself sat on another baseline
      if (m.index === 0) return 1
      // …unless that line merely ends by citing it ("… as in Eq. (4)")
      const before = s.slice(0, m.index)
      if (new RegExp(String.raw`(?:${EQ}|\b${EQ_LEAD}|公式|式)\s*$`).test(before)) return 0
      return 2
    }
    case 'citation':
      if (new RegExp(String.raw`^\[\s*${L}\s*\]`).test(s)) return 2
      return 0
  }
}

/** lines that look like bibliography entries ("[12] Knuth, D. …") */
export function isBibEntry(line: string): boolean {
  return /^\s*\[\d{1,3}\]\s*\S/.test(line)
}

export interface RefCandidate {
  page: number
  score: number
  /** citation only: how many bibliography-looking lines that page has */
  bibLines?: number
}

/**
 * Pick the best definition site for a ref hovered on `fromPage`.
 *   figure/table/equation — strongest score, then nearest page, looking
 *     forward before backward (captions follow first mention far more often)
 *   citation — a page that reads like a bibliography (≥3 entry lines);
 *     the nearest such page at/after `fromPage` (per-chapter bibliographies),
 *     else the LAST one before it
 */
export function chooseTarget<C extends RefCandidate>(cands: C[], kind: RefKind, fromPage: number): C | null {
  if (!cands.length) return null
  if (kind === 'citation') {
    const bib = cands.filter((c) => (c.bibLines ?? 0) >= 3)
    const pool = bib.length ? bib : cands
    const ahead = pool.filter((c) => c.page >= fromPage).sort((a, b) => a.page - b.page)
    if (ahead.length) return ahead[0]
    return [...pool].sort((a, b) => b.page - a.page)[0]
  }
  const dist = (p: number): number => (p >= fromPage ? p - fromPage : (fromPage - p) * 1.5 + 0.5)
  return [...cands].sort((a, b) => b.score - a.score || dist(a.page) - dist(b.page))[0]
}

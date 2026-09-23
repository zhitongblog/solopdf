/**
 * Page labels — the numbers printed on the page ("xii", "23", "A-3") as
 * opposed to the physical page index the file stores pages by.
 *
 * Display only. Everything that is WRITTEN (sidecar anchors, deep links,
 * bookmarks, reading positions) keeps the physical 1-based page number: a
 * label is not unique (two "1"s in a book whose front matter restarts), and
 * old sidecars must keep resolving the way they always did.
 *
 * Input is whatever pdf.js getPageLabels() returned — one string per page,
 * or null when the document has no /PageLabels tree.
 */

/**
 * Clean up pdf.js output: null when absent, malformed, or indistinguishable
 * from plain physical numbering (a tree that just says "decimal from 1" adds
 * nothing and would make every page box read "3 (3 / 10)").
 */
export function normalizePageLabels(
  labels: readonly (string | null | undefined)[] | null | undefined,
  numPages: number,
): string[] | null {
  if (!labels || labels.length !== numPages || !numPages) return null
  const out = labels.map((l, i) => (l == null || l === '' ? String(i + 1) : String(l)))
  return out.every((l, i) => l === String(i + 1)) ? null : out
}

/** the printed label for a 1-based physical page (falls back to the number) */
export function pageLabel(labels: readonly string[] | null | undefined, page: number): string {
  return labels?.[page - 1] ?? String(page)
}

/** true when the label says something the physical number doesn't */
export function hasDistinctLabel(labels: readonly string[] | null | undefined, page: number): boolean {
  return pageLabel(labels, page) !== String(page)
}

/**
 * Resolve what someone typed into a page box to a physical page.
 *
 *   "xii" / "A-3"  → the page carrying that label
 *   "23"           → the page LABELLED 23 when such a label exists (that is
 *                    the number printed on the paper, and what a citation
 *                    means), otherwise physical page 23
 *   "#23"          → always physical page 23 (escape hatch for the case above)
 *
 * The first page wins when a label repeats. null = nothing matched.
 */
export function resolvePageInput(
  input: string,
  labels: readonly string[] | null | undefined,
  numPages: number,
): number | null {
  const s = input.trim()
  if (!s) return null
  const physical = (v: string): number | null => {
    if (!/^\d+$/.test(v)) return null
    const n = parseInt(v, 10)
    return n >= 1 && n <= numPages ? n : null
  }
  if (s.startsWith('#')) return physical(s.slice(1).trim())
  if (labels?.length) {
    let i = labels.indexOf(s)
    if (i < 0) {
      const lower = s.toLowerCase()
      i = labels.findIndex((l) => l.toLowerCase() === lower)
    }
    if (i >= 0) return i + 1
  }
  return physical(s)
}

// ── compact ranges (CLI / MCP output) ────────────────────────────────────

export interface PageLabelRange {
  /** physical pages, 1-based inclusive */
  from: number
  to: number
  /** label of the first and last page of the run */
  first: string
  last: string
}

const ROMAN: [number, string][] = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
]

function fromRoman(s: string): number | null {
  const lower = s.toLowerCase()
  let n = 0
  let rest = lower
  for (const [v, sym] of ROMAN) {
    while (rest.startsWith(sym)) { n += v; rest = rest.slice(sym.length) }
  }
  // round-trip check rejects non-canonical strings ("iiii", "vx")
  return !rest && n > 0 && toRoman(n) === lower ? n : null
}

function toRoman(n: number): string {
  let out = ''
  for (const [v, sym] of ROMAN) while (n >= v) { out += sym; n -= v }
  return out
}

/** split a label into prefix + counter, in whatever style it's written */
function parseLabel(l: string): { prefix: string; style: string; n: number } | null {
  const d = l.match(/^(.*?)(\d+)$/)
  if (d) return { prefix: d[1], style: 'D', n: parseInt(d[2], 10) }
  const r = l.match(/^(.*?)([ivxlcdm]+|[IVXLCDM]+)$/)
  if (r) {
    // prefer the longest roman tail that is canonical ("Appendix" is not x)
    for (let k = 0; k < r[2].length; k++) {
      const tail = r[2].slice(k)
      const n = fromRoman(tail)
      if (n) {
        return { prefix: r[1] + r[2].slice(0, k), style: tail === tail.toLowerCase() ? 'r' : 'R', n }
      }
    }
  }
  return null
}

/**
 * Collapse labels into runs of consecutive numbering: Cover | i–iv | 1–16 |
 * A-1–A-3. A run continues while prefix and style match and the counter
 * steps by exactly one.
 */
export function compactPageLabels(labels: readonly string[] | null | undefined): PageLabelRange[] {
  if (!labels?.length) return []
  const out: PageLabelRange[] = []
  let prev: ReturnType<typeof parseLabel> = null
  labels.forEach((l, i) => {
    const cur = parseLabel(l)
    const last = out[out.length - 1]
    const continues = last && prev && cur &&
      cur.prefix === prev.prefix && cur.style === prev.style && cur.n === prev.n + 1
    if (continues) {
      last.to = i + 1
      last.last = l
    } else {
      out.push({ from: i + 1, to: i + 1, first: l, last: l })
    }
    prev = cur
  })
  return out
}

/** one-line human form: "1: Cover; 2-5: i–iv; 6-21: 1–16" */
export function formatPageLabelRanges(labels: readonly string[] | null | undefined): string {
  return compactPageLabels(labels)
    .map((r) => (r.from === r.to ? `${r.from}: ${r.first}` : `${r.from}-${r.to}: ${r.first}–${r.last}`))
    .join('; ')
}

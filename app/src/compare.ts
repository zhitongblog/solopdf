/**
 * Compare documents (Acrobat "Compare Files" / PDF Expert compare), text
 * based. The algorithm — tokenizing, page alignment, word / CJK-character
 * diff — is @solopdf/core `compareDocuments`, the same code the CLI and the
 * MCP server run; this module only feeds it and shows its answer:
 *
 *   runCompare(old, new)
 *     ├── read every page's text items (same filter as the viewer, so item
 *     │   indices in the result match the geometry read here)
 *     ├── compareDocuments() ......... changes + page alignment
 *     ├── marks per page ............. span → PDF-space quad per side
 *     ├── openPair(old, new) ......... side by side (viewer/pair.ts), sync
 *     │                                scroll mapped through the alignment
 *     └── controller.setDiffMarks() .. tints in both panes
 *
 * The session ends when the pair dissolves (closing either tab, closing the
 * pair, a narrow window) or from the change list's "End compare".
 */
import { ref, shallowRef } from 'vue'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { compareDocuments, mapComparedPage, type CompareResult, type ComparePage, type CompareSpan, type Quad } from '@solopdf/core'
import { store, controllers, documents } from './store'
import type { DiffMark } from './viewer/controller'
import { openPair, setPairMapper, setPairSync, onPairClose, releaseDriver, pair } from './viewer/pair'

export interface CompareSession {
  /** old document (left) */
  a: number
  /** new document (right) */
  b: number
  nameA: string
  nameB: string
  result: CompareResult
}

export const compareSession = shallowRef<CompareSession | null>(null)
/** index into result.changes of the change in focus, -1 = none */
export const compareCurrent = ref(-1)
/** page-reading progress while a compare runs */
export const compareProgress = ref<{ done: number; total: number } | null>(null)

/** geometry of one text item, PDF user space (same reading as the viewer) */
interface ItemGeom { x: number; y: number; w: number; h: number; str: string }

async function readPages(
  doc: PDFDocumentProxy,
  onPage: () => void,
): Promise<{ pages: ComparePage[]; geom: ItemGeom[][] }> {
  const pages: ComparePage[] = []
  const geom: ItemGeom[][] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent()
    const items: ComparePage = []
    const g: ItemGeom[] = []
    for (const it of tc.items as Array<{ str?: string; hasEOL?: boolean; transform: number[]; width: number; height: number }>) {
      if (!('str' in it)) continue
      items.push({ str: it.str ?? '', hasEOL: !!it.hasEOL })
      g.push({ x: it.transform[4], y: it.transform[5], w: it.width, h: it.height, str: it.str ?? '' })
    }
    pages.push(items)
    geom.push(g)
    onPage()
    // keep the UI (progress, scrolling) alive on long documents
    if (p % 4 === 0) await new Promise((r) => setTimeout(r, 0))
  }
  return { pages, geom }
}

/**
 * Where a character offset falls inside an item, as a fraction of its width.
 * pdf.js gives only the item's total width; spreading it evenly puts marks a
 * character off in proportional fonts ("i" vs "W"), so the split follows the
 * glyph widths of a generic sans-serif — close enough for any Latin face,
 * and exact for CJK, which is monospaced anyway.
 */
let measureCtx: CanvasRenderingContext2D | null = null
function fracAt(str: string, off: number): number {
  if (off <= 0 || !str.length) return 0
  if (off >= str.length) return 1
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return off / str.length
  measureCtx.font = '100px Helvetica, Arial, sans-serif'
  const total = measureCtx.measureText(str).width
  return total > 0 ? measureCtx.measureText(str.slice(0, off)).width / total : off / str.length
}

/** a span (char range of one text item) → PDF-space rectangle */
function spanQuad(geom: ItemGeom[][], s: CompareSpan): Quad | null {
  const g = geom[s.page - 1]?.[s.item]
  if (!g) return null
  const x1 = g.x + g.w * fracAt(g.str, s.from)
  const x2 = g.x + g.w * fracAt(g.str, s.to)
  // a little below the baseline so descenders are inside the tint
  const h = g.h || 10
  return { x1: Math.min(x1, x2), y1: g.y - h * 0.2, x2: Math.max(x1, x2), y2: g.y + h }
}

function buildMarks(result: CompareResult, side: 'a' | 'b', geom: ItemGeom[][]): Map<number, DiffMark[]> {
  const marks = new Map<number, DiffMark[]>()
  const add = (page: number, m: DiffMark): void => {
    const list = marks.get(page)
    if (list) list.push(m)
    else marks.set(page, [m])
  }
  for (const c of result.changes) {
    const s = c[side]
    if (side === 'b' && c.pageInserted) { add(c.pageInserted, { id: c.id, kind: 'page-ins' }); continue }
    if (side === 'a' && c.pageDeleted) { add(c.pageDeleted, { id: c.id, kind: 'page-del' }); continue }
    const kind: DiffMark['kind'] = c.kind === 'change' ? 'chg' : side === 'a' ? 'del' : 'ins'
    if (s.spans.length) {
      for (const sp of s.spans) {
        const q = spanQuad(geom, sp)
        if (q) add(sp.page, { id: c.id, kind, quad: q })
      }
    } else if (s.at) {
      const q = spanQuad(geom, s.at)
      if (q) add(s.at.page, { id: c.id, kind: 'caret', quad: q })
    }
  }
  return marks
}

function clearMarks(s: CompareSession | null): void {
  if (!s) return
  controllers.get(s.a)?.setDiffMarks(null)
  controllers.get(s.b)?.setDiffMarks(null)
}

onPairClose(() => {
  clearMarks(compareSession.value)
  compareSession.value = null
  compareCurrent.value = -1
})

/**
 * Compare two open PDF tabs (`a` = old, `b` = new) and lay them out side by
 * side with the differences marked. Throws on unreadable documents.
 */
export async function runCompare(a: number, b: number): Promise<CompareSession> {
  const docA = documents.get(a)
  const docB = documents.get(b)
  const tabA = store.tabs.find((t) => t.id === a)
  const tabB = store.tabs.find((t) => t.id === b)
  if (!docA || !docB || !tabA || !tabB) throw new Error('document not loaded')
  // a previous session on other tabs ends first
  if (compareSession.value) {
    clearMarks(compareSession.value)
    compareSession.value = null
  }
  const total = docA.numPages + docB.numPages
  let done = 0
  compareProgress.value = { done, total }
  const tick = (): void => { done++; compareProgress.value = { done, total } }
  try {
    const ra = await readPages(docA, tick)
    const rb = await readPages(docB, tick)
    const result = compareDocuments(ra.pages, rb.pages)
    const ok = await openPair(a, b, { dir: 'row', sync: true, focus: b })
    if (!ok) throw new Error('cannot show the two documents side by side')
    const session: CompareSession = { a, b, nameA: tabA.name, nameB: tabB.name, result }
    setPairMapper((from, page) => {
      const to = mapComparedPage(result.pairs, from, page)
      if (to == null) return null
      const exact = result.pairs.some((p) => p[from] === page && p[from === 'a' ? 'b' : 'a'] === to)
      return { page: to, exact }
    })
    controllers.get(a)?.setDiffMarks(buildMarks(result, 'a', ra.geom))
    controllers.get(b)?.setDiffMarks(buildMarks(result, 'b', rb.geom))
    compareSession.value = session
    compareCurrent.value = -1
    store.settings.sidebarOpen = true
    store.settings.sidebarTab = 'changes'
    store.docTick++
    return session
  } finally {
    compareProgress.value = null
  }
}

/** bring change `index` into view in BOTH documents and emphasize it */
export function gotoChange(index: number): void {
  const s = compareSession.value
  const c = s?.result.changes[index]
  if (!s || !c) return
  compareCurrent.value = index
  // both panes are positioned explicitly: sync must not drag one after the other
  releaseDriver()
  for (const id of [s.a, s.b]) {
    const ctrl = controllers.get(id)
    if (!ctrl) continue
    ctrl.setCurrentDiff(c.id)
    const anchor = ctrl.diffAnchor(c.id)
    const side = id === s.a ? c.a : c.b
    if (anchor?.quad) ctrl.scrollToQuad(anchor.page, anchor.quad)
    else ctrl.scrollToPage(anchor?.page ?? side.page)
  }
}

export function stepChange(dir: 1 | -1): void {
  const s = compareSession.value
  const n = s?.result.changes.length ?? 0
  if (!n) return
  const cur = compareCurrent.value
  const next = cur < 0 ? (dir > 0 ? 0 : n - 1) : (cur + dir + n) % n
  gotoChange(next)
}

/** end the compare session; the documents stay side by side */
export function endCompare(): void {
  const s = compareSession.value
  if (!s) return
  clearMarks(s)
  setPairMapper(null)
  compareSession.value = null
  compareCurrent.value = -1
  if (store.settings.sidebarTab === 'changes') store.settings.sidebarTab = 'outline'
  // plain sync again: re-capture the page offset the reader now sees
  if (pair.value?.sync) setPairSync(true)
}

/** the compare session for a tab, if it is one of the compared documents */
export function compareFor(tabId: number): CompareSession | null {
  const s = compareSession.value
  return s && (s.a === tabId || s.b === tabId) ? s : null
}


/**
 * Reading ruler — DOM side: which scroll host the band lives in, and the
 * text lines visible in it (client coordinates, reading order).
 *
 *   PDF view   .pv-scroll[data-tab] / [data-split-tab]
 *              lines = pdf.js text-layer spans, grouped per page
 *   Book view  .bk-scroll[data-book-tab]
 *              lines = Range.getClientRects() of text nodes, clipped to the
 *              visible page (paged layout = CSS columns slid sideways)
 *
 * Grouping into lines and reading order (two-column papers, book spreads)
 * is core's groupLines(); this file only measures.
 */
import { groupLines, type LineBox } from '@solopdf/core'

export type RulerHostKind = 'pdf' | 'book'

export function hostKind(host: HTMLElement): RulerHostKind {
  return host.classList.contains('bk-scroll') ? 'book' : 'pdf'
}

/** the hosts a tab can show the ruler in, focused pane first */
export function hostsFor(tabId: number, book: boolean): HTMLElement[] {
  if (book) {
    const b = document.querySelector<HTMLElement>(`.bk-scroll[data-book-tab="${tabId}"]`)
    return b ? [b] : []
  }
  const panes = [
    document.querySelector<HTMLElement>(`.pv-scroll[data-tab="${tabId}"]`),
    document.querySelector<HTMLElement>(`.pv-scroll[data-split-tab="${tabId}"]`),
  ].filter((e): e is HTMLElement => !!e && e.offsetParent !== null)
  const focused = panes.find((p) => p.classList.contains('pv-focused'))
  return focused ? [focused, ...panes.filter((p) => p !== focused)] : panes
}

/** the visible part of a host (scrollbars excluded) in client coordinates */
export function viewportOf(host: HTMLElement): LineBox {
  const r = host.getBoundingClientRect()
  return {
    left: r.left + host.clientLeft,
    top: r.top + host.clientTop,
    right: r.left + host.clientLeft + host.clientWidth,
    bottom: r.top + host.clientTop + host.clientHeight,
  }
}

const intersects = (a: LineBox, b: LineBox): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

/**
 * Lines in and around the viewport (one screen above and below, so a key
 * press can find the next line before it scrolls into view), reading order.
 */
export function collectLines(host: HTMLElement): LineBox[] {
  const vp = viewportOf(host)
  const reach = vp.bottom - vp.top
  const zone: LineBox = { left: vp.left - 2, right: vp.right + 2, top: vp.top - reach, bottom: vp.bottom + reach }
  return hostKind(host) === 'book' ? bookLines(host, vp, zone) : pdfLines(host, zone)
}

function pdfLines(host: HTMLElement, zone: LineBox): LineBox[] {
  const out: LineBox[] = []
  // pages in DOM order = reading order (a facing spread is left page first)
  for (const page of host.querySelectorAll<HTMLElement>('.pv-page')) {
    if (page.style.display === 'none') continue
    const pr = page.getBoundingClientRect()
    if (!pr.width || !intersects(pr, zone)) continue
    const rects: LineBox[] = []
    for (const span of page.querySelectorAll<HTMLElement>('.pv-textlayer span')) {
      if (span.childElementCount || !span.textContent?.trim()) continue
      const r = span.getBoundingClientRect()
      if (!r.width || !r.height || !intersects(r, zone)) continue
      // the page is a crop window: text outside it is not on screen
      if (r.bottom < pr.top || r.top > pr.bottom) continue
      rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
    }
    out.push(...groupLines(rects, { midX: (pr.left + pr.right) / 2 }))
  }
  return out
}

function bookLines(host: HTMLElement, vp: LineBox, zone: LineBox): LineBox[] {
  const root = host.querySelector<HTMLElement>('.bk-paged-content, .bk-page')
  if (!root) return []
  const paged = root.classList.contains('bk-paged-content')
  // paged: only what is on the visible page(s), not the columns either side
  const clip: LineBox = paged ? { ...vp, top: vp.top - 2, bottom: vp.bottom + 2 } : zone
  const rects: LineBox[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as HTMLElement
        if (el.classList.contains('bk-ph')) return NodeFilter.FILTER_REJECT
        // whole subtrees out of reach are skipped without measuring children
        const r = el.getBoundingClientRect()
        if (!r.width && !r.height) return NodeFilter.FILTER_SKIP
        return intersects(r, clip) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT
      }
      return n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  const range = document.createRange()
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    range.selectNodeContents(n)
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 2) continue
      // a fragment must sit on a visible column, not merely overlap its edge
      const cx = (r.left + r.right) / 2
      if (cx < clip.left || cx > clip.right || r.bottom < clip.top || r.top > clip.bottom) continue
      rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
    }
  }
  return groupLines(rects, { midX: (vp.left + vp.right) / 2 })
}

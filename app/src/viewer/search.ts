/**
 * Incremental full-text search: page by page, yielding batches so the UI
 * stays responsive on 1000-page documents. CJK-safe (uses the same
 * normalized index as anchoring).
 */
import type { PdfViewerController } from './controller'
import { normalize } from '@solopdf/core'

export interface SearchHit {
  page: number
  /** char offset in normalized page text */
  at: number
  /** short preview with the hit in context */
  preview: string
}

export class SearchSession {
  private cancelled = false
  hits: SearchHit[] = []

  constructor(
    private ctrl: PdfViewerController,
    public query: string,
  ) {}

  cancel(): void {
    this.cancelled = true
  }

  /** run over all pages; onProgress fires per page batch */
  async run(onProgress: (hits: SearchHit[], donePages: number, total: number) => void): Promise<void> {
    const q = normalize(this.query)
    if (!q) return
    const total = this.ctrl.numPages
    for (let p = 1; p <= total; p++) {
      if (this.cancelled) return
      const idx = await this.ctrl.getPageIndex(p)
      let from = 0
      while (true) {
        const at = idx.text.indexOf(q, from)
        if (at < 0) break
        const lo = Math.max(0, at - 16)
        const hi = Math.min(idx.text.length, at + q.length + 16)
        this.hits.push({
          page: p,
          at,
          preview:
            (lo > 0 ? '…' : '') + idx.text.slice(lo, at) + '「' + idx.text.slice(at, at + q.length) + '」' + idx.text.slice(at + q.length, hi) + (hi < idx.text.length ? '…' : ''),
        })
        from = at + Math.max(1, q.length)
        if (this.hits.length >= 500) break // sanity cap, surfaced in UI
      }
      // yield to UI every 5 pages
      if (p % 5 === 0) {
        onProgress(this.hits, p, total)
        await new Promise((r) => setTimeout(r, 0))
      }
      if (this.hits.length >= 500) break
    }
    onProgress(this.hits, total, total)
  }
}

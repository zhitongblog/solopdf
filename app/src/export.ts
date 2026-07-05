/**
 * 另存为 Markdown — full-text export.
 *
 * Structure priority:
 *   1. outline entries become #/##/### headings at their page boundaries
 *   2. every page emits an HTML page-marker comment (jump-back debugging,
 *      and SoloMD renders comments invisibly)
 *   3. annotations (if any) appended as a final section
 *
 * Shared by the app (viewer/Toolbar) and reproduced in the CLI (export-md).
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Annotation } from '@solopdf/core'
import { t } from './i18n'

interface OutlineFlat {
  title: string
  page: number
  depth: number
}

async function flattenOutline(doc: PDFDocumentProxy): Promise<OutlineFlat[]> {
  const raw = await doc.getOutline().catch(() => null)
  if (!raw) return []
  const out: OutlineFlat[] = []
  const walk = async (items: any[], depth: number): Promise<void> => {
    for (const it of items) {
      try {
        let dest = it.dest
        if (typeof dest === 'string') dest = await doc.getDestination(dest)
        if (Array.isArray(dest) && dest[0]) {
          out.push({ title: it.title ?? '', page: (await doc.getPageIndex(dest[0])) + 1, depth })
        }
      } catch { /* skip unresolvable */ }
      if (it.items?.length) await walk(it.items, depth + 1)
    }
  }
  await walk(raw, 0)
  return out.sort((a, b) => a.page - b.page)
}

async function pageText(doc: PDFDocumentProxy, p: number): Promise<string> {
  const page = await doc.getPage(p)
  const tc = await page.getTextContent()
  let out = ''
  for (const it of tc.items as Array<{ str: string; hasEOL?: boolean }>) {
    if ('str' in it) out += it.str + (it.hasEOL ? '\n' : '')
  }
  return out.trim()
}

export async function exportMarkdown(
  doc: PDFDocumentProxy,
  pdfName: string,
  annotations: Annotation[],
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const outline = await flattenOutline(doc)
  const byPage = new Map<number, OutlineFlat[]>()
  for (const o of outline) {
    const arr = byPage.get(o.page) ?? []
    arr.push(o)
    byPage.set(o.page, arr)
  }

  const parts: string[] = []
  parts.push(`# ${pdfName.replace(/\.pdf$/i, '')}`)
  parts.push('')
  parts.push(`> ${t('ex.source')}: ${pdfName} · ${t('ex.pages')}: ${doc.numPages} · ${t('ex.exportedAt')}: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`)
  parts.push('')

  for (let p = 1; p <= doc.numPages; p++) {
    const heads = byPage.get(p)
    if (heads) {
      for (const h of heads) {
        parts.push(`${'#'.repeat(Math.min(h.depth + 2, 6))} ${h.title}`)
        parts.push('')
      }
    }
    const text = await pageText(doc, p)
    parts.push(`<!-- ${t('ex.page', { n: p })} / p.${p} -->`)
    if (text) {
      parts.push(text)
      parts.push('')
    }
    onProgress?.(p, doc.numPages)
    if (p % 10 === 0) await new Promise((r) => setTimeout(r, 0))
  }

  if (annotations.length) {
    parts.push(`## ${t('ex.annotSection')}`)
    parts.push('')
    for (const a of annotations) {
      if (a.excerpt) parts.push(`> ${a.excerpt.replaceAll('\n', '\n> ')} (p.${a.anchor.page})`)
      if (a.note) parts.push(a.note)
      parts.push('')
    }
  }

  return parts.join('\n')
}

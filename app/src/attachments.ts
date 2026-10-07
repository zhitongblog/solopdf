/**
 * Embedded files of open PDF tabs: the Attachments sidebar list and what
 * Open / Save do (sidebar buttons and on-page paperclips share this).
 *
 *   document-level (/EmbeddedFiles) ── one getAttachments() at open
 *   FileAttachment annotations ─────── background page sweep (pdf.js caches
 *                                       getAnnotations, so pages the viewer
 *                                       already rendered cost nothing)
 *
 * Open:   pdf / book / image → staged in the app cache, opened as a new tab
 *         other              → staged, handed to the OS default app
 *                              (phones: no "open with" → saved instead)
 *         risky (executable) → refused; Save is the only way out
 * Save:   platform saveBytes (desktop dialog / phone Documents / web download)
 */
import { reactive } from 'vue'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  documentAttachments, annotationAttachments, humanSize,
  type AttachmentData, type AttachmentInfo,
} from '@solopdf/core'
import { tabCloseHooks, type TabState } from './store'
import { platform, isMobile, isTauri } from './platform'
import { t } from './i18n'

/** the page sweep stops here; paperclips on later pages still work when shown */
const MAX_SWEEP_PAGES = 3000

export const attachView = reactive<Record<number, { list: AttachmentInfo[]; scanning: boolean }>>({})
/** bytes, kept out of Vue's reach */
const contents = new Map<number, Map<string, Uint8Array>>()

export interface AttachmentHost {
  /** open a path as a tab (App.openPath) */
  open(path: string): Promise<void>
  toast(msg: string): void
}
let host: AttachmentHost | null = null
export function setAttachmentHost(h: AttachmentHost): void { host = h }

tabCloseHooks.push((id) => {
  contents.delete(id)
  delete attachView[id]
})

function register(tabId: number, items: AttachmentData[]): void {
  const view = attachView[tabId]
  const bytes = contents.get(tabId)
  if (!view || !bytes) return
  for (const a of items) {
    if (bytes.has(a.info.id)) continue
    bytes.set(a.info.id, a.content)
    view.list.push(a.info)
  }
}

/** list everything the document carries; returns once document-level ones are in */
export async function scanAttachments(tab: TabState, doc: PDFDocumentProxy): Promise<void> {
  const tabId = tab.id
  attachView[tabId] = { list: [], scanning: true }
  contents.set(tabId, new Map())
  register(tabId, await documentAttachments(doc))
  void sweepPages(tabId, doc)
}

async function sweepPages(tabId: number, doc: PDFDocumentProxy): Promise<void> {
  // let the first pages render before competing with them
  await new Promise((r) => setTimeout(r, 800))
  const last = Math.min(doc.numPages, MAX_SWEEP_PAGES)
  try {
    for (let p = 1; p <= last; p++) {
      if (!attachView[tabId]) return // tab closed
      const page = await doc.getPage(p)
      const annots = await page.getAnnotations({ intent: 'display' }).catch(() => [])
      register(tabId, annotationAttachments(p, annots))
      if (p % 16 === 0) await new Promise((r) => setTimeout(r, 0))
    }
  } catch { /* document destroyed mid-sweep */ }
  if (attachView[tabId]) attachView[tabId].scanning = false
}

function bytesOf(tabId: number, info: AttachmentInfo): Uint8Array | null {
  return contents.get(tabId)?.get(info.id) ?? null
}

/** a paperclip clicked on a page: make sure the list knows it, then open */
export async function openAttachmentData(tabId: number, a: AttachmentData): Promise<void> {
  register(tabId, [a])
  await openAttachment(tabId, a.info, a.content)
}

export async function openAttachment(tabId: number, info: AttachmentInfo, given?: Uint8Array): Promise<void> {
  const bytes = given ?? bytesOf(tabId, info)
  if (!bytes || !host) return
  if (info.kind === 'risky') {
    host.toast(t('ef.riskyTip', { name: info.name }))
    return
  }
  try {
    if (info.kind === 'pdf' || info.kind === 'book' || info.kind === 'image') {
      await host.open(await platform().stageFile(info.name, bytes))
      return
    }
    // "open with the default app" doesn't exist on phones — keep a copy instead
    if (isTauri() && isMobile()) {
      await saveAttachment(tabId, info, bytes)
      return
    }
    await platform().openStagedExternally(await platform().stageFile(info.name, bytes))
  } catch (err) {
    host.toast(t('ef.openFail', { msg: String((err as Error)?.message ?? err) }))
  }
}

export async function saveAttachment(tabId: number, info: AttachmentInfo, given?: Uint8Array): Promise<void> {
  const bytes = given ?? bytesOf(tabId, info)
  if (!bytes || !host) return
  try {
    const where = await platform().saveBytes(info.name, bytes)
    if (where) host.toast(t('ef.saved', { path: where }))
  } catch (err) {
    host.toast(t('ef.saveFail', { msg: String((err as Error)?.message ?? err) }))
  }
}

export { humanSize }

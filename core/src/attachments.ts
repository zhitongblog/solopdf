/**
 * Embedded files: document-level attachments (/Names /EmbeddedFiles) and
 * FileAttachment annotations (the paperclips on a page).
 *
 * Shared by the viewer (Attachments sidebar tab, clickable paperclips), the
 * CLI (`solopdf attachments`) and the MCP server (`solopdf_attachments`,
 * `solopdf_extract_attachment`), so all three list the same files under the
 * same names. Engine-agnostic: it only needs the handful of pdf.js document
 * methods in `AttachDocLike`.
 *
 * Safety: an attachment is arbitrary bytes chosen by whoever made the PDF.
 * Names are reduced to a bare file name (no directories, no reserved
 * characters) before they go anywhere near a file system, and executables /
 * scripts are classified `risky` — the app offers Save for those, never Open.
 */

export type AttachmentKind =
  /** opens in SoloPDF as a new tab */
  | 'pdf' | 'book' | 'image'
  /** executable or script: save only, never handed to the OS to run */
  | 'risky'
  /** anything else: handed to the OS default app */
  | 'other'

export interface AttachmentInfo {
  /** stable within one document: `doc:<name>` or `annot:<page>:<n>` */
  id: string
  /** safe bare file name (see safeAttachmentName) */
  name: string
  /** byte size of the embedded file */
  size: number
  /** /Desc of the file specification ('' when absent) */
  description: string
  source: 'document' | 'annotation'
  /** 1-based page of a FileAttachment annotation, null for document-level */
  page: number | null
  /** annotation rect, PDF user space [x1, y1, x2, y2]; null for document-level */
  rect: [number, number, number, number] | null
  kind: AttachmentKind
}

export interface AttachmentData {
  info: AttachmentInfo
  content: Uint8Array
}

/** pdf.js's shape for an embedded file (getAttachments() values / annot.file) */
export interface PdfFileLike {
  filename?: string
  rawFilename?: string
  content?: Uint8Array | null
  description?: string | null
}

/** The subset of PDFDocumentProxy this module needs. */
export interface AttachDocLike {
  numPages: number
  getAttachments(): Promise<Record<string, PdfFileLike> | null>
  getPage(n: number): Promise<{ getAnnotations(opts?: { intent?: string }): Promise<unknown[]> }>
}

const PDF_EXT = new Set(['pdf'])
const BOOK_EXT = new Set(['epub', 'mobi', 'azw3', 'azw', 'prc', 'txt', 'cbz', 'cbr', 'djvu', 'djv'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'])
/** things an OS will happily execute (or that carry live script) on a double-click */
const RISKY_EXT = new Set([
  'exe', 'msi', 'msp', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'msc', 'hta', 'reg', 'lnk', 'url', 'scf',
  'vbs', 'vbe', 'js', 'jse', 'mjs', 'wsf', 'wsh', 'ps1', 'psm1', 'jar', 'appref-ms', 'application',
  'sh', 'bash', 'zsh', 'csh', 'command', 'tool', 'app', 'pkg', 'mpkg', 'dmg', 'workflow', 'scpt', 'applescript',
  'run', 'bin', 'appimage', 'deb', 'rpm', 'desktop', 'apk', 'ipa',
  'html', 'htm', 'xhtml', 'svg', 'shtml', 'mht', 'mhtml',
  'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'potm',
])

export function extOf(name: string): string {
  const m = /\.([^./\\]+)$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

/** what the reader does with a file of this name (decided by its LAST extension) */
export function attachmentKind(name: string): AttachmentKind {
  const ext = extOf(name)
  if (RISKY_EXT.has(ext)) return 'risky'
  if (PDF_EXT.has(ext)) return 'pdf'
  if (BOOK_EXT.has(ext)) return 'book'
  if (IMAGE_EXT.has(ext)) return 'image'
  return 'other'
}

/**
 * A bare, portable file name: the last path component only, reserved
 * characters (Windows + POSIX) and control characters replaced, no leading
 * dots (hidden files / `..`), bounded length. Never empty.
 */
export function safeAttachmentName(raw: string | null | undefined): string {
  let s = String(raw ?? '')
  s = s.split(/[\\/]/).filter(Boolean).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim()
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`
  if (s.length > 180) {
    const ext = extOf(s)
    s = ext && ext.length < 12 ? `${s.slice(0, 170)}.${ext}` : s.slice(0, 180)
  }
  return s || 'attachment'
}

/** "a.pdf", "a.pdf" → "a.pdf", "a (2).pdf" — for extracting a whole set into one folder */
export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>()
  return names.map((n) => {
    let out = n
    let i = 2
    while (seen.has(out.toLowerCase())) {
      const ext = extOf(n)
      const stem = ext ? n.slice(0, -(ext.length + 1)) : n
      out = ext ? `${stem} (${i}).${ext}` : `${stem} (${i})`
      i++
    }
    seen.add(out.toLowerCase())
    return out
  })
}

/** 1536 → "1.5 KB" */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`
}

function rectOf(a: { rect?: unknown }): [number, number, number, number] | null {
  const r = a.rect
  if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === 'number')) return null
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]
}

/** document-level attachments only (one cheap call) */
export async function documentAttachments(doc: AttachDocLike): Promise<AttachmentData[]> {
  const raw = await doc.getAttachments().catch(() => null)
  if (!raw) return []
  const out: AttachmentData[] = []
  for (const [key, f] of Object.entries(raw)) {
    const name = safeAttachmentName(f.filename || f.rawFilename || key)
    const content = f.content ?? new Uint8Array()
    out.push({
      info: {
        id: `doc:${key}`, name, size: content.length, description: f.description ?? '',
        source: 'document', page: null, rect: null, kind: attachmentKind(name),
      },
      content,
    })
  }
  return out.sort((a, b) => a.info.name.localeCompare(b.info.name))
}

/** FileAttachment annotations from one page's getAnnotations() result */
export function annotationAttachments(page: number, annots: unknown[]): AttachmentData[] {
  const out: AttachmentData[] = []
  let n = 0
  for (const a of annots as { subtype?: string; file?: PdfFileLike; rect?: unknown }[]) {
    if (a?.subtype !== 'FileAttachment' || !a.file) continue
    const name = safeAttachmentName(a.file.filename || a.file.rawFilename)
    const content = a.file.content ?? new Uint8Array()
    out.push({
      info: {
        id: `annot:${page}:${n++}`, name, size: content.length, description: a.file.description ?? '',
        source: 'annotation', page, rect: rectOf(a), kind: attachmentKind(name),
      },
      content,
    })
  }
  return out
}

/**
 * Every attachment in the document: document-level first, then annotation
 * attachments in page order. `maxPages` bounds the page sweep (getAnnotations
 * per page is the expensive part on a 1000-page book); `yieldEvery` lets a UI
 * caller breathe between pages.
 */
export async function collectAttachments(
  doc: AttachDocLike,
  opts: { annotations?: boolean; maxPages?: number; yieldEvery?: () => Promise<void> } = {},
): Promise<AttachmentData[]> {
  const out = await documentAttachments(doc)
  if (opts.annotations === false) return out
  const last = Math.min(doc.numPages, opts.maxPages ?? doc.numPages)
  for (let p = 1; p <= last; p++) {
    const page = await doc.getPage(p)
    const annots = await page.getAnnotations({ intent: 'display' }).catch(() => [])
    out.push(...annotationAttachments(p, annots))
    if (opts.yieldEvery) await opts.yieldEvery()
  }
  return out
}

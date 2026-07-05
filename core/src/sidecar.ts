/**
 * `.annotations.md` sidecar read/write.
 *
 * Format (interop contract with SoloMD / RAG / git — see design doc):
 *
 *   # 《name》批注
 *   <!-- solopdf:meta v1 pdf-sha256=… name=… -->
 *
 *   ## p.23 — 高亮 <!-- solopdf:id a1b2c3 -->
 *   > excerpt line(s)
 *   note body (freely editable)
 *   [跳回原文](solopdf://open?file=…&page=23&annot=a1b2c3)
 *   <!-- solopdf:anchor a1b2c3 {"page":23,...} -->
 *
 * Write policy: locate-and-replace by anchor id, append-only for new ones.
 * NEVER rewrite the whole file from the model — external edits to note
 * bodies must survive round-trips. serialize() is only used for a brand-new
 * file; updates go through upsertAnnotation()/removeAnnotation() which
 * splice the existing text.
 */
import type { Annotation, AnchorData, Sidecar, SidecarMeta } from './types.js'

const META_RE = /<!--\s*solopdf:meta\s+v1([^>]*?)-->/
const ANCHOR_RE = /<!--\s*solopdf:anchor\s+([A-Za-z0-9_-]+)\s+({.*?})\s*-->/g
const ID_RE = /<!--\s*solopdf:id\s+([A-Za-z0-9_-]+)\s*-->/

export function genId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

export function deepLink(file: string, page: number, annot: string): string {
  return `solopdf://open?file=${encodeURIComponent(file)}&page=${page}&annot=${annot}`
}

function metaLine(meta: SidecarMeta): string {
  const sha = meta.pdfSha256 ? ` pdf-sha256=${meta.pdfSha256}` : ''
  return `<!-- solopdf:meta v1${sha} name=${encodeURIComponent(meta.pdfName)} -->`
}

function anchorLine(a: Annotation): string {
  return `<!-- solopdf:anchor ${a.id} ${JSON.stringify(a.anchor)} -->`
}

/** Render one annotation section (## block). */
export function renderAnnotation(a: Annotation, pdfPath: string): string {
  const lines: string[] = []
  lines.push(`## p.${a.anchor.page} — 高亮 <!-- solopdf:id ${a.id} -->`)
  if (a.excerpt) {
    for (const l of a.excerpt.split('\n')) lines.push(`> ${l}`)
  }
  lines.push(a.note || '')
  lines.push(`[跳回原文](${deepLink(pdfPath, a.anchor.page, a.id)})`)
  lines.push(anchorLine(a))
  return lines.join('\n') + '\n'
}

/** Serialize a complete sidecar — ONLY for creating a brand-new file. */
export function serialize(sc: Sidecar, pdfPath: string): string {
  const parts: string[] = []
  parts.push(`# 《${sc.meta.pdfName}》批注`)
  parts.push(metaLine(sc.meta))
  parts.push('')
  for (const a of sc.annotations) parts.push(renderAnnotation(a, pdfPath))
  return parts.join('\n')
}

/**
 * Parse sidecar text. Tolerant: anything it doesn't recognize is preserved
 * by the upsert/remove splicers (they never touch unknown lines).
 * An `## ` section whose anchor comment was deleted parses as orphan.
 */
export function parse(text: string): Sidecar {
  const meta: SidecarMeta = { version: 1, pdfName: '' }
  const mm = text.match(META_RE)
  if (mm) {
    const attrs = mm[1]
    const sha = attrs.match(/pdf-sha256=([0-9a-f]+)/)
    if (sha) meta.pdfSha256 = sha[1]
    const nm = attrs.match(/name=(\S+)/)
    if (nm) meta.pdfName = decodeURIComponent(nm[1])
  }
  if (!meta.pdfName) {
    const h1 = text.match(/^#\s*《(.*?)》/m)
    if (h1) meta.pdfName = h1[1]
  }

  // anchors by id
  const anchors = new Map<string, AnchorData>()
  for (const m of text.matchAll(ANCHOR_RE)) {
    try {
      anchors.set(m[1], JSON.parse(m[2]) as AnchorData)
    } catch {
      /* corrupt anchor JSON -> treated as orphan below */
    }
  }

  const annotations: Annotation[] = []
  const sections = splitSections(text)
  for (const sec of sections) {
    const idm = sec.header.match(ID_RE)
    if (!idm) continue
    const id = idm[1]
    const anchor = anchors.get(id)
    const { excerpt, note } = parseBody(sec.body)
    const pageFromHeader = sec.header.match(/p\.(\d+)/)
    annotations.push({
      id,
      anchor: anchor ?? {
        page: pageFromHeader ? parseInt(pageFromHeader[1], 10) : 0,
        quads: [],
        pre: '',
        post: '',
      },
      excerpt,
      note,
      color: 'yellow',
      createdAt: '',
      orphan: !anchor,
    })
  }
  return { meta, annotations }
}

interface Section {
  header: string
  body: string
  /** char offsets of the whole section in the source text */
  start: number
  end: number
}

function splitSections(text: string): Section[] {
  const out: Section[] = []
  const re = /^## .*$/gm
  const heads: { idx: number; line: string }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) heads.push({ idx: m.index, line: m[0] })
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].idx
    const end = i + 1 < heads.length ? heads[i + 1].idx : text.length
    out.push({
      header: heads[i].line,
      body: text.slice(start + heads[i].line.length, end),
      start,
      end,
    })
  }
  return out
}

function parseBody(body: string): { excerpt: string; note: string } {
  const lines = body.split('\n')
  const excerptLines: string[] = []
  const noteLines: string[] = []
  for (const l of lines) {
    if (l.startsWith('> ')) excerptLines.push(l.slice(2))
    else if (l.startsWith('>')) excerptLines.push(l.slice(1))
    else if (l.match(/^\[跳回原文\]/)) continue
    else if (l.match(/<!--\s*solopdf:anchor/)) continue
    else noteLines.push(l)
  }
  return {
    excerpt: excerptLines.join('\n'),
    note: noteLines.join('\n').trim(),
  }
}

/**
 * Insert or update one annotation in existing sidecar text by splicing.
 * External edits to other sections are untouched.
 * Returns the new full text.
 */
export function upsertAnnotation(
  text: string,
  a: Annotation,
  pdfPath: string,
  meta: SidecarMeta,
): string {
  if (!text.trim()) {
    return serialize({ meta, annotations: [a] }, pdfPath)
  }
  const sections = splitSections(text)
  const target = sections.find((s) => {
    const idm = s.header.match(ID_RE)
    return idm && idm[1] === a.id
  })
  const rendered = renderAnnotation(a, pdfPath)
  if (target) {
    return text.slice(0, target.start) + rendered + text.slice(target.end)
  }
  // append; keep exactly one blank line between sections
  const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return text + sep + rendered
}

/** Remove one annotation section by id (whole `##` block). */
export function removeAnnotation(text: string, id: string): string {
  const sections = splitSections(text)
  const target = sections.find((s) => {
    const idm = s.header.match(ID_RE)
    return idm && idm[1] === id
  })
  if (!target) return text
  return text.slice(0, target.start) + text.slice(target.end)
}

/** Strip pre/post fingerprints + excerpt for privacy mode (encrypted PDFs). */
export function stripPrivate(a: Annotation): Annotation {
  return {
    ...a,
    excerpt: '',
    anchor: { ...a.anchor, pre: '', post: '', text: undefined },
  }
}

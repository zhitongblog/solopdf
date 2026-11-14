/**
 * Annotation Tagging, Multi-Dimensional Filtering & Flashcard Export (Anki / Obsidian SR)
 */
import type { Annotation } from './types.js'

export interface AnnotationFilter {
  colors?: string[]
  kinds?: string[]
  tags?: string[]
  query?: string
}

export interface FlashcardExportOptions {
  docTitle: string
  fileName?: string
  cloze?: boolean
}

type FlexibleAnnotation = Annotation & {
  quote?: string
  author?: string
  page?: number
}

const TAG_REGEX = /(?:^|[\s,，。；;！!？?（(\[{<])#([\p{L}\p{N}_\-/]+)/gu

function isLikelyHexColor(token: string): boolean {
  if (/^[0-9a-fA-F]{3}$/.test(token)) {
    // 3-char hex with digits or repeated hex chars like fff, aaa
    if (/\d/.test(token) || /^(.)\1\1$/i.test(token)) return true
  }
  if (/^[0-9a-fA-F]{6}$/.test(token) || /^[0-9a-fA-F]{8}$/.test(token)) {
    // 6/8-char hex with digits or repeated pairs like ffffff
    if (/\d/.test(token) || /^(..)\1\1$/i.test(token)) return true
  }
  return false
}

/**
 * Extract normalized `#tag` names (without leading `#`) from annotation text.
 * Supports CJK, letters, numbers, `-`, `_`, `/` (e.g. `#重要`, `#exam/math`, `#todo`).
 * Ignores Markdown headings (`# Heading`) and hex color literals (`#ff0000`).
 */
export function extractTags(text: string | undefined | null): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const result: string[] = []

  // Strip out CSS/inline color properties like `color: #ff0000` or `fill:#abc` before matching
  const cleaned = text.replace(/[:=]\s*#[0-9a-fA-F]{3,8}\b/g, ' ')

  for (const match of cleaned.matchAll(TAG_REGEX)) {
    const rawTag = match[1].replace(/^[/\-_]+|[/\-_]+$/g, '')
    if (!rawTag) continue
    // Ignore pure numbers (#1, #123) and hex color codes (#ff0000, #fff)
    if (/^\d+$/.test(rawTag)) continue
    if (isLikelyHexColor(rawTag)) continue

    const normalized = rawTag.toLowerCase()
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }

  return result
}

function getQuoteText(annot: FlexibleAnnotation): string {
  return (annot.excerpt || annot.quote || annot.anchor?.text || '').trim()
}

function getNoteText(annot: FlexibleAnnotation): string {
  return (annot.note || '').trim()
}

function getAuthorText(annot: FlexibleAnnotation): string {
  return (annot.author || annot.anchor?.src?.author || '').trim()
}

function getPageNumber(annot: FlexibleAnnotation): number {
  return annot.anchor?.page ?? annot.page ?? 1
}

function getAnnotationTags(annot: FlexibleAnnotation): string[] {
  const combined = `${getQuoteText(annot)}\n${getNoteText(annot)}`
  return extractTags(combined)
}

/**
 * Collect sorted unique tags across all annotations' `note` and `excerpt`/`quote`.
 */
export function collectAllTags(annots: Annotation[]): string[] {
  const all = new Set<string>()
  for (const annot of annots as FlexibleAnnotation[]) {
    for (const tag of getAnnotationTags(annot)) {
      all.add(tag)
    }
  }
  return Array.from(all).sort((a, b) => a.localeCompare(b))
}

function normalizeKind(kind: string | undefined): string {
  const k = (kind ?? 'highlight').trim().toLowerCase()
  if (k === 'area') return 'region'
  return k
}

/**
 * Multi-dimensional filter for annotations by color, kind, `#tag`, and text search query.
 */
export function filterAnnotations(annots: Annotation[], filter: AnnotationFilter): Annotation[] {
  if (!filter) return [...annots]

  const colorSet =
    filter.colors && filter.colors.length > 0
      ? new Set(filter.colors.map((c) => c.trim().toLowerCase()).filter(Boolean))
      : null

  const kindSet =
    filter.kinds && filter.kinds.length > 0
      ? new Set(filter.kinds.map((k) => normalizeKind(k)).filter(Boolean))
      : null

  const filterTags =
    filter.tags && filter.tags.length > 0
      ? filter.tags
          .map((t) => t.trim().replace(/^#+/, '').toLowerCase())
          .filter(Boolean)
      : null

  const query = filter.query?.trim().toLowerCase() ?? ''

  return (annots as FlexibleAnnotation[]).filter((annot) => {
    if (colorSet && colorSet.size > 0) {
      const c = (annot.color || '').trim().toLowerCase()
      if (!colorSet.has(c)) return false
    }

    if (kindSet && kindSet.size > 0) {
      const k = normalizeKind(annot.kind)
      if (!kindSet.has(k)) return false
    }

    if (filterTags && filterTags.length > 0) {
      const annotTags = getAnnotationTags(annot)
      const hasMatchingTag = filterTags.some((ft) =>
        annotTags.some((at) => at === ft || at.startsWith(`${ft}/`)),
      )
      if (!hasMatchingTag) return false
    }

    if (query) {
      const haystack = [
        getQuoteText(annot),
        getNoteText(annot),
        getAuthorText(annot),
      ]
        .join('\n')
        .toLowerCase()
      if (!haystack.includes(query)) return false
    }

    return true
  })
}

function sanitizeTsvField(html: string): string {
  return html.replace(/\t/g, ' ').replace(/\r?\n/g, '<br>').trim()
}

function buildDeepLink(fileName: string | undefined, page: number): string | null {
  if (!fileName?.trim()) return null
  return `solopdf://open?file=${encodeURIComponent(fileName.trim())}&page=${page}`
}

/**
 * Export annotations to Anki-compatible TSV (`Front\tBack\tTags`).
 */
export function toAnkiTsv(annots: Annotation[], opts: FlashcardExportOptions): string {
  const header = '#separator:tab\n#html:true\n#tags column:3\n'
  if (!annots.length) return header

  const rows: string[] = []
  for (const annot of annots as FlexibleAnnotation[]) {
    const quote = getQuoteText(annot)
    const note = getNoteText(annot)
    if (!quote && !note && !annot.image) continue

    const page = getPageNumber(annot)
    const deepLink = buildDeepLink(opts.fileName, page)
    const citation = deepLink
      ? `《${opts.docTitle}》 p.${page} <a href="${deepLink}">${deepLink}</a>`
      : `《${opts.docTitle}》 p.${page}`

    const tags = getAnnotationTags(annot)
    const tagsCol = tags.join(' ')

    const hasExplicitCloze = /\{\{c\d+::/i.test(note) || /\{\{c\d+::/i.test(quote)
    const useCloze = Boolean(opts.cloze || hasExplicitCloze)

    let front = ''
    let back = ''

    if (useCloze) {
      if (/\{\{c\d+::/i.test(note)) {
        front = note
        back = [quote, citation].filter(Boolean).join('<br>')
      } else if (/\{\{c\d+::/i.test(quote)) {
        front = quote
        back = [note, citation].filter(Boolean).join('<br>')
      } else {
        const target = quote || note
        const pre = annot.anchor?.pre ?? ''
        const post = annot.anchor?.post ?? ''
        front = `${pre}{{c1::${target}}}${post}`
        back = [note && quote ? note : '', citation].filter(Boolean).join('<br>')
      }
    } else if (normalizeKind(annot.kind) === 'region' && annot.image) {
      front = `<img src="${annot.image}">${quote ? `<br>${quote}` : ''}`
      back = [note || quote, citation].filter(Boolean).join('<br>')
    } else {
      front = quote || note
      back = [note && quote ? note : note || quote, citation].filter(Boolean).join('<br>')
    }

    rows.push(`${sanitizeTsvField(front)}\t${sanitizeTsvField(back)}\t${tagsCol}`)
  }

  return header + rows.join('\n') + (rows.length ? '\n' : '')
}

/**
 * Export annotations to Obsidian Spaced Repetition Markdown (`Question\n?\nAnswer\n<!--p.N-->`).
 */
export function toObsidianSr(
  annots: Annotation[],
  opts: { docTitle: string; fileName?: string },
): string {
  const titleLine = `# 《${opts.docTitle}》 Flashcards\n\n`
  if (!annots.length) return titleLine

  const cards: string[] = []
  for (const annot of annots as FlexibleAnnotation[]) {
    const quote = getQuoteText(annot)
    const note = getNoteText(annot)
    if (!quote && !note && !annot.image) continue

    const page = getPageNumber(annot)
    const deepLink = buildDeepLink(opts.fileName, page)
    const tags = getAnnotationTags(annot)
    const tagLine = tags.length > 0 ? ` ${tags.map((t) => `#${t}`).join(' ')}` : ''

    let question = ''
    if (normalizeKind(annot.kind) === 'region' && annot.image) {
      question = `![${quote || 'snip'}](${annot.image})${tagLine}`
    } else {
      question = `${(quote || note).replace(/\r?\n/g, ' ')}${tagLine}`
    }

    const answerBody = note && quote ? note : note || quote
    const sourceLine = deepLink
      ? `*Source: [《${opts.docTitle}》 p.${page}](${deepLink})*`
      : `*Source: 《${opts.docTitle}》 p.${page}*`

    cards.push(`${question}\n?\n${answerBody}\n${sourceLine}\n<!--p.${page}-->`)
  }

  return titleLine + cards.join('\n\n') + '\n'
}

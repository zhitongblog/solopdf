/**
 * Smart PDF Auto-Rename (inspired by Stirling-PDF's Auto Rename PDF File,
 * powered by SoloPDF's offline Citation / First-Page / XMP extractor).
 *
 * Turns opaque filenames like `2403.09876v1.pdf`, `ssrn-4123456.pdf`, or
 * `scan_20261114.pdf` into clean, human-readable filenames such as:
 *   `2024 - Vaswani - Attention Is All You Need.pdf`
 */

import { extractCitation, type CitationInput, type CitationMeta, type CiteAuthor } from './cite.js'

export interface AutoRenameResult {
  /** Full sanitized filename ending in `.pdf` */
  filename: string
  /** Filename without `.pdf` extension */
  stem: string
  /** Extracted metadata used to build the name */
  meta: CitationMeta
}

export const RENAME_TEMPLATES = [
  { id: 'year-author-title', pattern: '{year} - {author} - {title}', label: '年份 - 作者 - 标题' },
  { id: 'author-year-title', pattern: '[{year}] {author} - {title}', label: '[年份] 作者 - 标题' },
  { id: 'title-only', pattern: '{title}', label: '仅标题' },
  { id: 'snake', pattern: '{year}_{author}_{title}', label: '年份_作者_标题' },
] as const

function primaryAuthorName(authors: CiteAuthor[]): string {
  if (!authors || authors.length === 0) return ''
  const first = authors[0]
  const base = (first.literal || first.family || first.given || '').trim()
  if (!base) return ''
  return authors.length > 1 ? `${base} et al.` : base
}

function allAuthorsName(authors: CiteAuthor[]): string {
  if (!authors || authors.length === 0) return ''
  return authors
    .slice(0, 3)
    .map((a) => (a.literal || a.family || a.given || '').trim())
    .filter(Boolean)
    .join(', ')
}

function isCitationMeta(input: CitationInput | CitationMeta): input is CitationMeta {
  return (
    typeof input === 'object' &&
    input !== null &&
    'title' in input &&
    'authors' in input &&
    'source' in input
  )
}

/** Sanitize a string for safe cross-platform filesystem usage (macOS, Windows, Linux). */
export function sanitizeFilenameStem(raw: string, maxLen = 120): string {
  let s = raw
    // Replace Windows/POSIX forbidden filename characters and control chars
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Clean up empty brackets or dangling separators from missing template fields
  s = s
    .replace(/\[\s*\]/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/^(\s*[-_—·]\s*)+/g, '')
    .replace(/(\s*[-_—·]\s*)+$/g, '')
    .replace(/(\s*-\s*){2,}/g, ' - ')
    .replace(/(_){2,}/g, '_')
    .replace(/\s+/g, ' ')
    .trim()

  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) {
    s = `_${s}`
  }

  const limit = Math.max(16, Math.min(200, maxLen))
  if (s.length > limit) {
    const sliced = s.slice(0, limit).trim()
    // Prefer breaking at the last space if it's near the end
    const lastSpace = sliced.lastIndexOf(' ')
    s = lastSpace >= limit * 0.7 ? sliced.slice(0, lastSpace).trim() : sliced
    s = s.replace(/[-_—·. ]+$/, '')
  }

  return s || 'Document'
}

/**
 * Generate a clean PDF filename from `CitationInput` or `CitationMeta`.
 */
export function suggestPdfFilename(
  input: CitationInput | CitationMeta,
  template = '{year} - {author} - {title}',
  maxLen = 120,
): AutoRenameResult {
  const meta = isCitationMeta(input) ? input : extractCitation(input)
  const title = (meta.title || '').trim()
  const author = primaryAuthorName(meta.authors)
  const authors = allAuthorsName(meta.authors)
  const year = meta.year ? String(meta.year) : ''
  const doi = (meta.doi || '').replace(/\//g, '_')
  const arxiv = meta.arxiv || ''
  const journal = (meta.journal || '').trim()

  const filled = template
    .replace(/\{title\}/g, title)
    .replace(/\{author\}/g, author)
    .replace(/\{authors\}/g, authors)
    .replace(/\{year\}/g, year)
    .replace(/\{doi\}/g, doi)
    .replace(/\{arxiv\}/g, arxiv)
    .replace(/\{journal\}/g, journal)

  const fallback = title || author || arxiv || 'Document'
  const stem = sanitizeFilenameStem(filled.trim() ? filled : fallback, maxLen)
  return {
    filename: `${stem}.pdf`,
    stem,
    meta,
  }
}

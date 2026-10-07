/**
 * Citation info for the open document — "Copy citation" (Zotero / Google
 * Scholar reader style), offline first.
 *
 *   pdf.js doc ──readCitationInput()──▶ { info, xmp, first pages' text lines }
 *                                              │
 *                                   extractCitation()   (pure, offline)
 *                                              │
 *                                              ▼
 *        CitationMeta { title, authors, year, doi, arxiv, journal, … }
 *                                              │
 *                        formatCitation(meta, 'bibtex' | 'apa' | 'gbt')
 *
 * Sources, best first: XMP (dc:title / dc:creator / prism:doi) → Info dict
 * (when it isn't a "Microsoft Word - draft.docx" placeholder) → first-page
 * heuristics (largest type near the top = title, name-shaped lines under it
 * = authors). DOI and arXiv ids come from metadata and the first two pages.
 *
 * Online enrichment (fetchDoiMetadata) is a separate, explicit call: doi.org
 * content negotiation returns CSL-JSON for Crossref and DataCite DOIs alike
 * (arXiv's are 10.48550/arXiv.<id>). Nothing here goes online on its own.
 *
 * Shared by the app (Cite panel), the CLI (`solopdf cite`) and the MCP
 * server (`solopdf_cite`) so all three produce byte-identical citations.
 */

export interface CiteAuthor {
  family: string
  given?: string
  /** a name that must not be split: CJK names, organisations */
  literal?: string
}

export type CiteType = 'article' | 'preprint' | 'book' | 'misc'

export interface CitationMeta {
  title: string
  authors: CiteAuthor[]
  year?: number
  doi?: string
  /** arXiv identifier without version (1706.03762, hep-th/9901001) */
  arxiv?: string
  arxivVersion?: string
  journal?: string
  volume?: string
  issue?: string
  pages?: string
  publisher?: string
  url?: string
  type: CiteType
  /** where each field came from — shown in the UI, useful when it's wrong */
  source: {
    title: 'xmp' | 'info' | 'firstPage' | 'fileName' | 'online' | 'none'
    authors: 'xmp' | 'info' | 'firstPage' | 'online' | 'none'
    year: 'xmp' | 'arxiv' | 'firstPage' | 'info' | 'online' | 'none'
  }
}

/** one positioned text run of a page, PDF user space (y up) */
export interface CiteTextItem {
  str: string
  x: number
  y: number
  /** font size, points */
  size: number
}

export interface CitePage {
  items: CiteTextItem[]
  /** page height, points (to tell "top of the page" from the rest) */
  height: number
}

export interface CitationInput {
  /** pdf.js `getMetadata().info` — the Info dictionary */
  info?: Record<string, unknown> | null
  /** XMP, flattened: 'dc:title' → string, 'dc:creator' → string[] … */
  xmp?: Record<string, unknown> | null
  /** the first page or two */
  pages?: CitePage[]
  fileName?: string
}

export type CiteFormat = 'bibtex' | 'apa' | 'gbt'
export const CITE_FORMATS: CiteFormat[] = ['bibtex', 'apa', 'gbt']

// ── identifiers ────────────────────────────────────────────────────────────

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>{}，。；]+)/gi

/** strip what sentence punctuation leaves glued to a DOI's tail */
function cleanDoi(raw: string): string {
  let d = raw.replace(/[.,;:\]]+$/, '')
  // a closing paren only belongs to the DOI when it opened one too
  while (d.endsWith(')') && (d.match(/\(/g)?.length ?? 0) < (d.match(/\)/g)?.length ?? 0)) d = d.slice(0, -1)
  d = d.replace(/[.,;:]+$/, '')
  return d
}

/**
 * Best DOI in a text. Labelled ones ("DOI: 10…", "doi.org/10…") beat bare
 * ones — a first page may also quote a DOI of some other paper in passing.
 */
export function findDoi(text: string): string | null {
  if (!text) return null
  const flat = text.replace(/\u00ad/g, '')
  const labelled = /(?:\bdoi\s*[:：]?\s*|doi\.org\/|dx\.doi\.org\/)(10\.\d{4,9}\/[^\s"'<>{}，。；]+)/i.exec(flat)
  if (labelled) return cleanDoi(decodeSafe(labelled[1]))
  DOI_RE.lastIndex = 0
  const m = DOI_RE.exec(flat)
  return m ? cleanDoi(decodeSafe(m[1])) : null
}

function decodeSafe(s: string): string {
  try { return /%[0-9a-f]{2}/i.test(s) ? decodeURIComponent(s) : s } catch { return s }
}

/** arXiv id from text: new style (2101.00001v2) or old (hep-th/9901001) */
export function findArxivId(text: string): { id: string; version?: string } | null {
  if (!text) return null
  const pats = [
    /arxiv\s*:\s*(\d{4}\.\d{4,5})(v\d+)?/i,
    /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?/i,
    /10\.48550\/arxiv\.(\d{4}\.\d{4,5})(v\d+)?/i,
    /arxiv\s*:\s*([a-z-]+(?:\.[a-z]{2})?\/\d{7})(v\d+)?/i,
    /arxiv\.org\/(?:abs|pdf)\/([a-z-]+(?:\.[a-z]{2})?\/\d{7})(v\d+)?/i,
  ]
  for (const re of pats) {
    const m = re.exec(text)
    if (m) return m[2] ? { id: m[1], version: m[2] } : { id: m[1] }
  }
  return null
}

/** submission year encoded in an arXiv id (YYMM.nnnnn or arch/YYMMnnn) */
export function arxivYear(id: string): number | undefined {
  const m = /^(\d{2})(\d{2})\./.exec(id) ?? /\/(\d{2})(\d{2})\d{3}$/.exec(id)
  if (!m) return undefined
  const yy = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  if (mm < 1 || mm > 12) return undefined
  return yy >= 91 ? 1900 + yy : 2000 + yy
}

/** PDF date string (D:20170612093000+02'00') or ISO date → year */
export function parsePdfYear(v: unknown): number | undefined {
  if (v instanceof Date) return v.getFullYear()
  if (typeof v !== 'string') return undefined
  const m = /^(?:D:)?\s*((?:19|20)\d{2})/.exec(v.trim())
  return m ? parseInt(m[1], 10) : undefined
}

export function doiUrl(doi: string): string {
  return `https://doi.org/${doi}`
}

/** arXiv's own DOI (DataCite) — what doi.org negotiates for a preprint */
export function arxivDoi(id: string): string {
  return `10.48550/arXiv.${id}`
}

// ── names ──────────────────────────────────────────────────────────────────

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/
const LATIN = /[A-Za-z\u00c0-\u024f]/
const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'dos', 'das', 'ter', 'ten', 'bin', 'al'])
const SUFFIX = /^(jr\.?|sr\.?|ii|iii|iv)$/i

export function isCjkName(s: string): boolean {
  return CJK.test(s) && !LATIN.test(s)
}

/** "Ashish Vaswani" / "Vaswani, Ashish" / "张三" → structured name */
export function parseAuthorName(raw: string): CiteAuthor {
  const s = raw.replace(/\s+/g, ' ').trim()
  if (!s) return { family: '' }
  if (isCjkName(s)) return { family: s.replace(/\s/g, ''), literal: s.replace(/\s/g, '') }
  if (s.includes(',')) {
    const [fam, ...rest] = s.split(',')
    const given = rest.join(',').trim()
    if (given && !SUFFIX.test(given)) return { family: fam.trim(), given }
  }
  const words = s.split(' ')
  if (words.length === 1) return { family: words[0] }
  let end = words.length - 1
  // "Martin Luther King Jr." — the suffix rides with the family name
  if (SUFFIX.test(words[end]) && end > 1) end--
  let start = end
  while (start - 1 > 0 && PARTICLES.has(words[start - 1].toLowerCase())) start--
  return {
    family: words.slice(start).join(' '),
    given: words.slice(0, start).join(' '),
  }
}

/** split an author list ("A and B", "A; B", "A, B, and C", "张三，李四") */
export function splitAuthors(raw: string): string[] {
  const s = raw.replace(/\s+/g, ' ').trim()
  if (!s) return []
  if (/[;；]/.test(s)) return s.split(/\s*[;；]\s*/).filter(Boolean)
  if (CJK.test(s) && !LATIN.test(s)) return s.split(/\s*[,，、]\s*|\s+/).filter(Boolean)
  // "Vaswani, Ashish" / "Smith, J. A." is ONE author written family-first
  const one = /^([^,\s]+(?:\s(?:van|von|de|der|del|di|da|le|la))*)\s*,\s*([^,]+)$/i.exec(s)
  if (one && !/\band\b|&/i.test(s) && one[2].trim().split(/\s+/).length <= 3 &&
      !looksLikeFullName(one[2].trim())) {
    return [s]
  }
  return s.split(/\s*,\s*(?:and\s+|&\s*)?|\s+and\s+|\s*&\s*/i).filter(Boolean)
}

/** "Jane Doe" (given + family) as opposed to "Jane" or "J. A." */
function looksLikeFullName(s: string): boolean {
  const w = s.split(/\s+/).filter((x) => !/^[A-Z]\.?$/.test(x))
  return w.length >= 2
}

/** initials of a given name, APA style: "Aidan N." → "A. N.", "Jean-Pierre" → "J.-P." */
function initialsApa(given: string): string {
  return given
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.split('-').map((p) => (p ? p[0].toUpperCase() + '.' : '')).join('-'))
    .join(' ')
}

/** GB/T 7714: initials without dots, space-separated: "Aidan N." → "A N" */
function initialsGbt(given: string): string {
  return given
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join(' ')
}

// ── first-page heuristics ─────────────────────────────────────────────────

interface Line {
  text: string
  size: number
  y: number
  x: number
}

/** join a page's runs into lines, top to bottom */
export function pageLines(page: CitePage): Line[] {
  const items = page.items.filter((it) => it.str && it.str.trim())
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: { items: CiteTextItem[]; y: number; size: number }[] = []
  for (const it of sorted) {
    const tol = Math.max(2, it.size * 0.45)
    let line = lines.find((l) => Math.abs(l.y - it.y) <= tol)
    if (!line) {
      line = { items: [], y: it.y, size: 0 }
      lines.push(line)
    }
    line.items.push(it)
    line.size = Math.max(line.size, it.size)
  }
  lines.sort((a, b) => b.y - a.y)
  return lines.map((l) => {
    const its = l.items.sort((a, b) => a.x - b.x)
    let text = ''
    for (const it of its) {
      const s = it.str
      if (text && !/\s$/.test(text) && !/^\s/.test(s) && !(CJK.test(text.slice(-1)) && CJK.test(s[0]))) text += ' '
      text += s
    }
    return { text: text.replace(/\s+/g, ' ').trim(), size: l.size, y: l.y, x: its[0]?.x ?? 0 }
  })
}

/** header/footer furniture that is often set large but is not the title */
const NOT_TITLE = /^(arxiv\s*:|preprint|proceedings|journal of|vol(ume)?\.?\s*\d|doi\b|https?:|www\.|©|copyright|received|accepted|published|abstract\b|摘\s*要|关键词|中图分类号|文献标(识|志)码|第\s*\d+\s*卷|[\d\s\-–—./]+$)/i
const STOP_AUTHORS = /^(abstract|摘\s*要|a\s*b\s*s\s*t\s*r\s*a\s*c\s*t|keywords?|index terms|introduction|\d+\s*\.?\s*introduction|1\s+[A-Z])/i
const AFFILIATION = /universit|institut|college|school|department|dept\.|laborator|\blab\b|centre|center|academy|corporation|\binc\b|ltd|gmbh|research\b|google|microsoft|facebook|meta ai|openai|deepmind|大学|学院|研究所|研究院|实验室|公司|中心|系\b|@|\b\d{5,6}\b/i

/** strip affiliation markers: digits, *, †, ‡, §, ¶, ✉, superscript letters */
function stripMarks(s: string): string {
  return s.replace(/[*†‡§¶✉∗♯⋆#]+/g, ' ').replace(/[(（]?\d+(?:\s*,\s*\d+)*\s*[)）]/g, ' ').replace(/([\u3400-\u9fff])\d+(?:,\d+)*/g, '$1 ').replace(/([A-Za-z\u00c0-\u024f.])\d+(?:,\d+)*/g, '$1 ').replace(/\s+/g, ' ').trim()
}

function looksLikeName(tok: string): boolean {
  const t = tok.trim()
  if (!t || t.length > 40) return false
  if (isCjkName(t)) return /^[\u3400-\u9fff\uf900-\ufaff·]{2,5}$/.test(t)
  const words = t.split(/\s+/)
  if (words.length < 2 || words.length > 5) return false
  let caps = 0
  for (const w of words) {
    if (PARTICLES.has(w.toLowerCase())) continue
    if (!/^[A-Z\u00c0-\u00de][A-Za-z\u00c0-\u024f'’.-]*$/.test(w)) return false
    caps++
  }
  return caps >= 2
}

/** names on an author line, or null when the line isn't one */
function namesOnLine(line: string): string[] | null {
  const clean = stripMarks(line)
  if (!clean || AFFILIATION.test(clean)) return null
  const toks = CJK.test(clean) && !LATIN.test(clean)
    ? clean.split(/\s*[,，、;；]\s*|\s+/).filter(Boolean)
    : clean.split(/\s*[,;]\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s{2,}/i).filter(Boolean)
  if (!toks.length) return null
  const good = toks.filter(looksLikeName)
  return good.length && good.length >= toks.length * 0.6 ? good : null
}

interface Heuristic { title?: string; authors?: string[]; year?: number; weakYear?: number }

/** title = largest type in the upper part of page 1; authors = the
 *  name-shaped lines right under it */
export function firstPageHeuristics(page: CitePage | undefined): Heuristic {
  if (!page) return {}
  const lines = pageLines(page)
  if (!lines.length) return {}
  const out: Heuristic = {}
  const upper = lines.filter((l) => l.y >= page.height * 0.35)
  const cands = upper.filter((l) => l.text.length >= 4 && !NOT_TITLE.test(l.text) && /[A-Za-z\u3400-\u9fff]{2}/.test(l.text))
  const bodySize = medianSize(lines)
  if (cands.length) {
    const max = Math.max(...cands.map((l) => l.size))
    // only a title when it is set visibly larger than the body text
    if (max >= bodySize * 1.15) {
      const first = lines.indexOf(cands.find((l) => l.size >= max - 0.5)!)
      const parts: Line[] = [lines[first]]
      for (let i = first + 1; i < lines.length; i++) {
        const l = lines[i]
        const prev = parts[parts.length - 1]
        if (Math.abs(l.size - max) > 0.6 || prev.y - l.y > max * 2.2 || NOT_TITLE.test(l.text)) break
        parts.push(l)
      }
      out.title = joinText(parts.map((p) => p.text))
      // authors: the next few lines, smaller than the title
      const names: string[] = []
      let misses = 0
      for (let i = first + parts.length; i < lines.length && i < first + parts.length + 8; i++) {
        const l = lines[i]
        if (STOP_AUTHORS.test(l.text)) break
        const n = namesOnLine(l.text)
        if (n) { names.push(...n); misses = 0 } else if (names.length && ++misses > 1) break
        else if (!names.length && AFFILIATION.test(l.text)) break
      }
      if (names.length) out.authors = names
    }
  }
  const all = lines.map((l) => l.text).join('\n')
  // strong: a publication year printed as such; weak: received/accepted
  const strong = /(?:©|copyright|\(c\)|published|出版|发表)[^\n]{0,40}?((?:19|20)\d{2})/i.exec(all)
    ?? /((?:19|20)\d{2})\s*年\s*第?\s*\d+\s*[期卷]/.exec(all)
    ?? /\b(?:vol(?:ume)?\.?\s*\d+[^\n]{0,30}?\(((?:19|20)\d{2})\))/i.exec(all)
  const weak = /(?:received|accepted|submitted|收稿日期|修改稿|录用)[^\n]{0,40}?((?:19|20)\d{2})/i.exec(all)
  if (strong) out.year = parseInt(strong[1], 10)
  else if (weak) out.weakYear = parseInt(weak[1], 10)
  return out
}

function medianSize(lines: Line[]): number {
  const s = lines.map((l) => l.size).sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 10
}

function joinText(parts: string[]): string {
  let out = ''
  for (const p of parts) {
    if (!out) { out = p; continue }
    if (out.endsWith('-') && /^[a-z]/.test(p)) out = out.slice(0, -1) + p
    else if (CJK.test(out.slice(-1)) && CJK.test(p[0])) out += p
    else out += ' ' + p
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** Info-dict titles that are really file names / tool placeholders */
export function isJunkTitle(t: string, fileName = ''): boolean {
  const s = t.trim()
  if (s.length < 4) return true
  if (/^(microsoft (word|powerpoint)|untitled|document\d*$|slide \d|title$|无标题|新建)/i.test(s)) return true
  if (/\.(docx?|tex|dvi|pdf|indd|qxp|qxd|book|fm|ps|eps|rtf|odt|pages)$/i.test(s)) return true
  const stem = fileName.replace(/\.[^.]+$/, '')
  if (stem && s.toLowerCase() === stem.toLowerCase()) return true
  // no space at all but digits/underscores: an id, not a title
  if (!/\s/.test(s) && !CJK.test(s) && /[\d_]/.test(s)) return true
  return false
}

// ── extraction ─────────────────────────────────────────────────────────────

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join('; ')
  if (v && typeof v === 'object' && 'value' in (v as object)) return str((v as { value: unknown }).value)
  return ''
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter(Boolean)
  const s = str(v)
  return s ? [s] : []
}

function pageText(p: CitePage | undefined): string {
  return p ? pageLines(p).map((l) => l.text).join('\n') : ''
}

/** everything we can tell about the document's bibliographic identity */
export function extractCitation(input: CitationInput): CitationMeta {
  const info = input.info ?? {}
  const xmp = input.xmp ?? {}
  const fileName = input.fileName ?? ''
  const meta: CitationMeta = {
    title: '', authors: [], type: 'misc',
    source: { title: 'none', authors: 'none', year: 'none' },
  }

  // ── identifiers ──
  const metaText = [
    str(xmp['prism:doi']), str(xmp['dc:identifier']), str(xmp['pdfx:doi']), str(xmp['crossmark:doi']),
    str(info['doi']), str(info['DOI']), str(info['Subject']), str(info['Keywords']),
    str(xmp['dc:description']), str(xmp['pdf:keywords']),
  ].filter(Boolean).join('\n')
  const p1 = pageText(input.pages?.[0])
  const p2 = pageText(input.pages?.[1])
  const xmpDoi = str(xmp['prism:doi']).replace(/^doi:\s*/i, '')
  meta.doi = (xmpDoi && /^10\.\d{4,9}\//.test(xmpDoi) ? xmpDoi : null)
    ?? findDoi(metaText) ?? findDoi(p1)
    // page 2 only when page 1 is a cover / scan with next to no text: on a
    // real paper, page 2 DOIs are citations of other work
    ?? (p1.replace(/\s/g, '').length < 200 ? findDoi(p2) : null) ?? undefined
  const ax = findArxivId(metaText) ?? findArxivId(p1) ?? (meta.doi ? findArxivId(meta.doi) : null)
  if (ax) {
    meta.arxiv = ax.id
    if (ax.version) meta.arxivVersion = ax.version
  }
  // arXiv's own DOI is the preprint's DOI, not a journal's
  if (meta.doi && /^10\.48550\/arxiv\./i.test(meta.doi)) {
    meta.arxiv ??= meta.doi.replace(/^10\.48550\/arxiv\./i, '').replace(/v\d+$/, '')
  }

  // ── title ──
  const heur = firstPageHeuristics(input.pages?.[0])
  const xmpTitle = str(xmp['dc:title'])
  const infoTitle = str(info['Title'])
  if (xmpTitle && !isJunkTitle(xmpTitle, fileName)) { meta.title = xmpTitle; meta.source.title = 'xmp' }
  else if (infoTitle && !isJunkTitle(infoTitle, fileName)) { meta.title = infoTitle; meta.source.title = 'info' }
  else if (heur.title) { meta.title = heur.title; meta.source.title = 'firstPage' }
  else if (fileName) {
    meta.title = fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim()
    meta.source.title = 'fileName'
  }

  // ── authors ──
  const xmpCreators = list(xmp['dc:creator']).flatMap((c) => (c.includes(';') ? splitAuthors(c) : [c]))
  const infoAuthor = str(info['Author'])
  // account names and department codes ("admin", "SE:W:CAR:MP") are not people
  const usable = (names: string[]) => names.filter((n) =>
    n && !/^(admin|administrator|user|owner|unknown|author|作者|root|default)$/i.test(n) && !/[@:/\\|=<>]/.test(n))
  if (usable(xmpCreators).length) {
    meta.authors = usable(xmpCreators).map(parseAuthorName)
    meta.source.authors = 'xmp'
  } else if (infoAuthor && usable(splitAuthors(infoAuthor)).length) {
    meta.authors = usable(splitAuthors(infoAuthor)).map(parseAuthorName)
    meta.source.authors = 'info'
  } else if (heur.authors?.length) {
    meta.authors = heur.authors.map(parseAuthorName)
    meta.source.authors = 'firstPage'
  }

  // ── year ──
  const xmpYear = parsePdfYear(str(xmp['prism:coverDate']) || str(xmp['prism:publicationDate']) || list(xmp['dc:date'])[0])
  const axYear = meta.arxiv ? arxivYear(meta.arxiv) : undefined
  const infoYear = parsePdfYear(info['CreationDate']) ?? parsePdfYear(info['ModDate'])
  if (xmpYear) { meta.year = xmpYear; meta.source.year = 'xmp' }
  else if (axYear) { meta.year = axYear; meta.source.year = 'arxiv' }
  else if (heur.year) { meta.year = heur.year; meta.source.year = 'firstPage' }
  // a received/accepted date is a lower bound: the file's own date wins
  // when it is shortly after (the published PDF), not when it is a scan
  // made decades later
  else if (heur.weakYear && !(infoYear && infoYear >= heur.weakYear && infoYear - heur.weakYear <= 2)) {
    meta.year = heur.weakYear; meta.source.year = 'firstPage'
  }
  else if (infoYear) { meta.year = infoYear; meta.source.year = 'info' }

  // ── container ──
  const journal = str(xmp['prism:publicationName'])
  if (journal) meta.journal = journal
  const vol = str(xmp['prism:volume']); if (vol) meta.volume = vol
  const iss = str(xmp['prism:number']); if (iss) meta.issue = iss
  const sp = str(xmp['prism:startingPage']); const ep = str(xmp['prism:endingPage'])
  if (sp) meta.pages = ep ? `${sp}–${ep}` : sp
  const pub = str(xmp['dc:publisher']); if (pub) meta.publisher = pub

  meta.type = meta.journal ? 'article' : meta.arxiv ? 'preprint' : 'misc'
  meta.url = meta.doi ? doiUrl(meta.doi) : meta.arxiv ? `https://arxiv.org/abs/${meta.arxiv}` : undefined
  return meta
}

// ── online (explicit only) ────────────────────────────────────────────────

/** CSL-JSON (doi.org content negotiation) → CitationMeta */
export function cslToCitation(csl: Record<string, unknown>, base?: CitationMeta): CitationMeta {
  const title = str(Array.isArray(csl.title) ? csl.title[0] : csl.title)
  const people = (Array.isArray(csl.author) ? csl.author : []) as { family?: string; given?: string; literal?: string; name?: string }[]
  const authors: CiteAuthor[] = people.map((p) => {
    if (p.literal || p.name) {
      const lit = (p.literal ?? p.name)!.trim()
      return isCjkName(lit) ? { family: lit, literal: lit } : parseAuthorName(lit)
    }
    const fam = (p.family ?? '').trim()
    const giv = (p.given ?? '').trim()
    if (isCjkName(fam + giv)) return { family: fam + giv, literal: fam + giv }
    return giv ? { family: fam, given: giv } : { family: fam }
  }).filter((a) => a.family)
  const dateOf = (k: string): number | undefined => {
    const d = csl[k] as { 'date-parts'?: unknown[][] } | undefined
    const y = d?.['date-parts']?.[0]?.[0]
    return typeof y === 'number' ? y : typeof y === 'string' ? parseInt(y, 10) || undefined : undefined
  }
  const year = dateOf('issued') ?? dateOf('published-print') ?? dateOf('published-online') ?? dateOf('created')
  const container = str(Array.isArray(csl['container-title']) ? (csl['container-title'] as unknown[])[0] : csl['container-title'])
  let doi = str(csl.DOI) || base?.doi
  // DataCite upper-cases arXiv DOIs; DOIs are case-insensitive, arXiv's
  // own spelling is the one people recognise
  if (doi && /^10\.48550\/arxiv\./i.test(doi)) doi = arxivDoi(doi.replace(/^10\.48550\/arxiv\./i, ''))
  const cslType = str(csl.type)
  const m: CitationMeta = {
    title: title || base?.title || '',
    authors: authors.length ? authors : base?.authors ?? [],
    year: year ?? base?.year,
    doi: doi || undefined,
    arxiv: base?.arxiv,
    arxivVersion: base?.arxivVersion,
    journal: container || undefined,
    volume: str(csl.volume) || undefined,
    issue: str(csl.issue) || undefined,
    pages: str(csl.page).replace(/-/g, '–') || undefined,
    publisher: str(csl.publisher) || undefined,
    url: doi ? doiUrl(doi) : base?.url,
    type: 'misc',
    source: {
      title: title ? 'online' : base?.source.title ?? 'none',
      authors: authors.length ? 'online' : base?.source.authors ?? 'none',
      year: year ? 'online' : base?.source.year ?? 'none',
    },
  }
  if (doi && /^10\.48550\/arxiv\./i.test(doi)) {
    m.arxiv ??= doi.replace(/^10\.48550\/arxiv\./i, '').replace(/v\d+$/, '')
    // DataCite calls arXiv's own record publisher "arXiv"; it is no journal
    if (m.journal && /^arxiv$/i.test(m.journal)) m.journal = undefined
  }
  if (/^book$/.test(cslType)) m.type = 'book'
  else if (m.journal && /article|paper/.test(cslType || 'article')) m.type = 'article'
  else if (m.arxiv || /posted-content|preprint/.test(cslType)) m.type = 'preprint'
  else if (m.journal) m.type = 'article'
  return m
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

/**
 * Exact metadata from doi.org (Crossref / DataCite), merged over what was
 * found offline. Only ever called on an explicit user action.
 */
export async function fetchDoiMetadata(
  meta: CitationMeta,
  fetchFn: FetchLike,
  timeoutMs = 20000,
): Promise<CitationMeta> {
  const doi = meta.doi ?? (meta.arxiv ? arxivDoi(meta.arxiv) : undefined)
  if (!doi) throw new Error('noIdentifier')
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined
  try {
    const res = await fetchFn(`https://doi.org/${encodeURI(doi)}`, {
      headers: { Accept: 'application/vnd.citationstyles.csl+json' },
      signal: ctl?.signal,
    })
    if (!res.ok) throw new Error(res.status === 404 ? 'doiNotFound' : `http ${res.status}`)
    const csl = (await res.json()) as Record<string, unknown>
    return cslToCitation(csl, { ...meta, doi: meta.doi ?? (meta.arxiv ? undefined : doi) })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError' || /aborted/i.test(String((e as Error)?.message))) throw new Error('timeout')
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── formatters ─────────────────────────────────────────────────────────────

function asciiFold(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]/g, '')
}

const STOPWORDS = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with', 'is', 'are', 'towards', 'toward', 'at', 'by'])

/** BibTeX key: family + year + first significant title word (vaswani2017attention) */
export function citeKey(m: CitationMeta): string {
  const fam = m.authors[0] ? asciiFold(m.authors[0].family).toLowerCase() : ''
  const word = (m.title.match(/[A-Za-z][A-Za-z'-]*/g) ?? [])
    .map((w) => w.toLowerCase().replace(/[^a-z]/g, ''))
    .find((w) => w && !STOPWORDS.has(w)) ?? ''
  const key = `${fam || 'anon'}${m.year ?? ''}${word}`
  return key || 'ref'
}

function bibEscape(s: string): string {
  return s.replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_{}])/g, '\\$1').replace(/~/g, '\\textasciitilde{}')
}

function bibName(a: CiteAuthor): string {
  if (a.literal) return `{${bibEscape(a.literal)}}`
  return a.given ? `${bibEscape(a.family)}, ${bibEscape(a.given)}` : bibEscape(a.family)
}

export function toBibtex(m: CitationMeta): string {
  const entry = m.type === 'article' ? 'article' : m.type === 'book' ? 'book' : 'misc'
  const f: [string, string][] = []
  if (m.title) f.push(['title', `{${bibEscape(m.title)}}`])
  if (m.authors.length) f.push(['author', m.authors.map(bibName).join(' and ')])
  if (m.journal) f.push(['journal', bibEscape(m.journal)])
  if (m.volume) f.push(['volume', bibEscape(m.volume)])
  if (m.issue) f.push(['number', bibEscape(m.issue)])
  if (m.pages) f.push(['pages', m.pages.replace(/[–—]/g, '--')])
  if (m.publisher && m.type !== 'preprint') f.push(['publisher', bibEscape(m.publisher)])
  if (m.year) f.push(['year', String(m.year)])
  if (m.arxiv) {
    f.push(['eprint', m.arxiv])
    f.push(['archivePrefix', 'arXiv'])
  }
  if (m.doi) f.push(['doi', m.doi])
  if (m.url) f.push(['url', m.url])
  const body = f.map(([k, v]) => `  ${k} = {${v}}`).join(',\n')
  return `@${entry}{${citeKey(m)},\n${body}\n}`
}

function apaName(a: CiteAuthor): string {
  if (a.literal) return a.literal
  return a.given ? `${a.family}, ${initialsApa(a.given)}` : a.family
}

/** APA 7th edition reference entry (plain text — no italics on a clipboard) */
export function toApa(m: CitationMeta): string {
  const names = m.authors.map(apaName)
  let who = ''
  if (names.length === 1) who = names[0]
  else if (names.length === 2) who = `${names[0]}, & ${names[1]}`
  else if (names.length > 2 && names.length <= 20) who = `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`
  else if (names.length > 20) who = `${names.slice(0, 19).join(', ')}, . . . ${names[names.length - 1]}`
  const year = `(${m.year ?? 'n.d.'})`
  const title = m.title.replace(/[.\s]+$/, '')
  let head = who ? `${who.replace(/\.$/, '')}. ${year}. ${title}` : `${title}. ${year}`
  let tail = ''
  if (m.type === 'article' && m.journal) {
    tail = m.journal
    if (m.volume) tail += `, ${m.volume}`
    if (m.issue) tail += `(${m.issue})`
    if (m.pages) tail += `, ${m.pages.replace(/--?/g, '–')}`
    tail += '.'
  } else if (m.arxiv) {
    if (who) head += ` (arXiv:${m.arxiv})`
    tail = 'arXiv.'
  } else if (m.publisher) {
    tail = `${m.publisher}.`
  }
  let s = /[?!]$/.test(head) ? head : head + '.'
  if (tail) s += ' ' + tail
  const link = m.doi ? doiUrl(m.doi) : m.arxiv ? doiUrl(arxivDoi(m.arxiv)) : m.url
  if (link) s += ' ' + link
  return s
}

function gbtName(a: CiteAuthor): string {
  if (a.literal) return a.literal
  return a.given ? `${a.family.toUpperCase()} ${initialsGbt(a.given)}` : a.family.toUpperCase()
}

/**
 * GB/T 7714—2015 (顺序编码制条目, without the [n] number). `today` is the
 * citation date electronic resources carry: [2026-10-07].
 */
export function toGbt(m: CitationMeta, today = new Date()): string {
  const cjk = m.authors.some((a) => !!a.literal && isCjkName(a.literal)) || CJK.test(m.title)
  const names = m.authors.map(gbtName)
  let who = names.length > 3 ? `${names.slice(0, 3).join(', ')}, ${cjk ? '等' : 'et al'}` : names.join(', ')
  const title = m.title.replace(/[.\s]+$/, '')
  const pad = (n: number) => String(n).padStart(2, '0')
  const cited = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  let s = who ? `${who}. ` : ''
  if (m.type === 'article' && m.journal) {
    s += `${title}[J]. ${m.journal}`
    if (m.year) s += `, ${m.year}`
    if (m.volume) s += `, ${m.volume}`
    if (m.issue) s += `(${m.issue})`
    if (m.pages) s += `: ${m.pages.replace(/[–—]|--/g, '-')}`
    s += '.'
    if (m.doi) s += ` DOI:${m.doi}.`
  } else if (m.type === 'book') {
    s += `${title}[M].`
    if (m.publisher) s += ` ${m.publisher}`
    if (m.year) s += `${m.publisher ? ', ' : ' '}${m.year}`
    s += '.'
  } else if (m.arxiv) {
    s += `${title}[EB/OL]. arXiv:${m.arxiv}`
    if (m.year) s += `, ${m.year}`
    s += `[${cited}]. https://arxiv.org/abs/${m.arxiv}.`
  } else {
    s += `${title}[Z].`
    if (m.year) s += ` ${m.year}.`
    if (m.doi) s += ` DOI:${m.doi}.`
  }
  return s.replace(/\.\./g, '.')
}

export function formatCitation(m: CitationMeta, fmt: CiteFormat, today?: Date): string {
  if (fmt === 'bibtex') return toBibtex(m)
  if (fmt === 'apa') return toApa(m)
  return toGbt(m, today)
}

// ── reading a pdf.js document ─────────────────────────────────────────────

/** the handful of pdf.js document methods readCitationInput needs */
export interface CiteDocLike {
  numPages: number
  getMetadata(): Promise<{ info?: unknown; metadata?: unknown } | null>
  getPage(n: number): Promise<{
    view: number[]
    getTextContent(): Promise<{ items: unknown[] }>
  }>
}

/** pdf.js text items → positioned runs */
export function citePageFromPdfjs(items: unknown[], view: number[]): CitePage {
  const out: CiteTextItem[] = []
  for (const raw of items) {
    const it = raw as { str?: string; transform?: number[]; height?: number }
    if (typeof it.str !== 'string' || !it.transform) continue
    const [a, b, c, d, e, f] = it.transform
    const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10
    out.push({ str: it.str, x: e, y: f, size: Math.round(size * 100) / 100 })
  }
  const h = Math.abs((view[3] ?? 792) - (view[1] ?? 0))
  // runs are in user space; shift so y=0 is the page bottom
  const y0 = Math.min(view[1] ?? 0, view[3] ?? 0)
  if (y0) for (const it of out) it.y -= y0
  return { items: out, height: h }
}

/** pdf.js Metadata (XMP) → flat record; iterable [key, value] pairs */
export function flattenXmp(md: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!md || typeof md !== 'object') return out
  const it = (md as { [Symbol.iterator]?: () => Iterator<[string, unknown]> })[Symbol.iterator]
  if (typeof it === 'function') {
    for (const [k, v] of md as Iterable<[string, unknown]>) out[k] = v
    return out
  }
  const all = (md as { getAll?: () => unknown }).getAll?.()
  if (all instanceof Map) for (const [k, v] of all) out[k as string] = v
  else if (all && typeof all === 'object') Object.assign(out, all)
  return out
}

export async function readCitationInput(doc: CiteDocLike, fileName = '', pageCount = 2): Promise<CitationInput> {
  const md = await doc.getMetadata().catch(() => null)
  const pages: CitePage[] = []
  for (let p = 1; p <= Math.min(pageCount, doc.numPages); p++) {
    try {
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      pages.push(citePageFromPdfjs(tc.items, page.view))
    } catch { /* unreadable page — metadata may still be enough */ }
  }
  return {
    info: (md?.info as Record<string, unknown>) ?? null,
    xmp: flattenXmp(md?.metadata),
    pages,
    fileName,
  }
}

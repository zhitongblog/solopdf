/**
 * FictionBook 2 (.fb2 / .fbz / .fb2.zip) → chapters of HTML + plain text.
 *
 * FB2 is one XML file: <description> (title/authors/cover), one or more
 * <body> (the second is usually footnotes), and the images inline as base64
 * <binary> elements. Pure TS on purpose — the app (browser), the CLI and the
 * MCP server (node, no DOMParser) all parse with this one implementation, so
 * `solopdf extract-text book.fb2` prints exactly what the reader shows.
 *
 * Encoding: whatever the XML declaration says (windows-1251 is the classic
 * Russian one, KOI8-R and UTF-16 also exist). A declaration that lies — says
 * UTF-8, is really 1251 — is caught by a fatal UTF-8 decode and retried.
 *
 * Chapters: every <section> that has content of its own becomes a chapter;
 * nested sections become their own chapters right after their parent's lead
 * text, so a book that is "Part I → 30 chapters" doesn't render as one giant
 * chapter. Footnote bodies are kept as a single chapter each.
 *
 * HTML is generated here from a whitelist, never copied from the file, so it
 * carries no scripts, styles or event handlers by construction. Images come
 * out as <img data-fb2-src="id">; the app swaps in blob URLs.
 */

export interface Fb2TocEntry {
  title: string
  /** 1-based chapter index */
  chapter: number
  depth: number
}

export interface Fb2Chapter {
  title: string
  html: string
  text: string
}

export interface Fb2Binary {
  contentType: string
  /** base64, whitespace already stripped */
  base64: string
}

export interface Fb2Book {
  title: string
  authors: string[]
  lang: string
  annotation: string
  /** decoder label actually used */
  encoding: string
  /** binary id of the cover image, if any */
  coverId: string | null
  chapters: Fb2Chapter[]
  toc: Fb2TocEntry[]
  binaries: Map<string, Fb2Binary>
}

// ── encoding ─────────────────────────────────────────────────────────────

const LABELS: Record<string, string> = {
  'cp1251': 'windows-1251', 'win-1251': 'windows-1251', 'windows1251': 'windows-1251',
  'cp-1251': 'windows-1251', 'cp1252': 'windows-1252', 'koi8r': 'koi8-r', 'utf8': 'utf-8',
}

function tryDecoder(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label)
  } catch {
    return null
  }
}

/** encoding from BOM or the XML declaration; null when neither says */
export function detectXmlEncoding(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  // UTF-16 without BOM: "<?" as 3C 00 3F 00
  if (bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f) return 'utf-16le'
  if (bytes[0] === 0 && bytes[1] === 0x3c && bytes[3] === 0x3f) return 'utf-16be'
  let head = ''
  for (let i = 0; i < Math.min(bytes.length, 256); i++) head += String.fromCharCode(bytes[i])
  const decl = head.match(/^\s*<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']/i)
  if (!decl) return null
  const raw = decl[1].trim().toLowerCase()
  return LABELS[raw.replace(/[_\s]/g, '')] ?? LABELS[raw] ?? raw
}

/** bytes → string, honouring (and double-checking) the declared encoding */
export function decodeFb2Text(bytes: Uint8Array): { text: string; encoding: string } {
  const declared = detectXmlEncoding(bytes)
  if (declared && declared !== 'utf-8' && tryDecoder(declared)) {
    return { text: new TextDecoder(declared).decode(bytes), encoding: declared }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    // not valid UTF-8 whatever it claims: the overwhelmingly likely culprit
    // for an FB2 is a Russian single-byte file
    return { text: new TextDecoder('windows-1251').decode(bytes), encoding: 'windows-1251' }
  }
}

/** zip local-file magic — .fbz and .fb2.zip are plain zips holding one .fb2 */
export function isZipBytes(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/** which member of an unzipped archive is the book */
export function pickFb2Entry(names: string[]): string | null {
  const fb2 = names.filter((n) => /\.fb2$/i.test(n) && !n.includes('__MACOSX/'))
  if (fb2.length) return fb2.sort((a, b) => a.length - b.length)[0]
  // some packers drop the extension; any .xml will do
  return names.find((n) => /\.xml$/i.test(n)) ?? null
}

// ── a small, forgiving XML tree builder ──────────────────────────────────

export interface XNode {
  /** local name (namespace prefix stripped), lower-case */
  name: string
  attrs: Record<string, string>
  children: (XNode | string)[]
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', hellip: '…', copy: '©', reg: '®', shy: '\u00ad', bull: '•',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bdquo: '„', middot: '·', deg: '°',
}

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return NAMED[e.toLowerCase()] ?? m
  })
}

const localName = (n: string): string => {
  const i = n.indexOf(':')
  return (i < 0 ? n : n.slice(i + 1)).toLowerCase()
}

/**
 * Parse XML into a tree. Not validating: mismatched end tags close back to
 * the nearest matching open element (or are ignored), which is how real-world
 * hand-made FB2s survive.
 */
export function parseXml(src: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [] }
  const stack: XNode[] = [root]
  const top = (): XNode => stack[stack.length - 1]
  let i = 0
  const n = src.length
  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      pushText(top(), src.slice(i))
      break
    }
    if (lt > i) pushText(top(), src.slice(i, lt))
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end < 0 ? n : end + 3
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      top().children.push(src.slice(lt + 9, end < 0 ? n : end))
      i = end < 0 ? n : end + 3
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2)
      i = end < 0 ? n : end + 2
    } else if (src.startsWith('<!', lt)) {
      // DOCTYPE, possibly with an internal subset [...]
      let j = lt + 2
      let depth = 0
      while (j < n) {
        const c = src[j]
        if (c === '[') depth++
        else if (c === ']') depth--
        else if (c === '>' && depth <= 0) break
        j++
      }
      i = j + 1
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt)
      const name = localName(src.slice(lt + 2, end < 0 ? n : end).trim())
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k
          break
        }
      }
      i = end < 0 ? n : end + 1
    } else {
      // start tag: scan to the closing '>' outside quotes
      let j = lt + 1
      let quote = ''
      while (j < n) {
        const c = src[j]
        if (quote) {
          if (c === quote) quote = ''
        } else if (c === '"' || c === "'") quote = c
        else if (c === '>') break
        j++
      }
      let body = src.slice(lt + 1, j)
      const selfClosing = body.endsWith('/')
      if (selfClosing) body = body.slice(0, -1)
      const m = body.match(/^\s*([^\s/>]+)/)
      if (m) {
        const node: XNode = { name: localName(m[1]), attrs: {}, children: [] }
        const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"']+))/g
        let a: RegExpExecArray | null
        const rest = body.slice(m[0].length)
        while ((a = attrRe.exec(rest))) {
          node.attrs[a[1].toLowerCase()] = decodeEntities(a[3] ?? a[4] ?? a[5] ?? '')
        }
        top().children.push(node)
        if (!selfClosing) stack.push(node)
      }
      i = j + 1
    }
  }
  return root
}

function pushText(node: XNode, raw: string): void {
  if (!raw) return
  const s = decodeEntities(raw)
  const last = node.children[node.children.length - 1]
  if (typeof last === 'string') node.children[node.children.length - 1] = last + s
  else node.children.push(s)
}

const elems = (n: XNode): XNode[] => n.children.filter((c): c is XNode => typeof c !== 'string')
const child = (n: XNode | undefined, name: string): XNode | undefined =>
  n ? elems(n).find((c) => c.name === name) : undefined
const kids = (n: XNode | undefined, name: string): XNode[] =>
  n ? elems(n).filter((c) => c.name === name) : []

/** l:href / xlink:href / href, whichever prefix the file used */
function hrefOf(n: XNode): string {
  for (const [k, v] of Object.entries(n.attrs)) {
    if (k === 'href' || k.endsWith(':href')) return v
  }
  return ''
}

export function textOf(n: XNode | string | undefined): string {
  if (n === undefined) return ''
  if (typeof n === 'string') return n
  return n.children.map(textOf).join('')
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

// ── HTML generation (whitelist) ──────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const INLINE: Record<string, string> = {
  emphasis: 'em', strong: 'strong', strikethrough: 's', sub: 'sub', sup: 'sup', code: 'code',
}

function imageHtml(n: XNode): string {
  const id = hrefOf(n).replace(/^#/, '')
  if (!id) return ''
  const alt = n.attrs.alt ?? n.attrs.title ?? ''
  return `<img data-fb2-src="${esc(id)}" alt="${esc(alt)}">`
}

function inline(n: XNode | string): string {
  // XML whitespace only: a full-width indent (U+3000) is content, not layout
  if (typeof n === 'string') return esc(n.replace(/[ \t\r\n]+/g, ' '))
  const tag = INLINE[n.name]
  const inner = n.children.map(inline).join('')
  if (tag) return `<${tag}>${inner}</${tag}>`
  if (n.name === 'a') {
    // footnote markers read as superscript; links themselves stay inert
    // (the reader has no in-book navigation for them)
    return n.attrs.type === 'note' ? `<sup>${inner}</sup>` : `<span>${inner}</span>`
  }
  if (n.name === 'image') return imageHtml(n)
  return inner
}

/** inline content with paragraph-level breaks for stray <p>s inside */
function inlineBlock(n: XNode): string {
  const parts = elems(n).filter((c) => c.name === 'p')
  if (parts.length) return parts.map(inl).join('<br>')
  return inl(n)
}

/** a node's inline HTML, trimmed of XML (not typographic) whitespace */
function inl(n: XNode): string {
  return n.children.map(inline).join('').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
}

const H = (depth: number): string => `h${Math.min(depth + 2, 6)}`

function block(n: XNode, depth: number): string {
  switch (n.name) {
    case 'p':
      return `<p>${inl(n)}</p>`
    case 'v':
      return `<p class="fb2-v">${inl(n)}</p>`
    case 'subtitle':
      return `<h${Math.min(depth + 3, 6)} class="fb2-subtitle">${inlineBlock(n)}</h${Math.min(depth + 3, 6)}>`
    case 'empty-line':
      return '<p class="fb2-empty"><br></p>'
    case 'title': {
      const h = H(depth)
      return `<${h}>${inlineBlock(n)}</${h}>`
    }
    case 'image': {
      const img = imageHtml(n)
      return img ? `<p class="fb2-img">${img}</p>` : ''
    }
    case 'text-author':
      return `<p class="fb2-author">${inl(n)}</p>`
    case 'date':
      return `<p class="fb2-author">${esc(squash(textOf(n)))}</p>`
    case 'epigraph':
      return `<blockquote class="fb2-epigraph">${blocks(n, depth)}</blockquote>`
    case 'cite':
      return `<blockquote>${blocks(n, depth)}</blockquote>`
    case 'annotation':
      return `<blockquote class="fb2-annotation">${blocks(n, depth)}</blockquote>`
    case 'poem':
      return `<div class="fb2-poem">${blocks(n, depth)}</div>`
    case 'stanza':
      return `<div class="fb2-stanza">${blocks(n, depth)}</div>`
    case 'table':
      return `<table>${kids(n, 'tr').map((tr) =>
        `<tr>${elems(tr).filter((c) => c.name === 'td' || c.name === 'th').map((c) =>
          `<${c.name}>${inl(c)}</${c.name}>`).join('')}</tr>`).join('')}</table>`
    case 'section':
      // only reached for sections inside a notes body
      return blocks(n, depth + 1)
    default:
      // unknown wrapper: keep what's readable
      return elems(n).length ? blocks(n, depth) : (squash(textOf(n)) ? `<p>${esc(squash(textOf(n)))}</p>` : '')
  }
}

function blocks(n: XNode, depth: number): string {
  return elems(n).map((c) => block(c, depth)).join('')
}

/** HTML → plain text: one line per block, entities decoded */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<\/(p|h[1-6]|tr|blockquote|div)>/g, '\n')
      .replace(/<\/t[dh]>/g, '\t')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/^[ \t]+|[ \t]+$/g, ''))
    .filter((l) => l.trim())
    .join('\n')
}

// ── book assembly ────────────────────────────────────────────────────────

const NOTE_BODIES = /^(notes|comments|footnotes)$/i

export function parseFb2(input: Uint8Array | string): Fb2Book {
  let src: string
  let encoding = 'utf-8'
  if (typeof input === 'string') src = input
  else ({ text: src, encoding } = decodeFb2Text(input))

  const root = parseXml(src)
  const fb = child(root, 'fictionbook') ?? elems(root)[0]
  if (!fb || !child(fb, 'body')) throw new Error('fb2Bad')

  const desc = child(fb, 'description')
  const ti = child(desc, 'title-info')
  const title = squash(textOf(child(ti, 'book-title')))
  const authors = kids(ti, 'author').map((a) => {
    const parts = ['first-name', 'middle-name', 'last-name'].map((k) => squash(textOf(child(a, k)))).filter(Boolean)
    return parts.join(' ') || squash(textOf(child(a, 'nickname')))
  }).filter(Boolean)
  const lang = squash(textOf(child(ti, 'lang')))
  const annotation = htmlToText(blocks(child(ti, 'annotation') ?? { name: '', attrs: {}, children: [] }, 0))

  const binaries = new Map<string, Fb2Binary>()
  for (const b of kids(fb, 'binary')) {
    const id = b.attrs.id
    if (!id) continue
    binaries.set(id, {
      contentType: b.attrs['content-type'] ?? guessType(id),
      base64: textOf(b).replace(/\s+/g, ''),
    })
  }
  const coverImg = child(child(ti, 'coverpage'), 'image')
  let coverId: string | null = coverImg ? hrefOf(coverImg).replace(/^#/, '') || null : null
  if (coverId && !binaries.has(coverId)) coverId = null
  if (!coverId) coverId = [...binaries.keys()].find((k) => /cover/i.test(k)) ?? null

  const chapters: Fb2Chapter[] = []
  const toc: Fb2TocEntry[] = []
  const emit = (chTitle: string, html: string): void => {
    if (!html.trim()) return
    chapters.push({ title: chTitle, html, text: htmlToText(html) })
  }

  /** one section: lead content → chapter, sub-sections recurse, tail → chapter */
  const walkSection = (sec: XNode, depth: number, fallbackTitle: string): void => {
    const tNode = child(sec, 'title')
    const secTitle = tNode ? squash(textOf(tNode).replace(/\s*\n\s*/g, ' ')) : ''
    if (secTitle) toc.push({ title: secTitle, chapter: chapters.length + 1, depth })
    let buf = ''
    let label = secTitle || fallbackTitle
    for (const c of elems(sec)) {
      if (c.name === 'section') {
        emit(label, buf)
        buf = ''
        walkSection(c, depth + 1, label)
        label = secTitle || fallbackTitle
      } else {
        buf += block(c, depth)
      }
    }
    emit(label, buf)
  }

  const bodies = kids(fb, 'body')
  bodies.forEach((body, bi) => {
    // every body after the first is footnotes/comments in practice, named or not
    const isNotes = bi > 0 || NOTE_BODIES.test(body.attrs.name ?? '')
    if (isNotes) {
      const tNode = child(body, 'title')
      const label = tNode ? squash(textOf(tNode)) : (body.attrs.name || 'Notes')
      toc.push({ title: label, chapter: chapters.length + 1, depth: 0 })
      emit(label, blocks(body, 0))
      return
    }
    // the main body behaves like a top-level section whose own title is the
    // book's title page (not a TOC entry)
    let buf = ''
    for (const c of elems(body)) {
      if (c.name === 'section') {
        emit(title, buf)
        buf = ''
        walkSection(c, 0, title)
      } else {
        buf += block(c, 0)
      }
    }
    emit(title, buf)
  })
  if (!chapters.length) throw new Error('fb2Empty')

  return { title, authors, lang, annotation, encoding, coverId, chapters, toc, binaries }
}

function guessType(id: string): string {
  const ext = id.toLowerCase().split('.').pop() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'svg') return 'image/svg+xml'
  return 'image/jpeg'
}

/** base64 → bytes without Buffer (works in the browser and in node) */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

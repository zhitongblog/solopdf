/**
 * MOBI / AZW3 (KF8) reader.
 *
 * Both are the same Palm Database container:
 *   [PalmDB header][record offsets][record 0: PalmDOC + MOBI + EXTH][text…]
 *
 * An .azw3 (or a hybrid .mobi) carries a second, newer KF8 book inside the
 * same file, starting at the record named by EXTH 121. KF8 is the one worth
 * reading — it is real XHTML with CSS-era markup — so we jump straight to it
 * when it exists and fall back to the older MOBI6 HTML when it doesn't.
 *
 * Written by hand rather than pulled from a library: the format is small and
 * well documented, and every JS implementation on npm is either abandoned or
 * drags in a Node-only zlib/Buffer stack.
 *
 * Not supported, deliberately:
 *   - DRM'd files. They are encrypted; there is nothing to do but say so.
 *   - HUFF/CDIC compression (Amazon's old scheme). Rare in anything made
 *     this decade, and it is reported as an unsupported file rather than
 *     silently rendering garbage.
 */

export interface MobiChapter {
  /** byte range inside the decompressed text */
  start: number
  end: number
  title: string
}

export interface MobiTocEntry {
  title: string
  chapter: number
  depth: number
}

const dec = (bytes: Uint8Array, encoding = 'utf-8'): string =>
  new TextDecoder(encoding, { fatal: false }).decode(bytes)

class Reader {
  private view: DataView
  constructor(public bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  u8(at: number): number { return this.view.getUint8(at) }
  u16(at: number): number { return this.view.getUint16(at) }
  u32(at: number): number { return this.view.getUint32(at) }
  str(at: number, len: number): string {
    return dec(this.bytes.subarray(at, at + len), 'latin1').replace(/\0+$/, '')
  }
}

interface PalmDb {
  name: string
  records: { offset: number; end: number }[]
  reader: Reader
}

function parsePalmDb(bytes: Uint8Array): PalmDb {
  const r = new Reader(bytes)
  const name = r.str(0, 32)
  const count = r.u16(76)
  const records: { offset: number; end: number }[] = []
  for (let i = 0; i < count; i++) {
    const offset = r.u32(78 + i * 8)
    records.push({ offset, end: 0 })
  }
  for (let i = 0; i < records.length; i++) {
    records[i].end = i + 1 < records.length ? records[i + 1].offset : bytes.length
  }
  return { name, records, reader: r }
}

/** PalmDOC LZ77 — the only compression modern MOBI/KF8 files use */
function palmDocDecompress(input: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < input.length) {
    const b = input[i++]
    if (b === 0) {
      out.push(0)
    } else if (b <= 8) {
      // literal run
      for (let k = 0; k < b && i < input.length; k++) out.push(input[i++])
    } else if (b <= 0x7f) {
      out.push(b)
    } else if (b <= 0xbf) {
      // back-reference: 2 bytes, 11-bit distance + 3-bit length
      if (i >= input.length) break
      const pair = (b << 8) | input[i++]
      const distance = (pair >> 3) & 0x07ff
      const length = (pair & 0x07) + 3
      const from = out.length - distance
      if (from < 0) break
      for (let k = 0; k < length; k++) out.push(out[from + k] ?? 0)
    } else {
      // 0xc0–0xff: space + the low 7 bits as a character
      out.push(32, b ^ 0x80)
    }
  }
  return new Uint8Array(out)
}

interface MobiHeader {
  /** record index of the first text record (always 1) */
  firstText: number
  /** record index of the first image (MOBI header 0x5C) */
  firstImage: number
  textRecordCount: number
  compression: number
  encryption: number
  encoding: string
  title: string
  /** EXTH 121: start record of the embedded KF8 book, if any */
  kf8Boundary: number
  /** how many trailing bytes each text record carries */
  trailerFlags: number
  firstNonBook: number
}

function parseMobiHeader(db: PalmDb, recIndex: number): MobiHeader {
  const rec = db.records[recIndex]
  const bytes = db.reader.bytes.subarray(rec.offset, rec.end)
  const r = new Reader(bytes)
  const compression = r.u16(0)
  const textRecordCount = r.u16(8)
  const encryption = r.u16(12)

  let encoding = 'utf-8'
  let title = ''
  let kf8Boundary = -1
  let trailerFlags = 0
  let firstNonBook = 0
  let firstImage = 0

  // Every offset below is relative to the START OF RECORD 0; the MOBI header
  // itself begins at byte 16, after the PalmDOC header, so the documented
  // MOBI-header offsets all get +16.
  if (bytes.length > 20 && r.str(16, 4) === 'MOBI') {
    const headerLen = r.u32(16 + 0x04)
    const codepage = r.u32(16 + 0x0c)
    encoding = codepage === 1252 ? 'windows-1252' : 'utf-8'
    // MOBI header layout (offsets within the header, hence the +16):
    //   0x40 first non-book index · 0x44/0x48 full name offset+length
    //   0x5C first image index · 0x70 EXTH flags
    firstNonBook = r.u32(16 + 0x40)
    firstImage = r.u32(16 + 0x5c)
    const fullNameOffset = r.u32(16 + 0x44)
    const fullNameLength = r.u32(16 + 0x48)
    if (fullNameLength > 0 && fullNameOffset + fullNameLength <= bytes.length) {
      title = dec(bytes.subarray(fullNameOffset, fullNameOffset + fullNameLength), encoding)
    }
    // extra-data flags only exist in headers long enough to have the field
    if (headerLen >= 0xe4 && 0xf4 <= bytes.length) {
      trailerFlags = r.u16(0xf2)
    }
    // EXTH follows the MOBI header when bit 6 of the flags is set
    const exthFlags = r.u32(16 + 0x70)
    const exthOffset = 16 + headerLen
    if ((exthFlags & 0x40) && exthOffset + 12 <= bytes.length && r.str(exthOffset, 4) === 'EXTH') {
      const count = r.u32(exthOffset + 8)
      let p = exthOffset + 12
      for (let i = 0; i < count && p + 8 <= bytes.length; i++) {
        const type = r.u32(p)
        const len = r.u32(p + 4)
        if (len < 8) break
        if (type === 121 && len === 12) kf8Boundary = r.u32(p + 8)
        p += len
      }
    }
  }
  return {
    firstText: 1,
    firstImage,
    textRecordCount,
    compression,
    encryption,
    encoding,
    title,
    kf8Boundary,
    trailerFlags,
    firstNonBook,
  }
}

/**
 * Size of one trailing-data entry, read BACKWARDS from `end` as a 7-bit
 * varint whose final (leftmost) byte has the high bit set. The value counts
 * the size bytes themselves.
 */
function trailerSize(rec: Uint8Array, end: number): number {
  let bitpos = 0
  let result = 0
  let size = end
  for (;;) {
    const v = rec[size - 1]
    if (v === undefined) return 0
    result |= (v & 0x7f) << bitpos
    bitpos += 7
    size--
    if ((v & 0x80) !== 0 || bitpos >= 28 || size === 0) return result
  }
}

/**
 * Text records carry optional trailing metadata (indexes, and a multibyte
 * overlap byte) described by the header's extra-data flags. Feeding those
 * bytes to the decompressor produces convincing garbage at the end of every
 * record — exactly the kind of bug that reads as "this book is corrupt".
 */
function stripTrailers(rec: Uint8Array, flags: number): Uint8Array {
  let end = rec.length
  let bits = flags >> 1
  while (bits) {
    if (bits & 1) {
      const size = trailerSize(rec, end)
      if (size > 0 && size < end) end -= size
    }
    bits >>= 1
  }
  if (flags & 1) {
    // multibyte overlap: the low 2 bits of the last byte give its length
    const b = rec[end - 1]
    if (b !== undefined) end -= (b & 3) + 1
  }
  return rec.subarray(0, Math.max(0, end))
}

export class MobiBook {
  title = ''
  chapters: MobiChapter[] = []
  toc: MobiTocEntry[] = []
  /** true when the source was a KF8 (azw3) part */
  kf8 = false
  private html = ''
  private htmlCache = new Map<number, string>()
  private blobUrls = new Map<number, string>()
  private images: Uint8Array[] = []

  load(bytes: Uint8Array): void {
    const db = parsePalmDb(bytes)
    if (!db.records.length) throw new Error('mobiBad')

    const type = db.reader.str(60, 8)
    if (type !== 'BOOKMOBI' && type !== 'TEXtREAd') throw new Error('mobiBad')

    let head = parseMobiHeader(db, 0)
    let base = 0
    if (head.kf8Boundary > 0 && head.kf8Boundary < db.records.length) {
      // hybrid file: the KF8 book is a whole second MOBI starting here
      base = head.kf8Boundary
      head = parseMobiHeader(db, base)
      this.kf8 = true
    }
    if (head.textRecordCount === 0) throw new Error('mobiBad')
    if (head.encryption !== 0) throw new Error('mobiDrm')
    if (head.compression !== 1 && head.compression !== 2) throw new Error('mobiCompression')

    const parts: Uint8Array[] = []
    for (let i = 1; i <= head.textRecordCount; i++) {
      const rec = db.records[base + i]
      if (!rec) break
      let chunk = db.reader.bytes.subarray(rec.offset, rec.end)
      chunk = stripTrailers(chunk, head.trailerFlags)
      parts.push(head.compression === 2 ? palmDocDecompress(chunk) : chunk)
    }
    let total = 0
    for (const p of parts) total += p.length
    const merged = new Uint8Array(total)
    let at = 0
    for (const p of parts) { merged.set(p, at); at += p.length }
    this.html = dec(merged, head.encoding)
    this.title = head.title || db.name

    // <img recindex="N"> counts from the header's first-image record, not
    // from "just after the text" — those differ whenever a book carries an
    // index or a FLIS/FCIS record in between
    const firstImage = head.firstImage > 0 ? head.firstImage : base + head.textRecordCount + 1
    for (let i = firstImage; i < db.records.length; i++) {
      const rec = db.records[i]
      const b = db.reader.bytes.subarray(rec.offset, rec.end)
      this.images.push(b)
    }

    this.splitChapters()
    if (!this.chapters.length) throw new Error('mobiEmpty')
  }

  /**
   * Chapter boundaries: KF8 marks them with <mbp:pagebreak> or file
   * boundaries; MOBI6 uses the same tag. Fall back to headings, then to
   * fixed-size slices, so even an unmarked book is navigable.
   */
  private splitChapters(): void {
    const marks: number[] = [0]
    const push = (re: RegExp): void => {
      let m: RegExpExecArray | null
      const r = new RegExp(re.source, 'gi')
      while ((m = r.exec(this.html))) marks.push(m.index)
    }
    push(/<mbp:pagebreak[^>]*>/)
    if (marks.length < 3) push(/<div[^>]+class="[^"]*chapter[^"]*"[^>]*>/)
    if (marks.length < 3) push(/<h[12][\s>]/)
    if (marks.length < 3) {
      // nothing structural to go on: 60KB slices keep the reflow view responsive
      for (let i = 60_000; i < this.html.length; i += 60_000) marks.push(i)
    }
    const sorted = [...new Set(marks)].sort((a, b) => a - b)
    for (let i = 0; i < sorted.length; i++) {
      const start = sorted[i]
      const end = i + 1 < sorted.length ? sorted[i + 1] : this.html.length
      if (end - start < 40) continue // skip empty slivers between markers
      this.chapters.push({ start, end, title: this.titleOf(start, end) })
    }
    this.toc = this.chapters.map((c, i) => ({ title: c.title || `${i + 1}`, chapter: i + 1, depth: 0 }))
  }

  private titleOf(start: number, end: number): string {
    const slice = this.html.slice(start, Math.min(end, start + 4000))
    const heading = slice.match(/<h[1-3][^>]*>([\s\S]{0,120}?)<\/h[1-3]>/i)?.[1]
    // Most MOBI6 books have no headings at all — their chapter titles are
    // just centred bold paragraphs — so fall back to the first real text.
    const raw = heading ?? slice
    const text = raw.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim()
    return text.slice(0, 60)
  }

  /** sanitised chapter HTML, matching what the EPUB path produces */
  chapterHtml(chapter: number): string {
    const hit = this.htmlCache.get(chapter)
    if (hit) return hit
    const ch = this.chapters[chapter - 1]
    if (!ch) return ''
    let html = this.html.slice(ch.start, ch.end)
    // publisher CSS and scripting go, exactly as for EPUB — the reader's
    // theme is the typography
    html = html
      .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
      .replace(/<\s*(link|meta)[^>]*>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/<mbp:pagebreak[^>]*>/gi, '')
      .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, '')
    // <img recindex="00007"> → a blob URL for that image record
    html = html.replace(/<img([^>]*?)recindex\s*=\s*["']?(\d+)["']?([^>]*)>/gi, (_m, a, n, b) => {
      const url = this.imageUrl(parseInt(n, 10))
      return url ? `<img${a}src="${url}"${b}>` : ''
    })
    this.htmlCache.set(chapter, html)
    return html
  }

  private imageUrl(recindex: number): string | null {
    const i = recindex - 1
    const hit = this.blobUrls.get(i)
    if (hit) return hit
    const bytes = this.images[i]
    if (!bytes || bytes.length < 4) return null
    const type = sniffImage(bytes)
    if (!type) return null
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
    this.blobUrls.set(i, url)
    return url
  }

  probeTextLength(maxChapters = 5): number {
    let n = 0
    const div = document.createElement('div')
    for (let c = 1; c <= Math.min(maxChapters, this.chapters.length); c++) {
      div.innerHTML = this.chapterHtml(c)
      n += (div.textContent ?? '').trim().length
    }
    return n
  }

  destroy(): void {
    for (const url of this.blobUrls.values()) URL.revokeObjectURL(url)
    this.blobUrls.clear()
    this.htmlCache.clear()
    this.images = []
    this.html = ''
  }
}

function sniffImage(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif'
  return null
}

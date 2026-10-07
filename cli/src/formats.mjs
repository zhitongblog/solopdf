/**
 * Non-PDF formats for the CLI and the MCP server: FB2 (incl. zipped .fbz /
 * .fb2.zip) and TIFF. Parsing is the same core code the app uses, so what
 * `extract-text` prints is what the reader shows.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { parseFb2, isZipBytes, pickFb2Entry, tiffInfo, isTiffBytes } from '@solopdf/core'

/** 'fb2' | 'tiff' | 'pdf' (by name, then by magic bytes for the ambiguous .zip) */
export function formatOf(file) {
  const low = file.toLowerCase()
  if (/\.(fb2|fbz)$/.test(low) || low.endsWith('.fb2.zip')) return 'fb2'
  if (/\.tiff?$/.test(low)) return 'tiff'
  return 'pdf'
}

/** the FB2 XML bytes, unwrapping a zip when there is one */
export function fb2Bytes(bytes) {
  if (!isZipBytes(bytes)) return bytes
  const files = unzipSync(bytes)
  const entry = pickFb2Entry(Object.keys(files))
  if (!entry) throw new Error('zip 中没有 .fb2 文件')
  return files[entry]
}

export async function loadFb2(file) {
  const raw = new Uint8Array(await readFile(file))
  return { book: parseFb2(fb2Bytes(raw)), zipped: isZipBytes(raw) }
}

export async function fb2InfoJson(file) {
  const { book, zipped } = await loadFb2(file)
  return {
    file: path.resolve(file),
    format: 'fb2',
    zipped,
    title: book.title || null,
    authors: book.authors,
    lang: book.lang || null,
    encoding: book.encoding,
    chapters: book.chapters.length,
    tocEntries: book.toc.length,
    toc: book.toc,
    images: book.binaries.size,
    cover: book.coverId,
    annotation: book.annotation || null,
  }
}

export async function tiffInfoJson(file) {
  const bytes = new Uint8Array(await readFile(file))
  if (!isTiffBytes(bytes)) throw new Error('不是 TIFF 文件')
  const info = tiffInfo(bytes)
  return {
    file: path.resolve(file),
    format: 'tiff',
    pages: info.pages.length,
    bigTiff: info.bigTiff,
    pageInfo: info.pages.map((p, i) => ({
      page: i + 1,
      width: p.width,
      height: p.height,
      compression: p.compressionName,
      bitsPerSample: p.bitsPerSample,
      samplesPerPixel: p.samplesPerPixel,
      dpi: p.dpi,
    })),
  }
}

/** decoded TIFF pages (UTIF), thumbnails dropped — same rule as the app */
export async function tiffPages(file) {
  const { default: UTIF } = await import('utif2')
  const buf = await readFile(file)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const ifds = UTIF.decode(ab).filter((d) => d.t256 && d.t257)
  const pages = ifds.filter((d) => !((d.t254?.[0] ?? 0) & 1))
  return {
    pages: pages.length ? pages : ifds,
    rgba(ifd) {
      UTIF.decodeImage(ab, ifd)
      return { width: ifd.width, height: ifd.height, data: UTIF.toRGBA8(ifd) }
    },
  }
}

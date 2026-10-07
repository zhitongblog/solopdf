/**
 * TIFF structure without decoding pixels: page count, sizes, compression.
 *
 * Walks the IFD chain (classic TIFF and BigTIFF, either byte order). Used by
 * the CLI/MCP `info` and by the app to know the page list before decoding
 * anything. Pixel decoding itself is the app's job (UTIF, see app/book/tiff).
 */

export interface TiffPageInfo {
  width: number
  height: number
  /** TIFF Compression tag value (1 none, 3 G3, 4 G4, 5 LZW, 7 JPEG, 8/32946 Deflate, 32773 PackBits …) */
  compression: number
  compressionName: string
  bitsPerSample: number
  samplesPerPixel: number
  /** PhotometricInterpretation (0 min-is-white, 1 min-is-black, 2 RGB, 3 palette, 5 CMYK, 6 YCbCr) */
  photometric: number
  /** dots per inch when the file says so, else null */
  dpi: [number, number] | null
  /** NewSubfileType bit 0: a reduced-resolution copy (thumbnail), not a page */
  reduced: boolean
}

export interface TiffInfo {
  littleEndian: boolean
  bigTiff: boolean
  /** real pages (reduced-resolution thumbnails excluded) */
  pages: TiffPageInfo[]
}

const COMPRESSION: Record<number, string> = {
  1: 'none', 2: 'CCITT RLE', 3: 'CCITT G3', 4: 'CCITT G4', 5: 'LZW', 6: 'JPEG (old)', 7: 'JPEG',
  8: 'Deflate', 32946: 'Deflate', 32773: 'PackBits', 34712: 'JPEG 2000', 50000: 'ZSTD', 34887: 'LERC',
}

export function isTiffBytes(b: Uint8Array): boolean {
  return (b[0] === 0x49 && b[1] === 0x49 && (b[2] === 42 || b[2] === 43) && b[3] === 0) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && (b[3] === 42 || b[3] === 43))
}

export function tiffInfo(bytes: Uint8Array): TiffInfo {
  if (!isTiffBytes(bytes)) throw new Error('tiffBad')
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const le = bytes[0] === 0x49
  const big = (le ? v.getUint16(2, true) : v.getUint16(2, false)) === 43
  const u16 = (o: number): number => v.getUint16(o, le)
  const u32 = (o: number): number => v.getUint32(o, le)
  const u64 = (o: number): number => {
    const lo = v.getUint32(o + (le ? 0 : 4), le)
    const hi = v.getUint32(o + (le ? 4 : 0), le)
    return hi * 2 ** 32 + lo
  }
  const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 }

  const pages: TiffPageInfo[] = []
  let ifd = big ? u64(8) : u32(4)
  const seen = new Set<number>()
  while (ifd && ifd < bytes.length && !seen.has(ifd) && pages.length < 100000) {
    seen.add(ifd)
    const count = big ? u64(ifd) : u16(ifd)
    const entry0 = ifd + (big ? 8 : 2)
    const esize = big ? 20 : 12
    const tags = new Map<number, number[]>()
    for (let k = 0; k < count; k++) {
      const e = entry0 + k * esize
      if (e + esize > bytes.length) break
      const tag = u16(e)
      const type = u16(e + 2)
      const n = big ? u64(e + 4) : u32(e + 4)
      const size = (TYPE_SIZE[type] ?? 1) * n
      const inline = big ? size <= 8 : size <= 4
      let off = inline ? e + (big ? 12 : 8) : (big ? u64(e + 12) : u32(e + 8))
      // only the small numeric tags matter here; skip big arrays
      const take = Math.min(n, 4)
      const vals: number[] = []
      for (let i = 0; i < take && off + (TYPE_SIZE[type] ?? 1) <= bytes.length; i++) {
        if (type === 3 || type === 8) { vals.push(u16(off)); off += 2 }
        else if (type === 4 || type === 9) { vals.push(u32(off)); off += 4 }
        else if (type === 16 || type === 17) { vals.push(u64(off)); off += 8 }
        else if (type === 5 || type === 10) { const d = u32(off + 4); vals.push(d ? u32(off) / d : 0); off += 8 }
        else { vals.push(bytes[off]); off += 1 }
      }
      tags.set(tag, vals)
    }
    const g = (t: number, d = 0): number => tags.get(t)?.[0] ?? d
    const unit = g(296, 2) // 2 = inch, 3 = cm
    const xr = g(282)
    const yr = g(283)
    const toDpi = (r: number): number => Math.round(unit === 3 ? r * 2.54 : r)
    const compression = g(259, 1)
    pages.push({
      width: g(256),
      height: g(257),
      compression,
      compressionName: COMPRESSION[compression] ?? `#${compression}`,
      bitsPerSample: g(258, 1),
      samplesPerPixel: g(277, 1),
      photometric: g(262, 0),
      dpi: xr && yr && unit !== 1 ? [toDpi(xr), toDpi(yr)] : null,
      reduced: (g(254) & 1) === 1,
    })
    const next = entry0 + count * esize
    if (next + (big ? 8 : 4) > bytes.length) break
    ifd = big ? u64(next) : u32(next)
  }
  const real = pages.filter((p) => !p.reduced)
  return { littleEndian: le, bigTiff: big, pages: real.length ? real : pages }
}

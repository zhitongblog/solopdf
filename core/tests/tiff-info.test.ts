import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { tiffInfo, isTiffBytes } from '../src/tiff-info.js'

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test-fixtures')

describe('tiffInfo', () => {
  it('walks every IFD of the mixed-compression fixture', () => {
    const info = tiffInfo(new Uint8Array(readFileSync(path.join(FIX, 'tiff-mixed-3p.tiff'))))
    expect(info.bigTiff).toBe(false)
    expect(info.pages.map((p) => [p.width, p.height, p.compressionName])).toEqual([
      [1275, 1650, 'CCITT G4'],
      [800, 1000, 'LZW'],
      [1000, 700, 'Deflate'],
    ])
    expect(info.pages[0].bitsPerSample).toBe(1)
    expect(info.pages[1].samplesPerPixel).toBe(3)
    expect(info.pages[0].dpi).toEqual([150, 150])
  })

  it('handles big-endian files and rejects non-TIFF', () => {
    // minimal MM TIFF: one IFD with width=7, height=5
    const b = new Uint8Array(8 + 2 + 2 * 12 + 4)
    const v = new DataView(b.buffer)
    b.set([0x4d, 0x4d, 0, 42])
    v.setUint32(4, 8)
    v.setUint16(8, 2)
    v.setUint16(10, 256); v.setUint16(12, 3); v.setUint32(14, 1); v.setUint16(18, 7)
    v.setUint16(22, 257); v.setUint16(24, 3); v.setUint32(26, 1); v.setUint16(30, 5)
    v.setUint32(34, 0)
    expect(isTiffBytes(b)).toBe(true)
    const info = tiffInfo(b)
    expect(info.littleEndian).toBe(false)
    expect(info.pages).toHaveLength(1)
    expect(info.pages[0]).toMatchObject({ width: 7, height: 5, compression: 1 })
    expect(() => tiffInfo(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toThrow('tiffBad')
  })
})

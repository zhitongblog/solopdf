/**
 * Visual Page Comparison (Red/Cyan Anaglyph Overlay & Pixel Hotspot Diff)
 *
 * Compares two rendered page RGBA buffers pixel-by-pixel for engineering drawings,
 * scanned contracts, and layout verification where text-layer diff alone is not enough.
 */

export interface VisualDiffOptions {
  /**
   * Output rendering mode:
   * - `'anaglyph'` (default): Red = old-only ink (removed/shifted from A),
   *   Cyan = new-only ink (added/shifted in B), neutral gray = unchanged ink.
   * - `'tint'`: Renders page B with a vivid red/amber highlight over changed pixels.
   * - `'diff-only'`: Pure white background showing only changed pixels in Red/Cyan.
   */
  mode?: 'anaglyph' | 'tint' | 'diff-only'
  /** Per-channel/luminance difference threshold (0..255, default `28`) */
  threshold?: number
  /** Ignore outer page border margin ratio (0..0.15, default `0.008`) to avoid scan edge noise */
  ignoreMarginRatio?: number
}

export interface VisualDiffHotspot {
  /** Pixel bounding box in the output diff canvas */
  x: number
  y: number
  width: number
  height: number
  /** Normalized `[x, y, width, height]` in `0..1` */
  norm: [number, number, number, number]
  changedPixels: number
}

export interface VisualDiffResult {
  width: number
  height: number
  diffPixels: number
  totalPixels: number
  /** Fraction of pixels that changed (`0..1`) */
  diffRatio: number
  /** Percentage of pixels that changed (`0..100`, rounded to 2 decimals) */
  diffPercent: number
  /** RGBA pixel buffer (`width * height * 4`) ready for `ImageData` or PNG encoding */
  rgba: Uint8ClampedArray
  /** Clustered bounding boxes of visual changes sorted top-to-bottom */
  hotspots: VisualDiffHotspot[]
}

function samplePixel(
  buf: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
): [number, number, number] {
  if (x < 0 || y < 0 || x >= w || y >= h) return [255, 255, 255]
  const idx = (y * w + x) * 4
  const a = buf[idx + 3] ?? 255
  if (a === 0) return [255, 255, 255]
  if (a < 255) {
    const inv = 255 - a
    return [
      ((buf[idx] * a + 255 * inv) / 255) | 0,
      ((buf[idx + 1] * a + 255 * inv) / 255) | 0,
      ((buf[idx + 2] * a + 255 * inv) / 255) | 0,
    ]
  }
  return [buf[idx], buf[idx + 1], buf[idx + 2]]
}

function rgbToLuma(r: number, g: number, b: number): number {
  return (77 * r + 150 * g + 29 * b) >> 8
}

/**
 * Compute a pixel-by-pixel visual comparison between two page RGBA buffers.
 */
export function computeVisualDiff(
  rgbaA: Uint8ClampedArray | Uint8Array,
  widthA: number,
  heightA: number,
  rgbaB: Uint8ClampedArray | Uint8Array,
  widthB: number,
  heightB: number,
  opts: VisualDiffOptions = {},
): VisualDiffResult {
  const mode = opts.mode ?? 'anaglyph'
  const threshold = opts.threshold ?? 28
  const marginRatio = Math.max(0, Math.min(0.15, opts.ignoreMarginRatio ?? 0.008))

  const width = Math.max(1, Math.max(widthA, widthB))
  const height = Math.max(1, Math.max(heightA, heightB))
  const totalPixels = width * height
  const out = new Uint8ClampedArray(totalPixels * 4)

  const minX = Math.floor(width * marginRatio)
  const maxX = Math.ceil(width * (1 - marginRatio))
  const minY = Math.floor(height * marginRatio)
  const maxY = Math.ceil(height * (1 - marginRatio))

  const cellSize = 16
  const gridCols = Math.ceil(width / cellSize)
  const gridRows = Math.ceil(height / cellSize)
  const gridCounts = new Uint32Array(gridCols * gridRows)

  let diffPixels = 0

  for (let y = 0; y < height; y++) {
    const inY = y >= minY && y < maxY
    const gy = (y / cellSize) | 0
    for (let x = 0; x < width; x++) {
      const [rA, gA, bA] = samplePixel(rgbaA, widthA, heightA, x, y)
      const [rB, gB, bB] = samplePixel(rgbaB, widthB, heightB, x, y)

      const lumaA = rgbToLuma(rA, gA, bA)
      const lumaB = rgbToLuma(rB, gB, bB)
      const inkA = 255 - lumaA
      const inkB = 255 - lumaB

      const dl = Math.abs(lumaA - lumaB)
      const dc = Math.max(Math.abs(rA - rB), Math.abs(gA - gB), Math.abs(bA - bB))
      const delta = Math.max(dl, (dc * 3) >> 2)
      const isDiff = inY && x >= minX && x < maxX && delta > threshold

      const outIdx = (y * width + x) * 4

      if (isDiff) {
        diffPixels++
        gridCounts[gy * gridCols + ((x / cellSize) | 0)]++

        if (mode === 'tint') {
          // Emphasize differences in warm red over page B
          out[outIdx] = 235
          out[outIdx + 1] = Math.max(0, (gB * 0.35) | 0)
          out[outIdx + 2] = Math.max(0, (bB * 0.35) | 0)
          out[outIdx + 3] = 255
        } else {
          // Anaglyph / diff-only: Red channel carries New ink attenuation (so Old-only ink is bright Red),
          // Green+Blue (Cyan) channels carry Old ink attenuation (so New-only ink is bright Cyan/Teal).
          const r = Math.max(0, Math.min(255, Math.round(255 - inkB * 0.92 - inkA * 0.08)))
          const g = Math.max(0, Math.min(255, Math.round(255 - inkA * 0.92 - inkB * 0.25)))
          const b = Math.max(0, Math.min(255, Math.round(255 - inkA * 0.92 - inkB * 0.08)))
          out[outIdx] = r
          out[outIdx + 1] = g
          out[outIdx + 2] = b
          out[outIdx + 3] = 255
        }
      } else if (mode === 'diff-only') {
        out[outIdx] = 255
        out[outIdx + 1] = 255
        out[outIdx + 2] = 255
        out[outIdx + 3] = 255
      } else {
        // Unchanged pixel: soft neutral gray so red/cyan differences stand out clearly
        const avgInk = (inkA + inkB) * 0.5
        const gray = Math.max(0, Math.min(255, Math.round(255 - avgInk * 0.45)))
        out[outIdx] = gray
        out[outIdx + 1] = gray
        out[outIdx + 2] = gray
        out[outIdx + 3] = 255
      }
    }
  }

  // Connected-components clustering on the 16x16 grid to produce hotspot bounding boxes
  const visited = new Uint8Array(gridCols * gridRows)
  const hotspots: VisualDiffHotspot[] = []

  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      const startIdx = r * gridCols + c
      if (visited[startIdx] || gridCounts[startIdx] === 0) continue

      let minC = c
      let maxC = c
      let minR = r
      let maxR = r
      let pixels = 0
      const queue: number[] = [startIdx]
      visited[startIdx] = 1

      while (queue.length > 0) {
        const cur = queue.pop()!
        const cr = (cur / gridCols) | 0
        const cc = cur % gridCols
        pixels += gridCounts[cur]
        if (cc < minC) minC = cc
        if (cc > maxC) maxC = cc
        if (cr < minR) minR = cr
        if (cr > maxR) maxR = cr

        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue
            const nr = cr + dr
            const nc = cc + dc
            if (nr < 0 || nr >= gridRows || nc < 0 || nc >= gridCols) continue
            const nIdx = nr * gridCols + nc
            if (!visited[nIdx] && gridCounts[nIdx] > 0) {
              visited[nIdx] = 1
              queue.push(nIdx)
            }
          }
        }
      }

      const hx = minC * cellSize
      const hy = minR * cellSize
      const hw = Math.min(width - hx, (maxC - minC + 1) * cellSize)
      const hh = Math.min(height - hy, (maxR - minR + 1) * cellSize)
      hotspots.push({
        x: hx,
        y: hy,
        width: hw,
        height: hh,
        norm: [hx / width, hy / height, hw / width, hh / height],
        changedPixels: pixels,
      })
    }
  }

  hotspots.sort((a, b) => a.y - b.y || a.x - b.x)
  const diffRatio = totalPixels > 0 ? diffPixels / totalPixels : 0
  const diffPercent = Math.round(diffRatio * 10000) / 100

  return {
    width,
    height,
    diffPixels,
    totalPixels,
    diffRatio,
    diffPercent,
    rgba: out,
    hotspots,
  }
}

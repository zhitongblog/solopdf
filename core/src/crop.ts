/**
 * 自动白边检测与 PDF 裁切边距计算（iLovePDF Crop PDF 增强版）
 *
 * 支持两种输入源：
 *  1. 文本层 / OCR 归一化框（`OcrBox`，左上角原点 0..1）
 *  2. 渲染后的 RGBA 像素画布（扫描版 / 图表 PDF 同样能精准检测白边）
 *
 * 输出 PDF 物理点（pt）为单位的上下左右裁切边距 `[top, right, bottom, left]`，
 * 并支持奇偶页（装订线对称）独立边距统计。
 */
import type { OcrBox } from './reading-order.js'

export interface PageContentBoundsInput {
  /** 1-based 页码 */
  page: number
  /** 页面宽度（pt） */
  width: number
  /** 页面高度（pt） */
  height: number
  /** 页面内的内容框（归一化 0..1，左上原点） */
  boxes: Array<Pick<OcrBox, 'x' | 'y' | 'w' | 'h'>>
}

export interface AutoCropOptions {
  /** 内容框四周保留的安全留白（pt，默认 12pt） */
  paddingPt?: number
  /** 是否忽略页面极顶部/极底部的孤立页眉页脚小框（默认 false） */
  ignoreHeaderFooter?: boolean
}

export interface AutoCropResult {
  /** 全部页面统一安全边距 [top, right, bottom, left]（取各页最小可裁边距，绝不切掉任何页正文） */
  margins: [number, number, number, number]
  /** 奇数页安全边距 [top, right, bottom, left] */
  oddMargins: [number, number, number, number]
  /** 偶数页安全边距 [top, right, bottom, left] */
  evenMargins: [number, number, number, number]
  /** 统计到的有效内容页数 */
  analyzedPages: number
}

function clampMargin(val: number, maxDim: number): number {
  if (!Number.isFinite(val) || val < 0) return 0
  // 单侧最多裁掉 40%，防止极端空白页把整个页面裁没
  return Math.min(Math.round(val * 10) / 10, Math.floor(maxDim * 0.4))
}

function singlePageMargins(
  p: PageContentBoundsInput,
  paddingPt: number,
  ignoreHeaderFooter: boolean,
): [number, number, number, number] | null {
  let boxes = p.boxes.filter((b) => b.w > 0 && b.h > 0)
  if (!boxes.length || p.width <= 0 || p.height <= 0) return null

  if (ignoreHeaderFooter && boxes.length > 3) {
    const core = boxes.filter((b) => {
      const cy = b.y + b.h / 2
      return cy >= 0.06 && cy <= 0.94
    })
    if (core.length > 0) boxes = core
  }

  let minX = 1
  let minY = 1
  let maxX = 0
  let maxY = 0
  for (const b of boxes) {
    if (b.x < minX) minX = b.x
    if (b.y < minY) minY = b.y
    if (b.x + b.w > maxX) maxX = b.x + b.w
    if (b.y + b.h > maxY) maxY = b.y + b.h
  }
  minX = Math.max(0, minX)
  minY = Math.max(0, minY)
  maxX = Math.min(1, maxX)
  maxY = Math.min(1, maxY)
  if (maxX <= minX || maxY <= minY) return null

  const top = clampMargin(minY * p.height - paddingPt, p.height)
  const right = clampMargin((1 - maxX) * p.width - paddingPt, p.width)
  const bottom = clampMargin((1 - maxY) * p.height - paddingPt, p.height)
  const left = clampMargin(minX * p.width - paddingPt, p.width)
  return [top, right, bottom, left]
}

function combineSafeMargins(list: Array<[number, number, number, number]>): [number, number, number, number] {
  if (!list.length) return [0, 0, 0, 0]
  return [
    Math.min(...list.map((m) => m[0])),
    Math.min(...list.map((m) => m[1])),
    Math.min(...list.map((m) => m[2])),
    Math.min(...list.map((m) => m[3])),
  ]
}

/**
 * 根据多页的内容框计算最安全的自动裁白边参数。
 */
export function computeAutoCropMargins(
  pages: PageContentBoundsInput[],
  options: AutoCropOptions = {},
): AutoCropResult {
  const paddingPt = options.paddingPt ?? 12
  const ignoreHeaderFooter = options.ignoreHeaderFooter ?? false

  const all: Array<[number, number, number, number]> = []
  const odd: Array<[number, number, number, number]> = []
  const even: Array<[number, number, number, number]> = []

  for (const p of pages) {
    const m = singlePageMargins(p, paddingPt, ignoreHeaderFooter)
    if (!m) continue
    all.push(m)
    if (p.page % 2 === 1) odd.push(m)
    else even.push(m)
  }

  const margins = combineSafeMargins(all)
  const oddMargins = odd.length ? combineSafeMargins(odd) : margins
  const evenMargins = even.length ? combineSafeMargins(even) : margins

  return {
    margins,
    oddMargins,
    evenMargins,
    analyzedPages: all.length,
  }
}

/**
 * 从渲染好的 RGBA 像素缓冲区检测非空白区域（归一化 0..1 框）。
 * 适用于纯扫描件或含矢量图形的页面自动裁白边。
 *
 * @param rgba RGBA 像素数组（长度 = width * height * 4）
 * @param width 画布像素宽
 * @param height 画布像素高
 * @param luminanceThreshold 低于此亮度的像素视为有墨迹（0..255，默认 245）
 */
export function detectBitmapContentBox(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  luminanceThreshold = 245,
): { x: number; y: number; w: number; h: number } | null {
  if (width <= 0 || height <= 0 || rgba.length < width * height * 4) return null
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4
    for (let x = 0; x < width; x++) {
      const i = rowOffset + x * 4
      const a = rgba[i + 3]
      if (a < 16) continue
      const r = rgba[i]
      const g = rgba[i + 1]
      const b = rgba[i + 2]
      // 快速感知亮度近似
      const lum = (r * 77 + g * 150 + b * 29) >> 8
      if (lum < luminanceThreshold) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < minX || maxY < minY) return null
  return {
    x: minX / width,
    y: minY / height,
    w: (maxX - minX + 1) / width,
    h: (maxY - minY + 1) / height,
  }
}

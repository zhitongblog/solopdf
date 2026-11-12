/**
 * 密文涂黑真脱敏定位引擎（iLovePDF Redact PDF 本地核心）
 *
 * 支持：
 *  1. 内置隐私正则预设：手机号（中国大陆/国际）、电子邮箱、中国二代身份证号、银行卡号、IPv4 地址
 *  2. 自定义关键词列表（支持大小写敏感/不敏感）
 *  3. 自定义正则表达式
 *
 * 输入页面尺寸（pt）与带归一化坐标 `[x, y, w, h]`（左上原点 0..1）的文本 span，
 * 自动按字符宽度比例切分命中子串的精确矩形，并同时输出：
 *  - 归一化左上原点坐标（供 UI 预览高亮）
 *  - PDF 物理坐标 `[x1, y1, x2, y2]`（左下原点 pt，直接传给 `pdfops::redact_pdf` 剔除底层文字并涂黑）
 */

export type RedactPreset = 'phone' | 'email' | 'idcard' | 'bankcard' | 'ipv4'

export interface RedactSpanInput {
  /** 文本内容 */
  text: string
  /** 归一化左上角 x (0..1) */
  x: number
  /** 归一化左上角 y (0..1) */
  y: number
  /** 归一化宽度 w (0..1) */
  w: number
  /** 归一化高度 h (0..1) */
  h: number
}

export interface RedactPageInput {
  /** 1-based 页码 */
  page: number
  /** 页面物理宽度（pt） */
  width: number
  /** 页面物理高度（pt） */
  height: number
  /** 页面文本块 */
  spans: RedactSpanInput[]
}

export interface RedactSearchOptions {
  /** 自定义敏感词列表 */
  terms?: string[]
  /** 启用的内置隐私类型预设 */
  presets?: RedactPreset[]
  /** 自定义正则表达式字符串 */
  regex?: string
  /** 是否区分大小写（默认 false） */
  caseSensitive?: boolean
  /** 涂黑框外扩留白（pt，默认 1.5pt，确保完整遮盖字形边缘） */
  padPt?: number
}

export interface RedactMatchRect {
  /** 1-based 页码 */
  page: number
  /** 命中的敏感文本 */
  matchedText: string
  /** 匹配来源类型（如 'phone' | 'email' | 'term' | 'regex'） */
  kind: string
  /** PDF 物理坐标 [x1, y1, x2, y2]（左下角原点，单位 pt，可直接传给后端 redact_pdf） */
  rect: [number, number, number, number]
  /** 归一化左上原点坐标（供前端画布预览） */
  normBox: { x: number; y: number; w: number; h: number }
}

const PRESET_PATTERNS: Record<RedactPreset, RegExp> = {
  // 中国大陆 11 位手机号（含可选 +86 前缀与空格/短横分隔）
  phone: /(?:(?:\+|00)86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}\b/g,
  // 标准电子邮箱
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  // 18 位二代身份证号
  idcard: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
  // 16~19 位银行卡号（支持 4 位一格）
  bankcard: /\b(?:[3-6]\d{3}[\s-]?)(?:\d{4}[\s-]?){2}\d{4}(?:\d{1,3})?\b/g,
  // IPv4 地址
  ipv4: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 在多页文本层中定位所有敏感信息并返回 PDF 物理涂黑坐标与预览框。
 */
export function findRedactionRects(
  pages: RedactPageInput[],
  options: RedactSearchOptions,
): RedactMatchRect[] {
  const padPt = options.padPt ?? 1.5
  const flags = options.caseSensitive ? 'g' : 'gi'

  const matchers: Array<{ kind: string; re: RegExp }> = []

  for (const preset of options.presets ?? []) {
    const base = PRESET_PATTERNS[preset]
    if (base) {
      matchers.push({ kind: preset, re: new RegExp(base.source, base.flags) })
    }
  }

  const cleanTerms = (options.terms ?? []).map((t) => t.trim()).filter(Boolean)
  if (cleanTerms.length > 0) {
    // 按长度降序优先匹配长词
    const sorted = [...cleanTerms].sort((a, b) => b.length - a.length)
    const union = sorted.map(escapeRegExp).join('|')
    matchers.push({ kind: 'term', re: new RegExp(union, flags) })
  }

  if (options.regex?.trim()) {
    try {
      matchers.push({ kind: 'regex', re: new RegExp(options.regex.trim(), flags) })
    } catch {
      // 非法正则忽略，避免输入过程中抛错
    }
  }

  if (!matchers.length) return []

  const results: RedactMatchRect[] = []

  for (const p of pages) {
    if (p.width <= 0 || p.height <= 0) continue
    for (const span of p.spans) {
      const text = span.text
      if (!text || span.w <= 0 || span.h <= 0) continue
      const len = text.length

      for (const { kind, re } of matchers) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(text)) !== null) {
          const hit = m[0]
          if (!hit) {
            re.lastIndex++
            continue
          }
          const startIdx = m.index
          const endIdx = startIdx + hit.length

          // 按字符区间估算子框在 span 内的横向比例
          const ratioStart = startIdx / len
          const ratioEnd = endIdx / len
          const nx = span.x + span.w * ratioStart
          const nw = Math.max(0.002, span.w * (ratioEnd - ratioStart))
          const ny = span.y
          const nh = span.h

          // 转换为 PDF 物理点坐标（左下角原点 [x1, y1, x2, y2]）
          const x1 = Math.max(0, nx * p.width - padPt)
          const x2 = Math.min(p.width, (nx + nw) * p.width + padPt)
          const y2 = Math.min(p.height, (1 - ny) * p.height + padPt)
          const y1 = Math.max(0, (1 - (ny + nh)) * p.height - padPt)

          results.push({
            page: p.page,
            matchedText: hit,
            kind,
            rect: [
              Math.round(x1 * 100) / 100,
              Math.round(y1 * 100) / 100,
              Math.round(x2 * 100) / 100,
              Math.round(y2 * 100) / 100,
            ],
            normBox: { x: nx, y: ny, w: nw, h: nh },
          })
        }
      }
    }
  }

  return results
}

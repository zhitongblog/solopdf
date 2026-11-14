/**
 * Standard & Dynamic Vector Stamps (SVG + Data URL)
 *
 * Provides 8 localized standard rubber stamp presets plus dynamic custom stamps
 * with optional author, date, and subtitle lines rendered into crisp double-border SVGs.
 */

export type StampPresetId =
  | 'approved'
  | 'confidential'
  | 'draft'
  | 'final'
  | 'reviewed'
  | 'void'
  | 'urgent'
  | 'for-info'

export type StampLocale = 'zh-CN' | 'zh-TW' | 'en' | 'ja'

export interface StampPreset {
  id: StampPresetId
  color: string
  labels: {
    'zh-CN': string
    'zh-TW': string
    en: string
    ja: string
  }
  subLabel?: string
}

export const STAMP_PRESETS: readonly StampPreset[] = [
  {
    id: 'approved',
    color: '#16a34a',
    labels: {
      'zh-CN': '已批准',
      'zh-TW': '已核准',
      en: 'APPROVED',
      ja: '承認済',
    },
  },
  {
    id: 'confidential',
    color: '#dc2626',
    labels: {
      'zh-CN': '机密',
      'zh-TW': '機密',
      en: 'CONFIDENTIAL',
      ja: '極秘',
    },
  },
  {
    id: 'draft',
    color: '#d97706',
    labels: {
      'zh-CN': '草稿',
      'zh-TW': '草稿',
      en: 'DRAFT',
      ja: '草案',
    },
  },
  {
    id: 'final',
    color: '#16a34a',
    labels: {
      'zh-CN': '定稿',
      'zh-TW': '定稿',
      en: 'FINAL',
      ja: '最終版',
    },
  },
  {
    id: 'reviewed',
    color: '#2563eb',
    labels: {
      'zh-CN': '已审阅',
      'zh-TW': '已審閱',
      en: 'REVIEWED',
      ja: '確認済',
    },
  },
  {
    id: 'void',
    color: '#dc2626',
    labels: {
      'zh-CN': '作废',
      'zh-TW': '作廢',
      en: 'VOID',
      ja: '無効',
    },
  },
  {
    id: 'urgent',
    color: '#dc2626',
    labels: {
      'zh-CN': '紧急',
      'zh-TW': '緊急',
      en: 'URGENT',
      ja: '至急',
    },
  },
  {
    id: 'for-info',
    color: '#475569',
    labels: {
      'zh-CN': '仅供参考',
      'zh-TW': '僅供參考',
      en: 'FOR INFORMATION',
      ja: '参考用',
    },
  },
] as const

export interface StampRenderSpec {
  presetId?: StampPresetId
  customText?: string
  subText?: string
  author?: string
  date?: string
  locale?: string
  color?: string
}

function resolveStampLocale(locale?: string): StampLocale {
  if (!locale) return 'en'
  const lower = locale.trim().toLowerCase()
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant') return 'zh-TW'
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('ja')) return 'ja'
  return 'en'
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Render a self-contained SVG string with a double-border rounded stamp frame,
 * bold primary text, and optional second line for subText / author / date.
 */
export function renderStampSvg(spec: StampRenderSpec): string {
  const preset = STAMP_PRESETS.find((p) => p.id === spec.presetId) ?? STAMP_PRESETS[0]
  const loc = resolveStampLocale(spec.locale)

  const primaryText = (spec.customText?.trim() || preset.labels[loc] || preset.labels.en).trim()
  const color = (spec.color?.trim() || preset.color || '#dc2626').trim()

  const metaParts = [
    spec.subText?.trim() || preset.subLabel?.trim() || '',
    spec.author?.trim() || '',
    spec.date?.trim() || '',
  ].filter(Boolean)
  const secondaryText = metaParts.join(' • ')

  const hasSubLine = secondaryText.length > 0
  const width = Math.min(380, Math.max(200, primaryText.length * 18 + 64, secondaryText.length * 9 + 64))
  const height = hasSubLine ? 84 : 68
  const cx = width / 2

  const primaryY = hasSubLine ? 39 : 42
  const subY = 62

  const escapedPrimary = escapeXml(primaryText)
  const escapedSecondary = escapeXml(secondaryText)
  const escapedColor = escapeXml(color)

  const subLineElement = hasSubLine
    ? `\n  <text x="${cx}" y="${subY}" text-anchor="middle" fill="${escapedColor}" font-family="system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="11" font-weight="600" letter-spacing="0.5">${escapedSecondary}</text>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <rect x="3" y="3" width="${width - 6}" height="${height - 6}" rx="8" ry="8" fill="${escapedColor}" fill-opacity="0.08" stroke="${escapedColor}" stroke-width="3"/>
  <rect x="8" y="8" width="${width - 16}" height="${height - 16}" rx="5" ry="5" fill="none" stroke="${escapedColor}" stroke-width="1.2" stroke-dasharray="4 2"/>
  <text x="${cx}" y="${primaryY}" text-anchor="middle" fill="${escapedColor}" font-family="system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="22" font-weight="800" letter-spacing="1.5">${escapedPrimary}</text>${subLineElement}
</svg>`
}

/**
 * Convert a stamp specification into a `data:image/svg+xml;utf8,...` URL ready for `<img src>` or Canvas.
 */
export function stampToDataUrl(spec: StampRenderSpec): string {
  const svg = renderStampSvg(spec)
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

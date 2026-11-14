/**
 * 3-Tier In-App Purchase Tip Jar & Supporter Badge Logic (matching SoloMD)
 *
 * SoloPDF is 100% free with zero feature paywalls. Users who tip via the
 * Tip Jar receive a cosmetic Supporter Badge in the app header & About dialog.
 */

export type SupporterTier = 'coffee' | 'meal' | 'feast'

export interface TipTierSpec {
  id: SupporterTier
  tier: SupporterTier
  productId: string
  emoji: string
  icon: string
  priceCny: string
  priceUsd: string
  amountCny: number
  amountUsd: number
  labels: {
    'zh-CN': string
    'zh-TW': string
    en: string
    ja: string
  }
  descriptions: {
    'zh-CN': string
    'zh-TW': string
    en: string
    ja: string
  }
}

export const TIP_TIERS: readonly TipTierSpec[] = [
  {
    id: 'coffee',
    tier: 'coffee',
    productId: 'app.solopdf.tip.coffee',
    emoji: '☕',
    icon: '☕',
    priceCny: '¥8',
    priceUsd: '$0.99',
    amountCny: 8,
    amountUsd: 0.99,
    labels: {
      'zh-CN': '请喝杯咖啡',
      'zh-TW': '請喝杯咖啡',
      en: 'Buy a Coffee',
      ja: 'コーヒーを奢る',
    },
    descriptions: {
      'zh-CN': '为深夜写代码的开发者续上一杯热美式',
      'zh-TW': '為深夜寫程式的開發者續上一杯熱美式',
      en: 'Fuel late-night coding with a warm cup of coffee',
      ja: '深夜の開発を温かいコーヒーで応援',
    },
  },
  {
    id: 'meal',
    tier: 'meal',
    productId: 'app.solopdf.tip.meal',
    emoji: '🍜',
    icon: '🍜',
    priceCny: '¥28',
    priceUsd: '$2.99',
    amountCny: 28,
    amountUsd: 2.99,
    labels: {
      'zh-CN': '请吃顿工作餐',
      'zh-TW': '請吃頓工作餐',
      en: 'Buy a Meal',
      ja: 'ランチを奢る',
    },
    descriptions: {
      'zh-CN': '一碗热腾腾的拉面，助力持续打磨本地 PDF 体验',
      'zh-TW': '一碗熱騰騰的拉麵，助力持續打磨本地 PDF 體驗',
      en: 'A hearty bowl of ramen to keep SoloPDF fast and local-first',
      ja: '美味しいラーメンでローカルPDF体験の改善を応援',
    },
  },
  {
    id: 'feast',
    tier: 'feast',
    productId: 'app.solopdf.tip.feast',
    emoji: '🚀',
    icon: '🚀',
    priceCny: '¥68',
    priceUsd: '$9.99',
    amountCny: 68,
    amountUsd: 9.99,
    labels: {
      'zh-CN': '豪华大餐赞助',
      'zh-TW': '豪華大餐贊助',
      en: 'Sponsor a Feast',
      ja: 'ごちそうスポンサー',
    },
    descriptions: {
      'zh-CN': '解锁最高级别火箭赞助徽章，致敬纯粹的独立软件精神',
      'zh-TW': '解鎖最高級別火箭贊助徽章，致敬純粹的獨立軟體精神',
      en: 'Unlock the highest Rocket Patron badge and champion indie software',
      ja: '最高ランクのロケットバッジを解放しインディー開発を支援',
    },
  },
] as const

export interface SupporterBadgeMeta {
  tier: SupporterTier
  emoji: string
  icon: string
  color: string
  title: string
  labels: {
    'zh-CN': string
    'zh-TW': string
    en: string
    ja: string
  }
}

export const SUPPORTER_BADGE: Record<SupporterTier, SupporterBadgeMeta> = {
  coffee: {
    tier: 'coffee',
    emoji: '☕',
    icon: '☕',
    color: '#d97706',
    title: 'Coffee Supporter',
    labels: {
      'zh-CN': '咖啡支持者',
      'zh-TW': '咖啡支持者',
      en: 'Coffee Supporter',
      ja: 'コーヒーサポーター',
    },
  },
  meal: {
    tier: 'meal',
    emoji: '🍜',
    icon: '🍜',
    color: '#2563eb',
    title: 'Meal Supporter',
    labels: {
      'zh-CN': '加餐支持者',
      'zh-TW': '加餐支持者',
      en: 'Meal Supporter',
      ja: 'ランチサポーター',
    },
  },
  feast: {
    tier: 'feast',
    emoji: '🚀',
    icon: '🚀',
    color: '#7c3aed',
    title: 'Feast Patron',
    labels: {
      'zh-CN': '火箭赞助人',
      'zh-TW': '火箭贊助人',
      en: 'Feast Patron',
      ja: 'ロケットパトロン',
    },
  },
}

export interface SupporterRecord {
  highestTier: SupporterTier | null
  tier: SupporterTier | null
  tipCount: number
  count: number
  purchasedProductIds: string[]
  firstSupportedAt: string | null
  lastSupportedAt: string | null
}

const TIER_RANK: Record<SupporterTier, number> = {
  coffee: 1,
  meal: 2,
  feast: 3,
}

/**
 * Resolve a `SupporterTier` from an IAP product ID (e.g. `'app.solopdf.tip.coffee'`) or tier key.
 */
export function tierFromProductId(productId: string | null | undefined): SupporterTier | null {
  if (!productId) return null
  const normalized = productId.trim().toLowerCase()
  const exact = TIP_TIERS.find(
    (t) => t.productId.toLowerCase() === normalized || t.tier === normalized,
  )
  if (exact) return exact.tier
  if (normalized.endsWith('.coffee')) return 'coffee'
  if (normalized.endsWith('.meal')) return 'meal'
  if (normalized.endsWith('.feast')) return 'feast'
  return null
}

function higherTier(a: SupporterTier | null | undefined, b: SupporterTier | null | undefined): SupporterTier | null {
  const rankA = a ? (TIER_RANK[a] ?? 0) : 0
  const rankB = b ? (TIER_RANK[b] ?? 0) : 0
  if (rankA === 0 && rankB === 0) return null
  return rankB > rankA ? b! : a!
}

/**
 * Return localized badge display information for a supporter record or tier.
 */
export function badgeInfo(
  recordOrTier: Partial<SupporterRecord> | SupporterTier | null | undefined,
  locale = 'zh-CN',
): (SupporterBadgeMeta & { label: string }) | null {
  if (!recordOrTier) return null
  const tier: SupporterTier | null =
    typeof recordOrTier === 'string'
      ? tierFromProductId(recordOrTier)
      : (recordOrTier.highestTier ?? recordOrTier.tier ?? null)

  if (!tier || !SUPPORTER_BADGE[tier]) return null
  const meta = SUPPORTER_BADGE[tier]
  const loc = locale.toLowerCase()
  let label = meta.labels['zh-CN']
  if (loc === 'zh-tw' || loc === 'zh-hk' || loc === 'zh-hant') {
    label = meta.labels['zh-TW']
  } else if (loc.startsWith('en')) {
    label = meta.labels.en
  } else if (loc.startsWith('ja')) {
    label = meta.labels.ja
  }

  return {
    ...meta,
    label,
  }
}

/**
 * Merge a newly purchased `productId` (or another `Partial<SupporterRecord>`) into an existing `SupporterRecord`.
 * Preserves the highest unlocked tier, increments tip count, and records timestamps.
 */
export function mergeSupporterRecord(
  existing: Partial<SupporterRecord> | null | undefined,
  incoming: string | Partial<SupporterRecord>,
  nowIso: string = new Date().toISOString(),
): SupporterRecord {
  const prevTier = existing?.highestTier ?? existing?.tier ?? null
  const prevCount = existing?.tipCount ?? existing?.count ?? 0
  const prevIds = existing?.purchasedProductIds ? [...existing.purchasedProductIds] : []
  const prevFirst = existing?.firstSupportedAt ?? null
  const prevLast = existing?.lastSupportedAt ?? null

  if (typeof incoming === 'string') {
    const newTier = tierFromProductId(incoming)
    const canonicalProduct =
      TIP_TIERS.find((t) => t.tier === newTier)?.productId ?? incoming.trim()

    if (!newTier) {
      return {
        highestTier: prevTier,
        tier: prevTier,
        tipCount: prevCount,
        count: prevCount,
        purchasedProductIds: prevIds,
        firstSupportedAt: prevFirst,
        lastSupportedAt: prevLast,
      }
    }

    const best = higherTier(prevTier, newTier)
    const nextCount = prevCount + 1
    const nextIds = prevIds.includes(canonicalProduct)
      ? prevIds
      : [...prevIds, canonicalProduct]

    return {
      highestTier: best,
      tier: best,
      tipCount: nextCount,
      count: nextCount,
      purchasedProductIds: nextIds,
      firstSupportedAt: prevFirst ?? nowIso,
      lastSupportedAt: nowIso,
    }
  }

  const incTier = incoming.highestTier ?? incoming.tier ?? null
  const incIds = incoming.purchasedProductIds ?? []
  let best = higherTier(prevTier, incTier)
  for (const pid of incIds) {
    best = higherTier(best, tierFromProductId(pid))
  }

  const mergedIds = Array.from(new Set([...prevIds, ...incIds]))
  const incCount = incoming.tipCount ?? incoming.count ?? (incIds.length || (incTier ? 1 : 0))
  const totalCount = Math.max(prevCount + incCount, mergedIds.length)

  const firstAt =
    prevFirst && incoming.firstSupportedAt
      ? prevFirst < incoming.firstSupportedAt
        ? prevFirst
        : incoming.firstSupportedAt
      : (prevFirst ?? incoming.firstSupportedAt ?? (best ? nowIso : null))

  const lastAt =
    prevLast && incoming.lastSupportedAt
      ? prevLast > incoming.lastSupportedAt
        ? prevLast
        : incoming.lastSupportedAt
      : (incoming.lastSupportedAt ?? prevLast ?? (best ? nowIso : null))

  return {
    highestTier: best,
    tier: best,
    tipCount: totalCount,
    count: totalCount,
    purchasedProductIds: mergedIds,
    firstSupportedAt: firstAt,
    lastSupportedAt: lastAt,
  }
}

import { ref, computed } from 'vue'
import {
  TIP_TIERS,
  SUPPORTER_BADGE,
  badgeInfo,
  mergeSupporterRecord,
  tierFromProductId,
  type SupporterRecord,
  type TipTierSpec,
  type SupporterTier,
} from '@solopdf/core'
import { isTauri } from './platform'

export {
  TIP_TIERS,
  SUPPORTER_BADGE,
  badgeInfo,
  mergeSupporterRecord,
  tierFromProductId,
  type SupporterRecord,
  type TipTierSpec,
  type SupporterTier,
}

const STORAGE_KEY = 'solopdf.supporter.v1'

export interface IapProductInfo {
  productId: string
  tier: string
  displayPrice: string
  title: string
  description: string
}

export interface IapNativeState {
  supported: boolean
  useStoreFlow: boolean
  platform: string
  purchasedProductIds: string[]
}

export interface IapPurchaseResult {
  success: boolean
  cancelled: boolean
  productId: string
  transactionId?: string | null
  error?: string | null
}

function defaultSupporterRecord(): SupporterRecord {
  return {
    highestTier: null,
    tier: null,
    tipCount: 0,
    count: 0,
    purchasedProductIds: [],
    firstSupportedAt: null,
    lastSupportedAt: null,
  }
}

function loadLocalSupporterRecord(): SupporterRecord {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultSupporterRecord()
    const parsed = JSON.parse(raw) as Partial<SupporterRecord>
    return mergeSupporterRecord(defaultSupporterRecord(), parsed)
  } catch {
    return defaultSupporterRecord()
  }
}

function saveLocalSupporterRecord(rec: SupporterRecord): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rec))
  } catch {
    // ignore storage quota errors
  }
}

export const supporterRecord = ref<SupporterRecord>(loadLocalSupporterRecord())
export const storeProducts = ref<Record<string, IapProductInfo>>({})
export const iapNativeSupported = ref(false)
export const iapUseStoreFlow = ref(false)

export const isSupporter = computed(() =>
  Boolean(
    supporterRecord.value.highestTier ||
      supporterRecord.value.purchasedProductIds.length > 0,
  ),
)

export async function initSupporterState(): Promise<void> {
  if (!isTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const state = await invoke<IapNativeState>('iap_get_state')
    iapNativeSupported.value = Boolean(state.supported)
    iapUseStoreFlow.value = Boolean(state.useStoreFlow)
    if (state.purchasedProductIds && state.purchasedProductIds.length > 0) {
      supporterRecord.value = mergeSupporterRecord(supporterRecord.value, {
        purchasedProductIds: state.purchasedProductIds,
      })
      saveLocalSupporterRecord(supporterRecord.value)
    }
  } catch {
    // non-fatal if IAP command is unavailable
  }
}

export async function fetchStoreProducts(): Promise<IapProductInfo[]> {
  if (!isTauri()) return []
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const items = await invoke<IapProductInfo[]>('iap_fetch_products')
    const map: Record<string, IapProductInfo> = {}
    for (const item of items) {
      map[item.productId] = item
    }
    storeProducts.value = map
    return items
  } catch {
    return []
  }
}

export async function purchaseTipTier(productId: string): Promise<IapPurchaseResult> {
  if (!isTauri()) {
    return {
      success: false,
      cancelled: false,
      productId,
      error: 'Web environment does not support native in-app purchases',
    }
  }
  const { invoke } = await import('@tauri-apps/api/core')
  const res = await invoke<IapPurchaseResult>('iap_purchase', { productId })
  if (res.success) {
    supporterRecord.value = mergeSupporterRecord(supporterRecord.value, productId)
    saveLocalSupporterRecord(supporterRecord.value)
  }
  return res
}

export async function restoreSupporterPurchases(): Promise<string[]> {
  if (!isTauri()) return supporterRecord.value.purchasedProductIds
  const { invoke } = await import('@tauri-apps/api/core')
  const ids = await invoke<string[]>('iap_restore')
  if (ids.length > 0) {
    supporterRecord.value = mergeSupporterRecord(supporterRecord.value, {
      purchasedProductIds: ids,
    })
    saveLocalSupporterRecord(supporterRecord.value)
  }
  return supporterRecord.value.purchasedProductIds
}

export function activateSupporterBadgeLocally(
  productId = 'app.solopdf.tip.coffee',
): void {
  supporterRecord.value = mergeSupporterRecord(supporterRecord.value, productId)
  saveLocalSupporterRecord(supporterRecord.value)
}

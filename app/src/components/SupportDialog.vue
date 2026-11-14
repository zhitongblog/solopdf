<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { t, currentLocale, localeRef } from '../i18n'
import { openExternal } from '../platform'
import {
  TIP_TIERS,
  SUPPORTER_BADGE,
  badgeInfo,
  supporterRecord,
  isSupporter,
  storeProducts,
  iapUseStoreFlow,
  initSupporterState,
  fetchStoreProducts,
  purchaseTipTier,
  restoreSupporterPurchases,
  activateSupporterBadgeLocally,
  type TipTierSpec,
} from '../supporter'

const emit = defineEmits<{ (e: 'close'): void }>()

const busyProductId = ref<string | null>(null)
const restoring = ref(false)
const feedbackMsg = ref<string | null>(null)
const feedbackKind = ref<'ok' | 'err'>('ok')

onMounted(async () => {
  await initSupporterState()
  await fetchStoreProducts()
})

const activeBadge = computed(() => {
  const loc = currentLocale.value
  return (
    badgeInfo(supporterRecord.value, loc) ?? {
      icon: SUPPORTER_BADGE.coffee.icon,
      label: SUPPORTER_BADGE.coffee.labels[loc] || SUPPORTER_BADGE.coffee.labels['en'],
    }
  )
})

const badgeLabel = computed(() => activeBadge.value.label)

const badgeDesc = computed(() => t('sup.settingsSub'))

function tierTitle(spec: TipTierSpec): string {
  const prod = storeProducts.value[spec.productId]
  if (prod?.title) return prod.title
  return t(`sup.tier.${spec.tier}.title`)
}

function tierSubtitle(spec: TipTierSpec): string {
  const prod = storeProducts.value[spec.productId]
  if (prod?.description) return prod.description
  return t(`sup.tier.${spec.tier}.sub`)
}

function tierPrice(spec: TipTierSpec): string {
  const prod = storeProducts.value[spec.productId]
  if (prod?.displayPrice) return prod.displayPrice
  const loc = currentLocale.value
  if (loc === 'zh-CN') return spec.priceCny
  return spec.priceUsd
}

async function onSelectTier(spec: TipTierSpec): Promise<void> {
  if (busyProductId.value) return
  feedbackMsg.value = null
  busyProductId.value = spec.productId
  try {
    if (iapUseStoreFlow.value) {
      const res = await purchaseTipTier(spec.productId)
      if (res.success) {
        feedbackKind.value = 'ok'
        feedbackMsg.value = t('sup.thanks')
      } else if (!res.cancelled) {
        feedbackKind.value = 'err'
        feedbackMsg.value = res.error || t('sup.purchaseFailed')
      }
    } else {
      await openExternal('https://solopdf.doaipm.com/#sponsor')
      activateSupporterBadgeLocally(spec.productId)
      feedbackKind.value = 'ok'
      feedbackMsg.value = t('sup.thanks')
    }
  } catch (e) {
    feedbackKind.value = 'err'
    feedbackMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    busyProductId.value = null
  }
}

async function onRestore(): Promise<void> {
  if (restoring.value) return
  restoring.value = true
  feedbackMsg.value = null
  try {
    const ids = await restoreSupporterPurchases()
    if (ids.length > 0) {
      feedbackKind.value = 'ok'
      feedbackMsg.value = t('sup.restored')
    } else {
      feedbackKind.value = 'err'
      feedbackMsg.value = t('sup.restoreNone')
    }
  } catch (e) {
    feedbackKind.value = 'err'
    feedbackMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <div class="modal-mask" :data-l="localeRef" @click.self="emit('close')">
    <div class="support-dialog" role="dialog" :aria-label="t('sup.title')">
      <header class="support-header">
        <div class="support-title-row">
          <span class="support-heart">❤️</span>
          <h2>{{ t('sup.title') }}</h2>
        </div>
        <button class="support-close" @click="emit('close')" :title="t('st.done')">✕</button>
      </header>

      <div class="support-body">
        <p class="support-intro">{{ t('sup.intro') }}</p>

        <div class="support-badge-card" :class="{ active: isSupporter }">
          <div class="badge-icon">{{ activeBadge.icon }}</div>
          <div class="badge-info">
            <div class="badge-name">
              <span>{{ badgeLabel }}</span>
              <span v-if="isSupporter" class="badge-unlocked">{{ t('sup.unlocked') }}</span>
            </div>
            <div class="badge-desc">{{ badgeDesc }}</div>
          </div>
          <div v-if="supporterRecord.tipCount > 0" class="badge-count">
            ×{{ supporterRecord.tipCount }}
          </div>
        </div>

        <div class="support-tiers">
          <button
            v-for="spec in TIP_TIERS"
            :key="spec.productId"
            class="tier-card"
            :disabled="busyProductId !== null"
            @click="onSelectTier(spec)"
          >
            <div class="tier-emoji">{{ spec.emoji }}</div>
            <div class="tier-meta">
              <div class="tier-title">{{ tierTitle(spec) }}</div>
              <div class="tier-sub">{{ tierSubtitle(spec) }}</div>
            </div>
            <div class="tier-price">
              <span v-if="busyProductId === spec.productId">…</span>
              <span v-else>{{ tierPrice(spec) }}</span>
            </div>
          </button>
        </div>

        <div v-if="feedbackMsg" class="support-feedback" :class="feedbackKind">
          {{ feedbackMsg }}
        </div>

        <footer class="support-footer">
          <span class="support-note">{{ t('sup.note') }}</span>
          <button class="support-restore" :disabled="restoring" @click="onRestore">
            {{ restoring ? '…' : t('sup.restore') }}
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.support-dialog {
  width: min(460px, 92vw);
  background: var(--bg-panel);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}

.support-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.support-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.support-title-row h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.support-heart {
  font-size: 18px;
}

.support-close {
  border: none;
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
  font-size: 15px;
  padding: 4px 8px;
  border-radius: 6px;
}

.support-close:hover {
  background: var(--accent-soft);
  color: var(--fg);
}

.support-body {
  padding: 16px 18px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.support-intro {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--fg-dim);
}

.support-badge-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px dashed var(--border);
  background: var(--bg-chrome);
  transition: all 0.2s ease;
}

.support-badge-card.active {
  border-style: solid;
  border-color: var(--accent);
  background: var(--accent-soft);
}

.badge-icon {
  font-size: 24px;
}

.badge-info {
  flex: 1;
  min-width: 0;
}

.badge-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.badge-unlocked {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-weight: 500;
}

.badge-desc {
  font-size: 12px;
  color: var(--fg-dim);
  margin-top: 2px;
}

.badge-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
}

.support-tiers {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tier-card {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  text-align: left;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  cursor: pointer;
  transition: border-color 0.15s ease, transform 0.1s ease;
}

.tier-card:hover:not(:disabled) {
  border-color: var(--accent);
  transform: translateY(-1px);
}

.tier-card:disabled {
  opacity: 0.6;
  cursor: wait;
}

.tier-emoji {
  font-size: 22px;
}

.tier-meta {
  flex: 1;
  min-width: 0;
}

.tier-title {
  font-size: 14px;
  font-weight: 600;
}

.tier-sub {
  font-size: 12px;
  color: var(--fg-dim);
  margin-top: 2px;
}

.tier-price {
  font-size: 13px;
  font-weight: 600;
  padding: 5px 11px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
}

.support-feedback {
  font-size: 12.5px;
  padding: 8px 12px;
  border-radius: 8px;
}

.support-feedback.ok {
  background: rgba(46, 160, 67, 0.14);
  color: #2ea043;
}

.support-feedback.err {
  background: rgba(218, 54, 51, 0.14);
  color: #da3633;
}

.support-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 4px;
}

.support-note {
  font-size: 11.5px;
  color: var(--fg-dim);
}

.support-restore {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
}

.support-restore:hover {
  text-decoration: underline;
}
</style>

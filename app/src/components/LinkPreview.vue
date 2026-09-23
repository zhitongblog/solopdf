<script setup lang="ts">
/**
 * Hover / long-press preview for an internal link or a smart reference
 * ("Figure 3", "[12]", "Eq. (4)"): a rendered crop of the destination, not
 * the whole page. Clicking it follows the link.
 *
 * Mouse previews come and go with the pointer (the owner hides them with a
 * short grace period so the pointer can travel into the popup); touch
 * previews stay until tapped or dismissed. On a phone the popup docks to the
 * bottom edge so it never covers the line the finger is on.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { controllers } from '../store'
import { t } from '../i18n'
import type { PreviewRequest } from '../viewer/controller'

const props = defineProps<{ req: PreviewRequest; tabId: number }>()
const emit = defineEmits<{ follow: []; close: []; hover: [inside: boolean] }>()

const host = ref<HTMLDivElement>()
const loading = ref(true)
const failed = ref(false)
const phone = computed(() => window.innerWidth < 560)
/** box the rendered crop must fit in */
const maxW = computed(() => Math.min(420, window.innerWidth - 24))
const maxH = computed(() => Math.min(360, window.innerHeight * 0.45))
/** the crop's on-screen size (rotation-aware), known before it renders */
const size = computed(() => {
  const r = props.req
  const ctrl = controllers.get(props.tabId)
  if (!ctrl || r.page == null || !r.region) return { w: maxW.value, h: 40 }
  return ctrl.regionSize(r.page, r.region, maxW.value, maxH.value)
})
/** header + padding around the crop */
const CHROME_H = 50
const kindLabel = computed(() => {
  const k = props.req.kind
  return k === 'link' ? t('lp.link') : k === 'url' ? t('lp.url') : t(`lp.${k}`)
})

const style = computed(() => {
  const w = Math.max(220, size.value.w + 16)
  if (phone.value) return { width: `${w}px` }
  const a = props.req.anchor
  const h = size.value.h + CHROME_H
  const vh = window.innerHeight
  // below the anchor if it fits, else above, else whichever side has more
  // room — and never off-screen (a tall rotated link has little of either)
  let top = a.bottom + 8
  if (top + h > vh - 8) {
    top = a.top - 8 - h
    if (top < 8) top = vh - a.bottom > a.top ? Math.min(a.bottom + 8, vh - h - 8) : 8
  }
  top = Math.max(8, Math.min(top, vh - h - 8))
  const left = Math.min(window.innerWidth - w - 8, Math.max(8, a.left + a.width / 2 - w / 2))
  return { left: `${left}px`, top: `${top}px`, width: `${w}px` }
})

let seq = 0
async function render(): Promise<void> {
  const my = ++seq
  loading.value = true
  failed.value = false
  const r = props.req
  const ctrl = controllers.get(props.tabId)
  const slot = host.value
  if (!slot) return
  slot.textContent = ''
  if (!ctrl || r.page == null || !r.region) { loading.value = false; return }
  try {
    const canvas = await ctrl.renderRegion(r.page, r.region, maxW.value, maxH.value)
    if (my !== seq) return
    slot.appendChild(canvas)
  } catch {
    if (my === seq) failed.value = true
  } finally {
    if (my === seq) loading.value = false
  }
}
onMounted(render)
watch(() => props.req, render, { flush: 'post' })

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}
/** touch previews: a tap anywhere else dismisses */
function onDocDown(e: PointerEvent): void {
  if (!props.req.touch) return
  const el = document.querySelector('.lp-pop')
  if (el && !el.contains(e.target as Node)) emit('close')
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  document.addEventListener('pointerdown', onDocDown, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('pointerdown', onDocDown, true)
})
</script>

<template>
  <div
    class="lp-pop"
    :class="{ phone, touch: req.touch }"
    :style="style"
    role="dialog"
    @mouseenter="emit('hover', true)"
    @mouseleave="emit('hover', false)"
  >
    <div class="lp-head">
      <span class="lp-kind">{{ kindLabel }}</span>
      <span class="lp-label" :title="req.label">{{ req.label }}</span>
      <button v-if="req.touch" class="lp-close" :title="t('lp.close')" @click.stop="emit('close')">✕</button>
    </div>
    <button v-if="req.kind === 'url'" class="lp-open" @click="emit('follow')">{{ t('lp.openUrl') }}</button>
    <div v-else class="lp-body" :title="t('lp.jumpTip')" @click="emit('follow')">
      <div ref="host" class="lp-canvas"></div>
      <div v-if="loading" class="lp-status">…</div>
      <div v-else-if="failed" class="lp-status">{{ t('lp.failed') }}</div>
    </div>
  </div>
</template>

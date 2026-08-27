<script setup lang="ts">
/**
 * Comic reader.
 *
 * Comics are their own thing: no text layer, no reflow, and reading
 * direction is a per-book property (manga runs right to left). So this is a
 * separate view rather than a mode of the PDF one — the shared parts are the
 * tab, the position memory, and the bookmark, which is exactly the right
 * amount of sharing.
 *
 * Phones flick; desktops arrow-key and click the page edges. Both get the
 * same double-page option, defaulting on only where there is width for it.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { store, comicBooks } from '../store'
import { isMobile } from '../platform'
import { t } from '../i18n'

const props = defineProps<{ tabId: number }>()
const emit = defineEmits<{ chrome: [] }>()

const book = computed(() => { void store.docTick; return comicBooks.get(props.tabId) })
const tab = computed(() => store.tabs.find((x) => x.id === props.tabId))
const host = ref<HTMLDivElement>()
const settingsOpen = ref(false)
const phone = computed(() => isMobile() || window.innerWidth < 700)

const s = computed(() => store.settings.comic)
/** two-up only where two pages actually fit */
const double = computed(() => s.value.spread === 2 && (host.value?.clientWidth ?? innerWidth) >= 760)

const index = computed({
  get: () => Math.max(0, (tab.value?.currentPage ?? 1) - 1),
  set: (v: number) => { if (tab.value) tab.value.currentPage = v + 1 },
})
const total = computed(() => book.value?.pages.length ?? 0)

/** page indices on screen, already in reading order for the direction */
const shown = computed<number[]>(() => {
  const i = index.value
  if (!double.value || i >= total.value - 1) return [i]
  return s.value.rtl ? [i + 1, i] : [i, i + 1]
})

const urls = computed(() => {
  // docTick is the signal an async source (DjVu renders in Rust) uses to say
  // "a page landed" — without it the view would show a permanent blank
  void store.docTick
  const b = book.value
  if (!b) return []
  return shown.value.map((i) => ({ i, url: b.urlFor(i) }))
})

function turn(dir: 1 | -1): void {
  const step = double.value ? 2 : 1
  const next = index.value + dir * step
  index.value = Math.min(Math.max(next, 0), Math.max(0, total.value - 1))
}

/** in RTL books the right edge is "previous", like a paper manga */
function edgeTurn(fraction: number): void {
  const forward = s.value.rtl ? fraction < 0.35 : fraction > 0.65
  const back = s.value.rtl ? fraction > 0.65 : fraction < 0.35
  if (forward) turn(1)
  else if (back) turn(-1)
}

function onClick(e: MouseEvent): void {
  if (settingsOpen.value) { settingsOpen.value = false; return }
  const rect = host.value?.getBoundingClientRect()
  if (!rect) return
  edgeTurn((e.clientX - rect.left) / rect.width)
}

let touchX = 0
let touchY = 0
function onTouchStart(e: TouchEvent): void {
  touchX = e.touches[0].clientX
  touchY = e.touches[0].clientY
}
function onTouchEnd(e: TouchEvent): void {
  const dx = e.changedTouches[0].clientX - touchX
  const dy = e.changedTouches[0].clientY - touchY
  if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
    // swiping left means "next" in a left-to-right book, "previous" in manga
    turn(dx < 0 ? (s.value.rtl ? -1 : 1) : (s.value.rtl ? 1 : -1))
  }
}

function onKey(e: KeyboardEvent): void {
  if (store.activeTabId !== props.tabId) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return
  const eat = (): void => { e.preventDefault(); e.stopPropagation() }
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown' || e.key === 'j') { eat(); turn(s.value.rtl ? -1 : 1) }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'k') { eat(); turn(s.value.rtl ? 1 : -1) }
  else if (e.key === 'Home') { eat(); index.value = 0 }
  else if (e.key === 'End') { eat(); index.value = Math.max(0, total.value - 1) }
}

// memory budget: keep a small window of decoded pages around the reader
watch([index, () => s.value.spread], () => {
  book.value?.trim(index.value - 2, index.value + 3)
})

onMounted(() => window.addEventListener('keydown', onKey, { capture: true }))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, { capture: true } as never))
</script>

<template>
  <div
    ref="host"
    class="cm-view"
    :class="[`cm-fit-${s.fit}`, { rtl: s.rtl }]"
    @click="onClick"
    @touchstart="onTouchStart"
    @touchend="onTouchEnd"
  >
    <div v-if="!total" class="cm-empty">{{ t('cm.empty') }}</div>
    <div v-else class="cm-stage">
      <template v-for="p in urls" :key="p.i">
        <img v-if="p.url" :src="p.url" :alt="`${p.i + 1}`" />
        <div v-else class="cm-loading">{{ t('cm.rendering') }}</div>
      </template>
    </div>

    <div class="cm-bar" @click.stop>
      <button @click="turn(s.rtl ? 1 : -1)">‹</button>
      <span>{{ index + 1 }}<template v-if="double && shown.length > 1">–{{ Math.max(...shown) + 1 }}</template> / {{ total }}</span>
      <button @click="turn(s.rtl ? -1 : 1)">›</button>
      <input
        class="cm-slider" type="range" min="0" :max="Math.max(0, total - 1)"
        :value="index" @input="index = Number(($event.target as HTMLInputElement).value)"
      />
    </div>

    <button class="bk-chrome-btn" :title="t('bk.chrome')" @click.stop="emit('chrome')">‹</button>
    <button class="bk-aa" :title="t('cm.settings')" @click.stop="settingsOpen = !settingsOpen">⚙</button>

    <div v-if="settingsOpen" class="bk-settings" @click.stop>
      <div class="bk-row">
        <label>{{ t('cm.spread') }}</label>
        <select v-model.number="s.spread">
          <option :value="1">{{ t('vm.single') }}</option>
          <option :value="2">{{ t('vm.facing') }}</option>
        </select>
      </div>
      <div class="bk-row">
        <label>{{ t('cm.direction') }}</label>
        <select v-model="s.rtl">
          <option :value="false">{{ t('cm.ltr') }}</option>
          <option :value="true">{{ t('cm.rtlManga') }}</option>
        </select>
      </div>
      <div class="bk-row">
        <label>{{ t('cm.fit') }}</label>
        <select v-model="s.fit">
          <option value="height">{{ t('cm.fitHeight') }}</option>
          <option value="width">{{ t('cm.fitWidth') }}</option>
          <option value="contain">{{ t('cm.fitBoth') }}</option>
        </select>
      </div>
    </div>
  </div>
</template>

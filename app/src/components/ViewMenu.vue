<script setup lang="ts">
/**
 * View menu: rotation, page layout, paper colour, margin crop, full screen /
 * presentation, auto-scroll.
 *
 * Everything here is display-only — nothing touches the PDF file. Rotation
 * and crop persist per document (store.docPrefs); layout, paper colour and
 * auto-scroll speed are global preferences.
 */
import { computed, ref } from 'vue'
import {
  store, controllers, documents, saveDocPrefs, docPrefsFor, paperSuppressed, type PaperColor,
} from '../store'
import { detectCrop } from '../viewer/crop'
import { NO_CROP, type CropRect } from '../viewer/geometry'
import { t } from '../i18n'
import { isMobile } from '../platform'

defineProps<{ readingFs?: boolean }>()
const emit = defineEmits<{ close: []; toast: [msg: string]; fullscreen: []; present: [] }>()

const tab = computed(() => store.activeTab)
const ctrl = computed(() => { void store.docTick; return tab.value ? controllers.get(tab.value.id) : undefined })
const detecting = ref(false)
const rotateThisPageOnly = ref(false)
/** local mirror so the sliders can drive the controller without a store round-trip */
const crop = ref<CropRect>({ ...(ctrl.value?.crop ?? NO_CROP) })
const cropOn = computed(() => crop.value.l + crop.value.t + crop.value.r + crop.value.b > 0.001)

function persist(): void {
  const c = ctrl.value
  const p = tab.value?.path
  if (!c || !p) return
  saveDocPrefs(p, {
    rotation: c.rotation || undefined,
    pageRotations: Object.keys(c.pageRotations()).length ? c.pageRotations() : undefined,
    crop: cropOn.value ? { ...crop.value } : undefined,
  })
}

function rotate(delta: number): void {
  const c = ctrl.value
  if (!c) return
  c.rotateBy(delta, rotateThisPageOnly.value ? tab.value?.currentPage : undefined)
  persist()
}

function resetRotation(): void {
  const c = ctrl.value
  if (!c) return
  c.setPageRotations({})
  c.setRotation(0)
  persist()
}

function setScrollMode(mode: 'continuous' | 'paged'): void {
  store.settings.scrollMode = mode
  ctrl.value?.setScrollMode(mode)
}

function setSpread(n: 1 | 2): void {
  store.settings.spread = n
  ctrl.value?.setSpread(n, store.settings.coverAlone)
}

function setCoverAlone(v: boolean): void {
  store.settings.coverAlone = v
  ctrl.value?.setSpread(store.settings.spread, v)
}

function applyCrop(): void {
  ctrl.value?.setCrop(cropOn.value ? { ...crop.value } : null)
  persist()
}

async function autoCrop(): Promise<void> {
  const c = ctrl.value
  const doc = tab.value ? documents.get(tab.value.id) : undefined
  if (!c || !doc) return
  detecting.value = true
  try {
    const found = await detectCrop(doc, () => c.rotation)
    if (!found) {
      emit('toast', t('vm.cropNone'))
      return
    }
    crop.value = found
    applyCrop()
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    detecting.value = false
  }
}

function clearCrop(): void {
  crop.value = { ...NO_CROP }
  applyCrop()
}

const autoScrolling = computed(() => { void store.docTick; return ctrl.value?.autoScrolling ?? false })

function toggleAutoScroll(): void {
  const c = ctrl.value
  if (!c) return
  if (c.autoScrolling) c.stopAutoScroll()
  else c.setAutoScroll(store.settings.autoScrollSpeed)
  store.docTick++
}

function setSpeed(v: number): void {
  store.settings.autoScrollSpeed = v
  if (ctrl.value?.autoScrolling) ctrl.value.setAutoScroll(v)
}

// re-sync the local crop mirror whenever the menu is (re)opened on a new doc
if (ctrl.value && tab.value) {
  const saved = docPrefsFor(tab.value.path).crop
  if (saved) crop.value = { ...saved }
}
const pct = (v: number): string => `${Math.round(v * 100)}%`

/** Facing pages only make sense with the width for two of them: every
 *  desktop, tablets in landscape, never a phone. */
const canFace = computed(() => !isMobile() || window.innerWidth >= 820)

/** swatch colours match the tints in styles.css (html[data-paper]) */
const PAPERS: { key: PaperColor; bg: string }[] = [
  { key: 'white', bg: '#ffffff' },
  { key: 'sepia', bg: '#f4ecd8' },
  { key: 'green', bg: '#cfe8cf' },
  { key: 'grey', bg: '#e2e2e0' },
]
// theme/darkPdf are reactive store fields, so this tracks them
const paperOff = computed(() => { void store.settings.theme; void store.settings.darkPdf; return paperSuppressed() })

/** keyboard hints differ by platform: ⌃⌘F is the macOS full-screen chord */
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const fsKey = isMac ? '⌃⌘F' : 'F11'
</script>

<template>
  <div class="menu-mask" @click.self="emit('close')">
    <div class="view-menu" @click.stop>
      <h4>{{ t('vm.rotate') }}</h4>
      <div class="vm-row">
        <button @click="rotate(-90)">⟲ {{ t('vm.ccw') }}</button>
        <button @click="rotate(90)">⟳ {{ t('vm.cw') }}</button>
        <button @click="resetRotation()">{{ t('vm.reset') }}</button>
      </div>
      <label class="vm-check">
        <input type="checkbox" v-model="rotateThisPageOnly" />
        {{ t('vm.thisPageOnly') }}
      </label>

      <h4>{{ t('vm.layout') }}</h4>
      <div class="vm-seg">
        <button
          :class="{ active: store.settings.scrollMode === 'continuous' }"
          @click="setScrollMode('continuous')"
        >{{ t('vm.continuous') }}</button>
        <button
          :class="{ active: store.settings.scrollMode === 'paged' }"
          @click="setScrollMode('paged')"
        >{{ t('vm.pagedMode') }}</button>
      </div>
      <div class="vm-seg" v-if="canFace">
        <button :class="{ active: store.settings.spread === 1 }" @click="setSpread(1)">{{ t('vm.single') }}</button>
        <button :class="{ active: store.settings.spread === 2 }" @click="setSpread(2)">{{ t('vm.facing') }}</button>
      </div>
      <label class="vm-check" v-if="canFace && store.settings.spread === 2">
        <input
          type="checkbox"
          :checked="store.settings.coverAlone"
          @change="setCoverAlone(($event.target as HTMLInputElement).checked)"
        />
        {{ t('vm.coverAlone') }}
      </label>

      <h4>{{ t('vm.paper') }}</h4>
      <div class="vm-paper" :class="{ off: paperOff }">
        <button
          v-for="p in PAPERS" :key="p.key"
          class="vm-swatch"
          :class="{ active: store.settings.paper === p.key }"
          :style="{ background: p.bg }"
          :disabled="paperOff"
          :title="t('vm.paper.' + p.key)"
          :data-paper="p.key"
          @click="store.settings.paper = p.key"
        ><span>{{ t('vm.paper.' + p.key) }}</span></button>
      </div>
      <p v-if="paperOff" class="vm-note">{{ t('vm.paperDark') }}</p>

      <h4>{{ t('vm.crop') }}</h4>
      <div class="vm-row">
        <button :disabled="detecting" @click="autoCrop()">
          {{ detecting ? t('vm.detecting') : t('vm.autoCrop') }}
        </button>
        <button :disabled="!cropOn" @click="clearCrop()">{{ t('vm.noCrop') }}</button>
      </div>
      <div class="vm-slider" v-for="side in (['l', 't', 'r', 'b'] as const)" :key="side">
        <label>{{ t('vm.side.' + side) }}</label>
        <input
          type="range" min="0" max="0.4" step="0.005"
          :value="crop[side]"
          @input="crop[side] = Number(($event.target as HTMLInputElement).value); applyCrop()"
        />
        <span class="vm-val">{{ pct(crop[side]) }}</span>
      </div>

      <h4>{{ t('vm.screen') }}</h4>
      <div class="vm-row">
        <button class="vm-fs" :class="{ active: readingFs }" @click="emit('fullscreen')">
          ⛶ {{ readingFs ? t('vm.exitFullscreen') : t('vm.fullscreen') }}
          <span class="vm-key" v-if="!isMobile()">{{ fsKey }}</span>
        </button>
        <button class="vm-present" @click="emit('present')">
          ▶ {{ t('vm.present') }}
          <span class="vm-key" v-if="!isMobile()">F5</span>
        </button>
      </div>
      <label class="vm-check">
        <input type="checkbox" v-model="store.settings.keepAwake" />
        {{ t('vm.keepAwake') }}
      </label>

      <h4>{{ t('vm.autoScroll') }}</h4>
      <div class="vm-row">
        <button :class="{ active: autoScrolling }" @click="toggleAutoScroll()">
          {{ autoScrolling ? t('vm.stop') : t('vm.start') }}
        </button>
      </div>
      <div class="vm-slider">
        <label>{{ t('vm.speed') }}</label>
        <input
          type="range" min="10" max="400" step="5"
          :value="store.settings.autoScrollSpeed"
          @input="setSpeed(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="vm-val">{{ store.settings.autoScrollSpeed }}</span>
      </div>
    </div>
  </div>
</template>

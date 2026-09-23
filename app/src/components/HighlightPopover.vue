<script setup lang="ts">
/**
 * Selection popover: colour, mark kind, copy, look up, translate, and
 * "add a note".
 *
 * The colour row is the fast path (one tap = a highlight in the last colour
 * you used); the kind row is one row down because underline/strike are the
 * minority case. On phones the whole thing docks to the bottom instead of
 * floating over the thumb.
 */
import { computed, ref } from 'vue'
import type { AnnotationKind } from '@solopdf/core'
import type { SelectionInfo } from '../viewer/controller'
import { store } from '../store'
import { isMobile } from '../platform'
import { t } from '../i18n'

const props = defineProps<{ selection: SelectionInfo }>()
const emit = defineEmits<{
  pick: [color: string, kind: AnnotationKind]
  note: [color: string, kind: AnnotationKind]
  copy: []
  define: []
  translate: []
}>()

const COLORS = ['yellow', 'green', 'blue', 'pink'] as const
const KINDS: AnnotationKind[] = ['highlight', 'underline', 'strike', 'squiggly']
const KIND_GLYPH: Record<string, string> = {
  highlight: '▮', underline: 'U̲', strike: 'S̶', squiggly: '∿',
}

// remembering the last colour is what makes one tap enough on the next
// highlight; the setting is where that memory lives
const color = ref<string>(store.settings.defaultColor)
const kind = ref<AnnotationKind>('highlight')

const docked = computed(() => isMobile() || window.innerWidth < 560)

const style = computed(() => {
  if (docked.value) return {}
  const r = props.selection.clientRect
  const top = Math.min(window.innerHeight - 96, r.bottom + 8)
  const left = Math.min(window.innerWidth - 290, Math.max(8, r.left + r.width / 2 - 140))
  return { top: `${top}px`, left: `${left}px` }
})
</script>

<template>
  <div class="hl-pop" :class="{ docked }" :style="style" @mousedown.prevent @touchstart.prevent>
    <div class="hl-row">
      <button
        v-for="c in COLORS" :key="c"
        class="swatch" :class="[`sw-${c}`, { on: color === c }]"
        :title="t('hl.' + c)"
        @click="color = c; store.settings.defaultColor = c; $emit('pick', c, kind)"
      />
    </div>
    <div class="hl-row hl-kinds">
      <button
        v-for="k in KINDS" :key="k"
        class="hl-kind" :class="{ on: kind === k }"
        :title="t('hl.kind.' + k)"
        @click="kind = k; $emit('pick', color, k)"
      >{{ KIND_GLYPH[k] }}</button>
      <template v-if="!docked">
        <span class="hl-sep" />
        <button class="hl-act" :title="t('hl.note')" @click="$emit('note', color, kind)">✎</button>
        <button class="hl-act" :title="t('hl.copy')" @click="$emit('copy')">⧉</button>
        <button class="hl-act" :title="t('hl.define')" @click="$emit('define')">📖</button>
        <button class="hl-act hl-translate" :title="t('hl.translate')" @click="$emit('translate')">{{ t('hl.translateGlyph') }}</button>
      </template>
    </div>
    <!-- phones: four 44px kinds + four actions don't fit one row at 375px -->
    <div v-if="docked" class="hl-row">
      <button class="hl-act" :title="t('hl.note')" @click="$emit('note', color, kind)">✎</button>
      <button class="hl-act" :title="t('hl.copy')" @click="$emit('copy')">⧉</button>
      <button class="hl-act" :title="t('hl.define')" @click="$emit('define')">📖</button>
      <button class="hl-act hl-translate" :title="t('hl.translate')" @click="$emit('translate')">{{ t('hl.translateGlyph') }}</button>
    </div>
  </div>
</template>

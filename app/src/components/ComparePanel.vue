<script setup lang="ts">
/**
 * Sidebar "Changes" tab while two documents are compared: summary, pages
 * that could not be compared (no text layer), previous / next, and the list
 * of differences — clicking one brings it into view in both documents.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { t } from '../i18n'
import { compareSession, compareCurrent, gotoChange, stepChange, endCompare } from '../compare'
import { pair, setPairSync } from '../viewer/pair'
import type { CompareChange } from '@solopdf/core'

const listEl = ref<HTMLDivElement>()
const s = computed(() => compareSession.value)
const changes = computed(() => s.value?.result.changes ?? [])

function kindLabel(c: CompareChange): string {
  if (c.pageInserted) return t('cmp.pageInserted', { page: c.pageInserted })
  if (c.pageDeleted) return t('cmp.pageDeleted', { page: c.pageDeleted })
  return t(c.kind === 'change' ? 'cmp.changed' : c.kind === 'insert' ? 'cmp.inserted' : 'cmp.deleted')
}

// keep the selected entry in view as next/prev walks the list
watch(compareCurrent, async (i) => {
  await nextTick()
  listEl.value?.querySelector<HTMLElement>(`[data-change-index="${i}"]`)?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <div v-if="s" class="sidebar-body cmp-panel">
    <div class="cmp-head">
      <div class="cmp-docs">
        <div><span class="cmp-tag cmp-tag-a">{{ t('cmp.tagOld') }}</span> <span class="cmp-docname" :title="s.nameA">{{ s.nameA }}</span></div>
        <div><span class="cmp-tag cmp-tag-b">{{ t('cmp.tagNew') }}</span> <span class="cmp-docname" :title="s.nameB">{{ s.nameB }}</span></div>
      </div>
      <div class="cmp-summary">
        <strong>{{ t('cmp.summary', { n: changes.length }) }}</strong>
        <span class="cmp-chip cmp-k-change">{{ t('cmp.changed') }} {{ s.result.stats.changed }}</span>
        <span class="cmp-chip cmp-k-insert">{{ t('cmp.inserted') }} {{ s.result.stats.inserted + s.result.stats.insertedPages }}</span>
        <span class="cmp-chip cmp-k-delete">{{ t('cmp.deleted') }} {{ s.result.stats.deleted + s.result.stats.deletedPages }}</span>
      </div>
      <p v-if="s.result.noTextA.length || s.result.noTextB.length" class="cmp-notext">
        {{ t('cmp.noText') }}
        <template v-if="s.result.noTextA.length"><br />{{ t('cmp.tagOld') }}: p.{{ s.result.noTextA.join(', ') }}</template>
        <template v-if="s.result.noTextB.length"><br />{{ t('cmp.tagNew') }}: p.{{ s.result.noTextB.join(', ') }}</template>
      </p>
      <div class="cmp-nav">
        <button class="cmp-prev" :disabled="!changes.length" :title="t('cmp.prev')" @click="stepChange(-1)">‹ {{ t('cmp.prevShort') }}</button>
        <span class="cmp-pos">{{ compareCurrent >= 0 ? compareCurrent + 1 : '–' }} / {{ changes.length }}</span>
        <button class="cmp-next" :disabled="!changes.length" :title="t('cmp.next')" @click="stepChange(1)">{{ t('cmp.nextShort') }} ›</button>
      </div>
      <div class="cmp-opts">
        <label class="vm-check">
          <input type="checkbox" :checked="pair?.sync" @change="setPairSync(($event.target as HTMLInputElement).checked)" />
          {{ t('cmp.sync') }}
        </label>
        <button class="cmp-end" @click="endCompare()">{{ t('cmp.end') }}</button>
      </div>
    </div>
    <div v-if="!changes.length" class="annot-empty">{{ t('cmp.none') }}</div>
    <div ref="listEl" class="cmp-list">
      <div
        v-for="(c, i) in changes"
        :key="c.id"
        class="cmp-item"
        :class="[`cmp-k-${c.kind}`, { current: i === compareCurrent }]"
        :data-change-index="i"
        @click="gotoChange(i)"
      >
        <div class="cmp-item-meta">
          <span class="cmp-kind">{{ kindLabel(c) }}</span>
          <span class="cmp-pages">p.{{ c.a.page }} → p.{{ c.b.page }}</span>
        </div>
        <div v-if="c.a.text" class="cmp-old">{{ c.a.text }}</div>
        <div v-if="c.b.text" class="cmp-new">{{ c.b.text }}</div>
        <div v-if="!c.a.text && !c.b.text" class="cmp-empty">{{ t('cmp.emptyText') }}</div>
      </div>
    </div>
  </div>
</template>

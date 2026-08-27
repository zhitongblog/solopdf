<script setup lang="ts">
/**
 * Reading statistics.
 *
 * Everything shown here was measured on this device and never left it; the
 * panel says so, and offers a one-tap wipe. The last-fortnight bars are
 * deliberately tiny and unlabelled — the useful signal is "did I read", not
 * a dashboard.
 */
import { computed, ref } from 'vue'
import { store } from '../store'
import { isMobile, platform } from '../platform'
import {
  clearStats, docRows, exportMarkdown, formatDuration, recentDays,
  secondsToday, streak, totalSeconds,
} from '../stats'
import { t } from '../i18n'

const emit = defineEmits<{ close: []; toast: [msg: string] }>()

const confirming = ref(false)
const phone = computed(() => isMobile() || window.innerWidth < 700)

const rows = computed(() => { void store.stats; return docRows() })
const days = computed(() => { void store.stats; return recentDays(14) })
const peak = computed(() => Math.max(1, ...days.value.map((d) => d.seconds)))

async function exportStats(): Promise<void> {
  try {
    const dest = await platform().saveText('solopdf-reading-stats.md', exportMarkdown())
    if (dest) emit('toast', t('sx.exported', { file: dest.split('/').pop() ?? '' }))
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  }
}

function wipe(): void {
  clearStats()
  confirming.value = false
  emit('toast', t('sx.cleared'))
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="sx-shell" :class="{ phone }" @click.stop>
      <header class="dt-head">
        <h3>{{ t('sx.title') }}</h3>
        <span class="dt-file">{{ t('sx.localOnly') }}</span>
        <button class="dt-close" @click="emit('close')">✕</button>
      </header>

      <div class="sx-body">
        <div class="sx-cards">
          <div class="sx-card">
            <div class="sx-num">{{ formatDuration(secondsToday()) }}</div>
            <div class="sx-cap">{{ t('sx.today') }}</div>
          </div>
          <div class="sx-card">
            <div class="sx-num">{{ formatDuration(totalSeconds()) }}</div>
            <div class="sx-cap">{{ t('sx.total') }}</div>
          </div>
          <div class="sx-card">
            <div class="sx-num">{{ streak() }}</div>
            <div class="sx-cap">{{ t('sx.streak') }}</div>
          </div>
        </div>

        <div class="sx-bars" :title="t('sx.last14')">
          <div
            v-for="d in days" :key="d.day"
            class="sx-bar"
            :style="{ height: Math.max(2, (d.seconds / peak) * 46) + 'px' }"
            :title="`${d.day} · ${formatDuration(d.seconds)}`"
          ></div>
        </div>

        <h4>{{ t('sx.byDoc') }}</h4>
        <div v-if="!rows.length" class="dt-empty">{{ t('sx.noneYet') }}</div>
        <div v-for="r in rows" :key="r.key" class="sx-row">
          <span class="sx-name" :title="r.key">{{ r.name }}</span>
          <span class="sx-time">{{ formatDuration(r.seconds) }}</span>
          <span class="sx-turns">{{ t('sx.turns', { n: r.turns }) }}</span>
        </div>
      </div>

      <div class="dt-footer">
        <button v-if="!confirming" @click="confirming = true">{{ t('sx.clear') }}</button>
        <template v-else>
          <span class="dt-warn">{{ t('sx.confirmClear') }}</span>
          <button @click="confirming = false">{{ t('at.cancel') }}</button>
          <button class="danger" @click="wipe">{{ t('sx.clearNow') }}</button>
        </template>
        <button class="primary" @click="exportStats">{{ t('sx.export') }}</button>
      </div>
    </div>
  </div>
</template>

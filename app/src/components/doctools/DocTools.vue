<script setup lang="ts">
/**
 * Document tools — the one place in SoloPDF that writes PDFs.
 *
 * Every panel here works copy-out: pick options, get a new file, original
 * untouched. That rule is why this is a separate surface from the reading
 * chrome instead of buttons sprinkled through the toolbar.
 *
 * Desktop gets a left nav (there is room, and a mouse is precise). Phones get
 * a horizontally scrolling segmented control and full-width controls; the
 * page grid drops drag-reorder in favour of explicit move buttons.
 */
import { computed, ref } from 'vue'
import { store } from '../../store'
import { isMobile } from '../../platform'
import { t } from '../../i18n'
import PagesPanel from './PagesPanel.vue'
import MergeSplitPanel from './MergeSplitPanel.vue'
import ConvertPanel from './ConvertPanel.vue'
import SignPanel from './SignPanel.vue'
import SecurityPanel from './SecurityPanel.vue'
import AnnotExportPanel from './AnnotExportPanel.vue'

const emit = defineEmits<{ close: []; toast: [msg: string]; open: [path: string] }>()

type Section = 'pages' | 'mergesplit' | 'convert' | 'sign' | 'security' | 'annots'
const SECTIONS: { key: Section; icon: string }[] = [
  { key: 'pages', icon: '▤' },
  { key: 'mergesplit', icon: '⇹' },
  { key: 'convert', icon: '⇄' },
  { key: 'sign', icon: '✍' },
  { key: 'security', icon: '🔒' },
  { key: 'annots', icon: '🖍' },
]
const section = ref<Section>('pages')
const tab = computed(() => store.activeTab)
const phone = computed(() => isMobile() || window.innerWidth < 700)
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="dt-shell" :class="{ phone }" @click.stop>
      <header class="dt-head">
        <h3>{{ t('dt.title') }}</h3>
        <span class="dt-file" :title="tab?.path">{{ tab?.name }}</span>
        <button class="dt-close" @click="emit('close')">✕</button>
      </header>

      <div class="dt-body">
        <nav class="dt-nav">
          <button
            v-for="s in SECTIONS" :key="s.key"
            :class="{ active: section === s.key }"
            @click="section = s.key"
          >
            <span class="dt-icon">{{ s.icon }}</span>
            <span class="dt-label">{{ t('dt.sec.' + s.key) }}</span>
          </button>
        </nav>

        <div class="dt-panel">
          <PagesPanel v-if="section === 'pages'" @toast="(m) => emit('toast', m)" @open="(p) => emit('open', p)" />
          <MergeSplitPanel v-else-if="section === 'mergesplit'" @toast="(m) => emit('toast', m)" @open="(p) => emit('open', p)" />
          <ConvertPanel v-else-if="section === 'convert'" @toast="(m) => emit('toast', m)" @open="(p) => emit('open', p)" />
          <SignPanel v-else-if="section === 'sign'" @toast="(m) => emit('toast', m)" @open="(p) => emit('open', p)" />
          <SecurityPanel v-else-if="section === 'security'" @toast="(m) => emit('toast', m)" @open="(p) => emit('open', p)" />
          <AnnotExportPanel v-else @toast="(m) => emit('toast', m)" @open="(p) => emit('open', p)" />
        </div>
      </div>
    </div>
  </div>
</template>

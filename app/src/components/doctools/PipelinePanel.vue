<script setup lang="ts">
/**
 * Stirling-style Workflow Suite:
 *  1. Automated Multi-Step PDF Pipeline (presets + customizable step queue in memory)
 *  2. Smart Auto-Rename (extract XMP/Info/first-page title & author -> standardized filename)
 *  3. Embedded Attachments Manager (list, embed new files, or remove embedded files)
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  buildPresetPipeline,
  extractCitation,
  humanSize,
  readCitationInput,
  RENAME_TEMPLATES,
  suggestPdfFilename,
  type CitationMeta,
  type PipelinePresetId,
  type PipelineStepSpec,
} from '@solopdf/core'
import { store, documents } from '../../store'
import {
  docOps,
  pickOpenPaths,
  pickSavePath,
  type EmbeddedAttachmentInfo,
} from '../../platform/docops'
import { t } from '../../i18n'

const emit = defineEmits<{ open: [path: string]; toast: [msg: string] }>()

const tab = computed(() => store.activeTab)
const doc = computed(() => {
  void store.docTick
  return tab.value ? documents.get(tab.value.id) : undefined
})
const busy = ref('')

// ── 1. Multi-step Pipeline ──
const activePreset = ref<PipelinePresetId>('scan_clean')
const wmText = ref('CONFIDENTIAL 机密')
const pnFormat = ref('{n} / {total}')
const rtlScan = ref(false)
const steps = ref<PipelineStepSpec[]>(buildPresetPipeline('scan_clean'))
const addOpKind = ref('remove_blank')

function applyPreset(p: PipelinePresetId): void {
  activePreset.value = p
  steps.value = buildPresetPipeline(p, {
    watermarkText: wmText.value,
    pageNumberFormat: pnFormat.value,
    rtl: rtlScan.value,
  })
}

watch([wmText, pnFormat, rtlScan], () => {
  steps.value = buildPresetPipeline(activePreset.value, {
    watermarkText: wmText.value,
    pageNumberFormat: pnFormat.value,
    rtl: rtlScan.value,
  })
})

function addStep(): void {
  switch (addOpKind.value) {
    case 'remove_blank':
      steps.value.push({ op: 'remove_blank', threshold: 0.005 })
      break
    case 'split2up':
      steps.value.push({
        op: 'split2up',
        direction: 'vertical',
        rtl: rtlScan.value,
        only_wide: true,
        overlap: 4,
      })
      break
    case 'grayscale':
      steps.value.push({ op: 'grayscale', whiten_bg: true })
      break
    case 'resize':
      steps.value.push({ op: 'resize', width: 595.28, height: 841.89 })
      break
    case 'watermark':
      steps.value.push({
        op: 'watermark',
        text: wmText.value || 'CONFIDENTIAL',
        font_size: 42,
        opacity: 0.2,
        rotate: 45,
        position: 'tile',
        tile_spacing: 180,
        under: false,
      })
      break
    case 'page_numbers':
      steps.value.push({
        op: 'page_numbers',
        format: pnFormat.value || '{n} / {total}',
        position: 'bottom-center',
        start_number: 1,
        from_page: 1,
        to_page: 0,
        font_size: 10,
        margin: 24,
      })
      break
    case 'flatten':
      steps.value.push({ op: 'flatten' })
      break
    case 'sanitize':
      steps.value.push({
        op: 'sanitize',
        metadata: true,
        annotations: false,
        attachments: false,
        javascript_actions: true,
        forms: false,
      })
      break
    case 'compress':
      steps.value.push({ op: 'compress', max_dim: 1600, quality: 75 })
      break
  }
}

function moveStep(idx: number, dir: -1 | 1): void {
  const j = idx + dir
  if (j < 0 || j >= steps.value.length) return
  const next = [...steps.value]
  ;[next[idx], next[j]] = [next[j], next[idx]]
  steps.value = next
}

function removeStep(idx: number): void {
  steps.value.splice(idx, 1)
}

function stepLabel(s: PipelineStepSpec): string {
  switch (s.op) {
    case 'remove_blank':
      return t('dt.pl.opRemoveBlank')
    case 'split2up':
      return `${t('dt.pl.opSplit2up')} (${s.rtl ? 'RTL' : 'LTR'})`
    case 'single_large_page':
      return t('dt.ly.singleTitle')
    case 'crop':
      return t('dt.sec.crop')
    case 'rotate':
      return `${t('vm.cw')} ${s.degrees}°`
    case 'grayscale':
      return t('dt.pl.opGrayscale')
    case 'resize':
      return `${t('dt.pl.opResize')} (${Math.round(s.width)}×${Math.round(s.height)})`
    case 'nup':
      return `N-up (${s.cols}×${s.rows})`
    case 'booklet':
      return t('dt.ly.bookletTitle')
    case 'watermark':
      return `${t('dt.pl.opWatermark')}: "${s.text}"`
    case 'page_numbers':
      return `${t('dt.pl.opPageNumbers')}: ${s.format ?? '{n}'}`
    case 'flatten':
      return t('dt.pl.opFlatten')
    case 'sanitize':
      return t('dt.pl.opSanitize')
    case 'compress':
      return `${t('dt.pl.opCompress')} (${s.max_dim ?? 1600}px, Q${s.quality ?? 75})`
    case 'protect':
      return t('dt.se.setTitle')
  }
}

async function runPipeline(): Promise<void> {
  const src = tab.value?.path
  if (!src || !steps.value.length) return
  const suggested = src.replace(/\.pdf$/i, '') + '-pipeline.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = 'pipeline'
  try {
    const out = await docOps.runPipeline(src, dest, null, steps.value)
    emit('toast', t('dt.savedTo', { path: out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = ''
  }
}

// ── 2. Smart Auto-Rename ──
const citeMeta = ref<CitationMeta | null>(null)
const renameTpl = ref<string>(RENAME_TEMPLATES[0].pattern)
const customFilename = ref('')

async function refreshRenameSuggestion(): Promise<void> {
  const tb = tab.value
  const d = doc.value
  if (!tb || !d) return
  try {
    const input = await readCitationInput(d as never, tb.path.split('/').pop() ?? '')
    const meta = extractCitation(input)
    citeMeta.value = meta
    customFilename.value = suggestPdfFilename(meta, renameTpl.value).filename
  } catch {
    /* ignore */
  }
}

watch(renameTpl, () => {
  if (citeMeta.value) {
    customFilename.value = suggestPdfFilename(citeMeta.value, renameTpl.value).filename
  }
})

async function saveAutoRenamed(): Promise<void> {
  const src = tab.value?.path
  if (!src || !customFilename.value.trim()) return
  const dir = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : ''
  const fname = customFilename.value.trim().endsWith('.pdf')
    ? customFilename.value.trim()
    : `${customFilename.value.trim()}.pdf`
  const suggested = dir ? `${dir}/${fname}` : fname
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = 'rename'
  try {
    const n = tab.value?.numPages ?? 1
    const order = Array.from({ length: n }, (_, i) => i + 1)
    const out = await docOps.arrangePages(src, dest, null, order)
    emit('toast', t('dt.savedTo', { path: out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = ''
  }
}

// ── 3. Embedded Attachments Manager ──
const existingAttachments = ref<EmbeddedAttachmentInfo[]>([])
const stagedFiles = ref<string[]>([])
const attachDesc = ref('')

async function refreshAttachments(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  try {
    existingAttachments.value = await docOps.listAttachments(src, null)
  } catch {
    existingAttachments.value = []
  }
}

async function pickAttachmentFiles(): Promise<void> {
  const picked = await pickOpenPaths([], true)
  if (picked.length) {
    stagedFiles.value = [...stagedFiles.value, ...picked]
  }
}

async function embedStagedFiles(): Promise<void> {
  const src = tab.value?.path
  if (!src || !stagedFiles.value.length) return
  const suggested = src.replace(/\.pdf$/i, '') + '-attached.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = 'attach'
  try {
    const out = await docOps.addAttachments(
      src,
      dest,
      null,
      stagedFiles.value.map((p) => ({
        path: p,
        description: attachDesc.value.trim(),
      })),
    )
    stagedFiles.value = []
    attachDesc.value = ''
    emit('toast', t('dt.savedTo', { path: out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = ''
  }
}

async function removeAttachment(names: string[]): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const suggested = src.replace(/\.pdf$/i, '') + '-detached.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = 'detach'
  try {
    const out = await docOps.removeAttachments(src, dest, null, names)
    emit('toast', t('dt.savedTo', { path: out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = ''
  }
}

onMounted(() => {
  void refreshRenameSuggestion()
  void refreshAttachments()
})
watch(
  () => tab.value?.id,
  () => {
    void refreshRenameSuggestion()
    void refreshAttachments()
  },
)
</script>

<template>
  <div class="dt-panel">
    <p class="dt-hint">{{ t('dt.pl.hint') }}</p>

    <!-- 1. Automated Pipeline -->
    <div class="pl-card">
      <div class="pl-head">
        <h4>{{ t('dt.pl.title') }}</h4>
        <span class="dt-sub">{{ t('dt.pl.sub') }}</span>
      </div>

      <div class="dt-actions">
        <button
          :class="{ primary: activePreset === 'scan_clean' }"
          @click="applyPreset('scan_clean')"
        >
          {{ t('dt.pl.presetScan') }}
        </button>
        <button
          :class="{ primary: activePreset === 'confidential_share' }"
          @click="applyPreset('confidential_share')"
        >
          {{ t('dt.pl.presetConf') }}
        </button>
        <button
          :class="{ primary: activePreset === 'print_handout' }"
          @click="applyPreset('print_handout')"
        >
          {{ t('dt.pl.presetPrint') }}
        </button>
        <button
          :class="{ primary: activePreset === 'archive_slim' }"
          @click="applyPreset('archive_slim')"
        >
          {{ t('dt.pl.presetSlim') }}
        </button>
      </div>

      <div class="pl-inline">
        <label class="dt-field">
          <span>{{ t('dt.pl.wmText') }}</span>
          <input v-model="wmText" />
        </label>
        <label class="dt-field">
          <span>{{ t('dt.pl.pnFormat') }}</span>
          <input v-model="pnFormat" />
        </label>
      </div>

      <div class="dt-list" v-if="steps.length">
        <div v-for="(s, i) in steps" :key="i" class="dt-list-row">
          <span class="dt-list-idx">{{ i + 1 }}</span>
          <span class="dt-list-name">{{ stepLabel(s) }}</span>
          <button :disabled="i === 0" @click="moveStep(i, -1)">↑</button>
          <button :disabled="i === steps.length - 1" @click="moveStep(i, 1)">↓</button>
          <button @click="removeStep(i)">✕</button>
        </div>
      </div>

      <div class="dt-actions">
        <select v-model="addOpKind">
          <option value="remove_blank">{{ t('dt.pl.opRemoveBlank') }}</option>
          <option value="split2up">{{ t('dt.pl.opSplit2up') }}</option>
          <option value="grayscale">{{ t('dt.pl.opGrayscale') }}</option>
          <option value="resize">{{ t('dt.pl.opResize') }}</option>
          <option value="watermark">{{ t('dt.pl.opWatermark') }}</option>
          <option value="page_numbers">{{ t('dt.pl.opPageNumbers') }}</option>
          <option value="flatten">{{ t('dt.pl.opFlatten') }}</option>
          <option value="sanitize">{{ t('dt.pl.opSanitize') }}</option>
          <option value="compress">{{ t('dt.pl.opCompress') }}</option>
        </select>
        <button @click="addStep">＋ {{ t('dt.pl.addStep') }}</button>
        <button
          class="primary"
          :disabled="!!busy || !steps.length"
          @click="runPipeline"
        >
          {{ busy === 'pipeline' ? t('dt.working') : t('dt.pl.runBtn', { n: steps.length }) }}
        </button>
      </div>
    </div>

    <!-- 2. Smart Auto-Rename -->
    <div class="pl-card">
      <div class="pl-head">
        <h4>{{ t('dt.pl.renameTitle') }}</h4>
        <span class="dt-sub">{{ t('dt.pl.renameSub') }}</span>
      </div>
      <div class="dt-form">
        <label class="dt-field">
          <span>{{ t('dt.pl.renameTpl') }}</span>
          <select v-model="renameTpl">
            <option v-for="tpl in RENAME_TEMPLATES" :key="tpl.id" :value="tpl.pattern">
              {{ tpl.pattern }}
            </option>
          </select>
        </label>
        <label class="dt-field">
          <span>{{ t('dt.pl.renamePreview') }}</span>
          <input v-model="customFilename" />
        </label>
      </div>
      <div class="pl-actions">
        <button
          class="primary"
          :disabled="!!busy || !customFilename.trim()"
          @click="saveAutoRenamed"
        >
          {{ busy === 'rename' ? t('dt.working') : t('dt.pl.renameBtn') }}
        </button>
      </div>
    </div>

    <!-- 3. Embedded Attachments Manager -->
    <div class="pl-card">
      <div class="pl-head">
        <h4>{{ t('dt.pl.attachTitle') }}</h4>
        <span class="dt-sub">{{ t('dt.pl.attachSub') }}</span>
      </div>

      <div class="dt-list" v-if="existingAttachments.length">
        <div v-for="att in existingAttachments" :key="att.name" class="dt-list-row">
          <span class="dt-list-name">📎 {{ att.name }} ({{ humanSize(att.size) }})</span>
          <button :disabled="!!busy" @click="removeAttachment([att.name])">
            {{ t('dt.pages.remove') }}
          </button>
        </div>
      </div>

      <div class="dt-list" v-if="stagedFiles.length">
        <div v-for="(p, i) in stagedFiles" :key="p + i" class="dt-list-row">
          <span class="dt-list-idx">+</span>
          <span class="dt-list-name">{{ p.split('/').pop() }}</span>
          <button @click="stagedFiles.splice(i, 1)">✕</button>
        </div>
      </div>

      <label class="dt-field" v-if="stagedFiles.length">
        <span>{{ t('dt.pl.attachDesc') }}</span>
        <input v-model="attachDesc" :placeholder="t('dt.pl.attachDescPh')" />
      </label>

      <div class="dt-actions">
        <button @click="pickAttachmentFiles">＋ {{ t('dt.pl.attachPick') }}</button>
        <button
          v-if="existingAttachments.length"
          :disabled="!!busy"
          @click="removeAttachment([])"
        >
          {{ t('dt.pl.attachClearAll') }}
        </button>
        <button
          class="primary"
          :disabled="!!busy || !stagedFiles.length"
          @click="embedStagedFiles"
        >
          {{ busy === 'attach' ? t('dt.working') : t('dt.pl.attachEmbedBtn') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pl-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 10px;
}
.pl-head h4 {
  margin: 0 0 2px;
  font-size: 13.5px;
}
.pl-inline {
  display: flex;
  gap: 10px;
}
.pl-inline .dt-field {
  flex: 1;
}
.pl-actions {
  display: flex;
  justify-content: flex-end;
}
</style>

<script setup lang="ts">
/**
 * Security & Privacy Suite:
 *  1. Open-password: set AES-256 password or export unlocked copy
 *  2. True Redaction: find sensitive text (phone/email/ID/custom) & permanently strip + blackout
 *  3. Sanitize PDF: strip metadata (/Info + XMP), JS actions, annotations, attachments, forms
 *  4. Flatten PDF: bake annotations & form appearances into static page streams
 */
import { computed, ref } from 'vue'
import { findRedactionRects, type RedactMatchRect, type RedactPreset } from '@solopdf/core'
import { store, documents } from '../../store'
import { extractPagesWithGeom } from '../../book/extract'
import { docOps, pickSavePath, type SanitizeReport } from '../../platform/docops'
import { t } from '../../i18n'

const emit = defineEmits<{ toast: [msg: string]; open: [path: string] }>()

const tab = computed(() => store.activeTab)
const doc = computed(() => { void store.docTick; return tab.value ? documents.get(tab.value.id) : undefined })
const busy = ref(false)

// ── 1. Password ──
const newPassword = ref('')
const confirmPassword = ref('')
const ownerPassword = ref('')
const currentPassword = ref('')

const mismatch = computed(
  () => !!confirmPassword.value && newPassword.value !== confirmPassword.value,
)

async function setPassword(): Promise<void> {
  const src = tab.value?.path
  if (!src || !newPassword.value || mismatch.value) return
  const suggested = (tab.value?.name ?? 'document').replace(/\.pdf$/i, '') + '-protected.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = true
  try {
    const out = await docOps.setPassword(
      src, dest, currentPassword.value || null, newPassword.value, ownerPassword.value,
    )
    newPassword.value = ''
    confirmPassword.value = ''
    ownerPassword.value = ''
    emit('toast', t('dt.saved', { file: out.split('/').pop() ?? out }))
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}

async function removePassword(): Promise<void> {
  const src = tab.value?.path
  if (!src || !currentPassword.value) return
  const suggested = (tab.value?.name ?? 'document').replace(/\.pdf$/i, '') + '-unlocked.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = true
  try {
    const out = await docOps.removePassword(src, dest, currentPassword.value)
    emit('toast', t('dt.saved', { file: out.split('/').pop() ?? out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}

// ── 2. Redact PDF (True Redaction) ──
const redactTermsText = ref('')
const redactPresets = ref<Set<RedactPreset>>(new Set(['phone', 'email', 'idcard']))
const redactMatches = ref<RedactMatchRect[]>([])
const scanning = ref(false)

const PRESET_LIST: { key: RedactPreset; labelKey: string }[] = [
  { key: 'phone', labelKey: 'dt.se.presetPhone' },
  { key: 'email', labelKey: 'dt.se.presetEmail' },
  { key: 'idcard', labelKey: 'dt.se.presetIdcard' },
  { key: 'bankcard', labelKey: 'dt.se.presetBank' },
  { key: 'ipv4', labelKey: 'dt.se.presetIp' },
]

function togglePreset(p: RedactPreset): void {
  const next = new Set(redactPresets.value)
  next.has(p) ? next.delete(p) : next.add(p)
  redactPresets.value = next
}

async function scanRedactions(): Promise<void> {
  const d = doc.value
  if (!d) return
  scanning.value = true
  try {
    const { pages } = await extractPagesWithGeom(d)
    const terms = redactTermsText.value
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    redactMatches.value = findRedactionRects(
      pages.map((p) => ({
        page: p.page,
        width: p.width,
        height: p.height,
        spans: p.lines.map((l) => ({ text: l.t, x: l.x, y: l.y, w: l.w, h: l.h })),
      })),
      {
        terms,
        presets: [...redactPresets.value],
      },
    )
    emit('toast', t('dt.se.redactFound', { n: redactMatches.value.length }))
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    scanning.value = false
  }
}

async function applyRedact(): Promise<void> {
  const src = tab.value?.path
  if (!src || !redactMatches.value.length) return
  const suggested = (tab.value?.name ?? 'document').replace(/\.pdf$/i, '') + '-redacted.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = true
  try {
    const out = await docOps.redact(
      src,
      dest,
      currentPassword.value || null,
      redactMatches.value.map((m) => ({
        page: m.page,
        rect: m.rect,
        color: [0, 0, 0],
        label: '',
      })),
      true,
    )
    emit('toast', t('dt.saved', { file: out.split('/').pop() ?? out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}

// ── 3. Sanitize PDF ──
const sanMetadata = ref(true)
const sanActions = ref(true)
const sanAnnots = ref(false)
const sanAttach = ref(false)
const sanForms = ref(false)
const sanReport = ref<SanitizeReport | null>(null)

async function applySanitize(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const suggested = (tab.value?.name ?? 'document').replace(/\.pdf$/i, '') + '-sanitized.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = true
  sanReport.value = null
  try {
    const res = await docOps.sanitize(src, dest, currentPassword.value || null, {
      metadata: sanMetadata.value,
      javascript_actions: sanActions.value,
      annotations: sanAnnots.value,
      attachments: sanAttach.value,
      forms: sanForms.value,
    })
    sanReport.value = res.report
    emit('toast', t('dt.saved', { file: res.path.split('/').pop() ?? res.path }))
    emit('open', res.path)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}

// ── 4. Flatten PDF ──
async function applyFlatten(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const suggested = (tab.value?.name ?? 'document').replace(/\.pdf$/i, '') + '-flattened.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = true
  try {
    const out = await docOps.flatten(src, dest, currentPassword.value || null)
    emit('toast', t('dt.saved', { file: out.split('/').pop() ?? out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="dt-section">
    <p class="dt-hint" v-if="tab?.encrypted">{{ t('dt.se.isEncrypted') }}</p>

    <h4>{{ t('dt.se.redactTitle') }}</h4>
    <p class="dt-hint">{{ t('dt.se.redactHint') }}</p>
    <div class="dt-actions">
      <button
        v-for="pr in PRESET_LIST" :key="pr.key"
        :class="{ primary: redactPresets.has(pr.key) }"
        @click="togglePreset(pr.key)"
      >
        {{ t(pr.labelKey) }}
      </button>
    </div>
    <div class="dt-field">
      <label>{{ t('dt.se.redactTerms') }}</label>
      <input v-model="redactTermsText" :placeholder="t('dt.se.redactTermsPlaceholder')" />
    </div>
    <div class="dt-list" v-if="redactMatches.length">
      <div v-for="(m, idx) in redactMatches.slice(0, 30)" :key="idx" class="dt-list-row">
        <span class="dt-list-idx">p.{{ m.page }}</span>
        <span class="dt-list-name">{{ m.matchedText }}</span>
        <button @click="redactMatches.splice(idx, 1)">✕</button>
      </div>
    </div>
    <div class="dt-actions">
      <button :disabled="scanning || busy" @click="scanRedactions">
        {{ scanning ? t('dt.working') : t('dt.se.doScan') }}
      </button>
      <button class="primary" :disabled="busy || !redactMatches.length" @click="applyRedact">
        {{ busy ? t('dt.working') : t('dt.se.doRedact', { n: redactMatches.length }) }}
      </button>
    </div>

    <h4>{{ t('dt.se.sanitizeTitle') }}</h4>
    <p class="dt-hint">{{ t('dt.se.sanitizeHint') }}</p>
    <div class="dt-field">
      <label class="dt-check"><input type="checkbox" v-model="sanMetadata" /> {{ t('dt.se.sanMeta') }}</label>
      <label class="dt-check"><input type="checkbox" v-model="sanActions" /> {{ t('dt.se.sanJs') }}</label>
      <label class="dt-check"><input type="checkbox" v-model="sanAnnots" /> {{ t('dt.se.sanAnnots') }}</label>
      <label class="dt-check"><input type="checkbox" v-model="sanAttach" /> {{ t('dt.se.sanAttach') }}</label>
      <label class="dt-check"><input type="checkbox" v-model="sanForms" /> {{ t('dt.se.sanForms') }}</label>
    </div>
    <div class="dt-actions">
      <button class="primary" :disabled="busy" @click="applySanitize">
        {{ busy ? t('dt.working') : t('dt.se.doSanitize') }}
      </button>
    </div>

    <h4>{{ t('dt.se.flattenTitle') }}</h4>
    <p class="dt-hint">{{ t('dt.se.flattenHint') }}</p>
    <div class="dt-actions">
      <button class="primary" :disabled="busy" @click="applyFlatten">
        {{ busy ? t('dt.working') : t('dt.se.doFlatten') }}
      </button>
    </div>

    <h4>{{ t('dt.se.setTitle') }}</h4>
    <p class="dt-hint">{{ t('dt.se.setHint') }}</p>
    <div class="dt-field" v-if="tab?.encrypted">
      <label>{{ t('dt.se.current') }}</label>
      <input type="password" v-model="currentPassword" autocomplete="off" />
    </div>
    <div class="dt-field">
      <label>{{ t('dt.se.newPw') }}</label>
      <input type="password" v-model="newPassword" autocomplete="new-password" />
    </div>
    <div class="dt-field">
      <label>{{ t('dt.se.confirm') }}</label>
      <input type="password" v-model="confirmPassword" autocomplete="new-password" />
    </div>
    <p class="dt-warn" v-if="mismatch">{{ t('dt.se.mismatch') }}</p>
    <div class="dt-field">
      <label>{{ t('dt.se.owner') }}</label>
      <input type="password" v-model="ownerPassword" autocomplete="off" :placeholder="t('dt.se.ownerHint')" />
    </div>
    <div class="dt-actions">
      <button class="primary" :disabled="busy || !newPassword || mismatch" @click="setPassword">
        {{ busy ? t('dt.working') : t('dt.se.doSet') }}
      </button>
    </div>

    <h4>{{ t('dt.se.removeTitle') }}</h4>
    <p class="dt-hint">{{ t('dt.se.removeHint') }}</p>
    <div class="dt-field">
      <label>{{ t('dt.se.current') }}</label>
      <input type="password" v-model="currentPassword" autocomplete="off" />
    </div>
    <div class="dt-actions">
      <button class="primary" :disabled="busy || !currentPassword" @click="removePassword">
        {{ busy ? t('dt.working') : t('dt.se.doRemove') }}
      </button>
    </div>
  </div>
</template>

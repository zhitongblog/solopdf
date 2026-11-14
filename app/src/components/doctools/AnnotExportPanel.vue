<script setup lang="ts">
/**
 * Bake the sidecar's marks into a copy of the PDF as standard annotations.
 *
 * This closes the one real hole in "highlights are Markdown notes": until
 * now a highlight was invisible to every other PDF reader on earth. The
 * sidecar stays the source of truth — this is an export, run on demand, into
 * a new file.
 *
 * Marks are exported at their RESOLVED positions (after fingerprint
 * relocation), not their stored ones, so a highlight that drifted with a
 * re-issued PDF lands where the reader currently sees it.
 */
import { computed, ref } from 'vue'
import { store, controllers, annotManagers } from '../../store'
import { exportSpec, isDrawn, toAnkiTsv, toObsidianSr } from '@solopdf/core'
import { platform } from '../../platform'
import { docOps, pickSavePath, type AnnotSpec } from '../../platform/docops'
import { t } from '../../i18n'

const emit = defineEmits<{ toast: [msg: string]; open: [path: string] }>()

const tab = computed(() => store.activeTab)
const ctrl = computed(() => { void store.docTick; return tab.value ? controllers.get(tab.value.id) : undefined })
const mgr = computed(() => { void store.docTick; return tab.value ? annotManagers.get(tab.value.id) : undefined })
const busy = ref(false)
const includeNotes = ref(true)
const author = ref('')

const marks = computed(() => {
  void store.docTick
  return mgr.value?.annotations ?? []
})
const exportable = computed(() => marks.value.filter((a) => !a.orphan))
const orphans = computed(() => marks.value.length - exportable.value.length)

function buildSpecs(): AnnotSpec[] {
  const c = ctrl.value
  const out: AnnotSpec[] = []
  for (const a of exportable.value) {
    const resolved = c?.resolvedFor(a.id)
    if (!resolved || resolved.orphan || !resolved.quads.length) continue
    // drawn marks export their own geometry (ink strokes, line ends, the
    // text box's text); text marks go at their resolved position
    const spec = exportSpec(a, {
      page: resolved.page,
      quads: isDrawn(a.kind) ? a.anchor.quads : resolved.quads,
      // the excerpt is already in the PDF — only the reader's own words are
      // worth carrying into /Contents
      includeNotes: includeNotes.value,
      author: author.value,
    })
    if (spec) out.push(spec)
  }
  return out
}

async function run(): Promise<void> {
  const src = tab.value?.path
  if (!src) return
  const specs = buildSpecs()
  if (!specs.length) {
    emit('toast', t('dt.ae.nothing'))
    return
  }
  const suggested = (tab.value?.name ?? 'document').replace(/\.pdf$/i, '') + '-annotated.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = true
  try {
    const out = await docOps.writeAnnotations(src, dest, null, specs)
    emit('toast', t('dt.ae.done', { n: specs.length, file: out.split('/').pop() ?? out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}
async function exportAnki(): Promise<void> {
  if (!marks.value.length) {
    emit('toast', t('dt.ae.nothing'))
    return
  }
  const docTitle = (tab.value?.name ?? 'Document').replace(/\.pdf$/i, '')
  const tsv = toAnkiTsv(marks.value, { docTitle })
  await platform().saveText(`${docTitle}-anki.tsv`, tsv)
  emit('toast', t('dt.ae.flashcardsDone', { fmt: 'Anki TSV' }))
}

async function exportObsidian(): Promise<void> {
  if (!marks.value.length) {
    emit('toast', t('dt.ae.nothing'))
    return
  }
  const docTitle = (tab.value?.name ?? 'Document').replace(/\.pdf$/i, '')
  const md = toObsidianSr(marks.value, { docTitle })
  await platform().saveText(`${docTitle}-flashcards.md`, md)
  emit('toast', t('dt.ae.flashcardsDone', { fmt: 'Obsidian SR' }))
}
</script>

<template>
  <div class="dt-section">
    <p class="dt-hint">{{ t('dt.ae.hint') }}</p>

    <div class="dt-stat">
      <strong>{{ exportable.length }}</strong> {{ t('dt.ae.willExport') }}
      <span v-if="orphans" class="dt-warn-inline">· {{ t('dt.ae.skipped', { n: orphans }) }}</span>
    </div>

    <label class="vm-check">
      <input type="checkbox" v-model="includeNotes" />
      {{ t('dt.ae.includeNotes') }}
    </label>

    <div class="dt-field">
      <label>{{ t('dt.ae.author') }}</label>
      <input v-model="author" placeholder="SoloPDF" />
    </div>

    <div class="dt-footer">
      <button class="primary" :disabled="busy || !exportable.length" @click="run">
        {{ busy ? t('dt.working') : t('dt.ae.doExport') }}
      </button>
    </div>

    <hr class="dt-divider" />

    <h4>{{ t('dt.ae.flashcardsTitle') }}</h4>
    <p class="dt-hint">{{ t('dt.ae.flashcardsHint') }}</p>
    <div class="dt-actions">
      <button :disabled="!marks.length" @click="exportAnki">
        🗂 {{ t('dt.ae.exportAnki') }}
      </button>
      <button :disabled="!marks.length" @click="exportObsidian">
        🧠 {{ t('dt.ae.exportObsidian') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.dt-divider {
  border: none;
  border-top: 1px solid var(--border);
  margin: 14px 0;
}
</style>

<script setup lang="ts">
/**
 * "Compare documents…": pick the original and the revision — from the open
 * PDF tabs, recent files, or a file picker — then run the compare
 * (compare.ts), which lays both out side by side with the differences marked
 * and the change list in the sidebar.
 */
import { computed, ref } from 'vue'
import { store } from '../store'
import { t } from '../i18n'
import { platform } from '../platform'
import { runCompare, compareProgress } from '../compare'

const props = defineProps<{
  /** preselected tabs (tab context menu / current document) */
  initialA?: number
  initialB?: number
  /** open a file as a tab; resolves to its tab id (null = failed/cancelled) */
  opener: (path: string) => Promise<number | null>
}>()
const emit = defineEmits<{ close: []; toast: [msg: string] }>()

/** a choice is an open tab ('tab:<id>') or a recent file ('path:<path>') */
const pdfTabs = computed(() => store.tabs.filter((x) => x.kind === 'pdf' && !x.loadError))
const recents = computed(() =>
  store.recents.filter((p) => /\.pdf$/i.test(p) && !store.tabs.some((x) => x.path === p)).slice(0, 8))

function defaultFor(which: 'a' | 'b'): string {
  const given = which === 'a' ? props.initialA : props.initialB
  if (given && pdfTabs.value.some((x) => x.id === given)) return `tab:${given}`
  const active = store.activeTab
  if (which === 'a' && active?.kind === 'pdf') return `tab:${active.id}`
  // the other side: the most recent other open PDF
  const otherId = which === 'b' ? (props.initialA ?? active?.id) : props.initialB
  const other = [...pdfTabs.value].reverse().find((x) => x.id !== otherId)
  return other ? `tab:${other.id}` : ''
}
const choiceA = ref(defaultFor('a'))
const choiceB = ref(defaultFor('b'))
const busy = ref(false)

const same = computed(() => !!choiceA.value && choiceA.value === choiceB.value)
const ready = computed(() => !!choiceA.value && !!choiceB.value && !same.value && !busy.value)

async function browse(which: 'a' | 'b'): Promise<void> {
  const files = await platform().pickFiles()
  const pdf = files?.find((f) => /\.pdf$/i.test(f) && !store.tabs.some((x) => x.path === f)) ?? files?.find((f) => /\.pdf$/i.test(f))
  if (!pdf) return
  const existing = store.tabs.find((x) => x.path === pdf)
  const v = existing ? `tab:${existing.id}` : `path:${pdf}`
  if (which === 'a') choiceA.value = v
  else choiceB.value = v
}

function swap(): void {
  const a = choiceA.value
  choiceA.value = choiceB.value
  choiceB.value = a
}

async function resolve(choice: string): Promise<number | null> {
  if (choice.startsWith('tab:')) return Number(choice.slice(4))
  if (choice.startsWith('path:')) return props.opener(choice.slice(5))
  return null
}

async function run(): Promise<void> {
  if (!ready.value) return
  busy.value = true
  try {
    const a = await resolve(choiceA.value)
    const b = await resolve(choiceB.value)
    if (a == null || b == null) { emit('toast', t('cmp.needTwo')); return }
    if (a === b) { emit('toast', t('cmp.same')); return }
    const s = await runCompare(a, b)
    emit('toast', t('cmp.done', { n: s.result.changes.length }))
    emit('close')
  } catch (err) {
    emit('toast', t('cmp.fail', { msg: String((err as Error)?.message ?? err) }))
  } finally {
    busy.value = false
  }
}

const label = (p: string): string => p.split('/').pop() ?? p
</script>

<template>
  <div class="modal-mask" @click.self="!busy && emit('close')">
    <div class="modal cmp-dialog" role="dialog" :aria-label="t('cmp.title')">
      <h3>{{ t('cmp.title') }}</h3>
      <p class="modal-note">{{ t('cmp.intro') }}</p>
      <div v-for="which in (['a', 'b'] as const)" :key="which" class="cmp-row">
        <label :for="`cmp-${which}`">
          <span class="cmp-tag" :class="`cmp-tag-${which}`">{{ which === 'a' ? t('cmp.tagOld') : t('cmp.tagNew') }}</span>
          {{ which === 'a' ? t('cmp.old') : t('cmp.new') }}
        </label>
        <div class="cmp-pick">
          <select
            :id="`cmp-${which}`"
            :value="which === 'a' ? choiceA : choiceB"
            :disabled="busy"
            @change="(e) => { const v = (e.target as HTMLSelectElement).value; which === 'a' ? (choiceA = v) : (choiceB = v) }"
          >
            <option value="" disabled>{{ t('cmp.choose') }}</option>
            <optgroup v-if="pdfTabs.length" :label="t('cmp.openDocs')">
              <option v-for="tb in pdfTabs" :key="tb.id" :value="`tab:${tb.id}`">{{ tb.name }}</option>
            </optgroup>
            <optgroup v-if="recents.length" :label="t('cmp.recent')">
              <option v-for="p in recents" :key="p" :value="`path:${p}`">{{ label(p) }}</option>
            </optgroup>
            <option
              v-if="(which === 'a' ? choiceA : choiceB).startsWith('path:') && !recents.includes((which === 'a' ? choiceA : choiceB).slice(5))"
              :value="which === 'a' ? choiceA : choiceB"
            >{{ label((which === 'a' ? choiceA : choiceB).slice(5)) }}</option>
          </select>
          <button :disabled="busy" @click="browse(which)">{{ t('cmp.browse') }}</button>
        </div>
      </div>
      <div class="cmp-swap-row">
        <button class="cmp-swap" :disabled="busy" :title="t('cmp.swap')" @click="swap()">⇅ {{ t('cmp.swap') }}</button>
        <span v-if="same" class="cmp-warn">{{ t('cmp.same') }}</span>
      </div>
      <p v-if="busy && compareProgress" class="cmp-progress">
        {{ t('cmp.running', { done: compareProgress.done, total: compareProgress.total }) }}
      </p>
      <div class="modal-actions">
        <button :disabled="busy" @click="emit('close')">{{ t('cmp.cancel') }}</button>
        <button class="primary cmp-run" :disabled="!ready" @click="run()">{{ t('cmp.run') }}</button>
      </div>
    </div>
  </div>
</template>

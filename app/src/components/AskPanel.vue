<script setup lang="ts">
/**
 * Ask AI panel — right-hand column on desktop, bottom sheet on a phone.
 *
 * Privacy is the first thing on screen, not a footnote: the header names the
 * endpoint (🔒 local / 🌐 online) on every answer, nothing is sent until the
 * reader approves that endpoint once, and with the feature off the panel is
 * only an explanation and a link to Settings.
 *
 * Answers stream in; [p.N] citations become chips that jump through the
 * back/forward history (the shell's goto), so ⌥← returns to where you were.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { parseCitations } from '@solopdf/core'
import { store, labelOf } from '../store'
import { isMobile } from '../platform'
import { t } from '../i18n'
import {
  aiState, aiReady, aiSupported, entriesFor, runTask, cancelEntry, isRunning, endpointApproved, approveEndpoint,
  endpointInfo, citeMax, entryTitle, unitOf, saveEntryAsNote, noteStillThere, type AiEntry, type EntryKind,
} from '../ai'

const emit = defineEmits<{ close: []; goto: [page: number]; toast: [msg: string]; settings: []; undo: [] }>()

const phone = computed(() => isMobile() || window.innerWidth < 700)
const tab = computed(() => store.activeTab)
const ready = computed(() => { void store.settings.ai; return aiReady() })
const supported = computed(() => aiSupported(tab.value?.kind))
const info = computed(() => { void store.settings.ai.provider.baseUrl; void store.settings.ai.provider.model; return endpointInfo() })
const entries = computed<AiEntry[]>(() => (tab.value ? entriesFor(tab.value.id) : []))
const busy = computed(() => entries.value.some(isRunning))
const unit = computed(() => (tab.value ? unitOf(tab.value.id) : 'page'))
const question = ref('')
const threadEl = ref<HTMLDivElement>()
const inputEl = ref<HTMLTextAreaElement>()
/** an action waiting for the first-use approval of this endpoint */
const consent = ref<null | (() => void)>(null)

// ── answer rendering: a small, safe Markdown subset + citation chips ──
type Part = { html: string } | { pages: number[] }
interface Block { cls: string; marker: string; parts: Part[] }

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
}

function render(text: string, max: number): Block[] {
  const out: Block[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    let cls = 'ask-p'
    let marker = ''
    let body = line
    const li = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/)
    const h = line.match(/^\s*#{1,6}\s+(.*)$/)
    if (li) { cls = 'ask-li'; marker = li[1] ? `${li[1]}.` : '•'; body = li[2] }
    else if (h) { cls = 'ask-h'; body = h[1] }
    const parts: Part[] = parseCitations(body, max).map((s) =>
      s.type === 'text' ? { html: inline(s.text) } : { pages: s.pages })
    out.push({ cls, marker, parts })
  }
  return out
}

function chip(page: number): string {
  if (unit.value === 'chapter') return t('ai.chipChapter', { n: page })
  return 'p.' + labelOf(tab.value, page)
}

function sourcesText(e: AiEntry): string {
  const list = e.sources.slice(0, 12).map(chip).join(', ')
  return t('ai.sources', { pages: e.sources.length > 12 ? `${list} …` : list })
}

function progressText(e: AiEntry): string {
  const p = e.progress!
  if (p.phase === 'extract') return t('ai.reading', { done: p.done, total: p.total })
  if (p.done >= p.total - 1) return t('ai.combining')
  return t('ai.mapProgress', { done: p.done + 1, total: p.total - 1 })
}

function errorText(e: AiEntry): string {
  const err = e.error
  if (!err) return ''
  const i = e.endpoint
  switch (err.code) {
    case 'network': return t('ai.errNetwork', { url: i.url, msg: err.message })
    case 'auth': return t('ai.errAuth')
    case 'model': return t('ai.errModel', { model: i.model, msg: err.message })
    case 'empty': return err.message === 'notext' ? t('ai.errNoText') : t('ai.errEmpty')
    case 'config': return t('ai.errConfig')
    default: return t('ai.errHttp', { msg: err.message })
  }
}

// ── actions ──
function guarded(fn: () => void): void {
  if (!ready.value || !tab.value) return
  if (!endpointApproved()) { consent.value = fn; return }
  fn()
}

function allow(): void {
  approveEndpoint()
  const fn = consent.value
  consent.value = null
  fn?.()
}

function start(kind: EntryKind, prompt: string, page?: number): void {
  const id = tab.value?.id
  if (!id) return
  void runTask(id, kind, prompt, page)
  void scrollToEnd()
}

function summarizeDoc(): void { guarded(() => start('summary', '')) }
function summarizeHere(): void {
  const p = tab.value?.currentPage ?? 1
  guarded(() => start('page', '', p))
}
function ask(): void {
  const q = question.value.trim()
  if (!q || busy.value) return
  guarded(() => { question.value = ''; start('ask', q) })
}
function stopAll(): void {
  for (const e of entries.value) if (isRunning(e)) cancelEntry(e)
}
function retry(e: AiEntry): void { guarded(() => start(e.kind, e.prompt, e.page)) }

async function copy(e: AiEntry): Promise<void> {
  try {
    await navigator.clipboard.writeText(e.text)
    emit('toast', t('ai.copied'))
  } catch {
    emit('toast', t('app.copyFail'))
  }
}

async function save(e: AiEntry): Promise<void> {
  const id = tab.value?.id
  if (!id) return
  try {
    const r = await saveEntryAsNote(id, e)
    emit('toast', t('ai.saved', { file: r.file, page: chip(r.page) }))
  } catch (err) {
    emit('toast', t('app.annotSaveFail', { msg: (err as Error).message }))
  }
}

/** reactive "is the saved note still there" (undo removes it) */
function saved(e: AiEntry): boolean {
  void store.docTick
  return !!tab.value && noteStillThere(tab.value.id, e)
}

async function scrollToEnd(): Promise<void> {
  await nextTick()
  const el = threadEl.value
  if (el) el.scrollTop = el.scrollHeight
}

// keep the newest answer in view while it streams, unless the reader scrolled up
watch(() => entries.value.map((e) => e.text.length + e.status).join(), () => {
  const el = threadEl.value
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) void scrollToEnd()
})

// explain-selection requests handed over by the shell
watch(() => aiState.pending, (p) => {
  if (!p || p.tabId !== tab.value?.id) return
  aiState.pending = null
  guarded(() => start('explain', p.text, p.page))
}, { immediate: true })

onMounted(() => { if (!phone.value) inputEl.value?.focus() })

const max = computed(() => { void store.docTick; return tab.value ? citeMax(tab.value.id) : 0 })
</script>

<template>
  <aside class="ask-panel" :class="{ phone }" data-testid="ask-panel" @keydown.esc.stop="emit('close')">
    <div v-if="phone" class="ask-grip" @click="emit('close')"></div>
    <header class="ask-head">
      <span class="ask-title">{{ t('ai.title') }}</span>
      <span
        v-if="ready"
        class="ask-endpoint"
        :class="{ local: info.local }"
        data-testid="ask-endpoint"
        :title="t('ai.endpointTip', { url: info.url, model: info.model })"
      >{{ info.local ? '🔒' : '🌐' }} {{ t(info.local ? 'ai.local' : 'ai.remote', { host: info.host }) }}</span>
      <button class="ask-close" :title="t('ai.close')" @click="emit('close')">✕</button>
    </header>

    <div v-if="!ready" class="ask-off" data-testid="ask-off">
      <h4>{{ t('ai.offTitle') }}</h4>
      <p>{{ t('ai.offBody') }}</p>
      <button class="primary" @click="emit('settings')">{{ t('ai.openSettings') }}</button>
    </div>
    <div v-else-if="!supported" class="ask-off">
      <p>{{ t('ai.unsupported') }}</p>
    </div>
    <template v-else>
      <div class="ask-actions">
        <button data-testid="ask-sum-doc" :disabled="busy" @click="summarizeDoc">{{ t('ai.summarizeDoc') }}</button>
        <button data-testid="ask-sum-page" :disabled="busy" @click="summarizeHere">
          {{ t(unit === 'chapter' ? 'ai.summarizeChapter' : 'ai.summarizePage') }}
        </button>
      </div>

      <div ref="threadEl" class="ask-thread">
        <p v-if="!entries.length" class="ask-hint">{{ t('ai.emptyThread') }}</p>
        <div
          v-for="e in entries" :key="e.id"
          class="ask-entry" :data-status="e.status" :data-kind="e.kind" data-testid="ask-entry"
        >
          <div class="ask-q">{{ entryTitle(e, unit) }}</div>
          <div v-if="e.progress" class="ask-progress">
            <span>{{ progressText(e) }}</span>
            <progress :value="e.progress.done" :max="e.progress.total"></progress>
          </div>
          <div v-else-if="isRunning(e) && !e.text" class="ask-wait">{{ t('ai.thinking') }}</div>
          <div v-if="e.text" class="ask-a" data-testid="ask-answer">
            <div v-for="(b, i) in render(e.text, max)" :key="i" :class="b.cls">
              <span v-if="b.marker" class="ask-marker">{{ b.marker }}</span>
              <template v-for="(p, j) in b.parts" :key="j">
                <span v-if="'html' in p" v-html="p.html"></span>
                <template v-else>
                  <button
                    v-for="pg in p.pages" :key="pg"
                    class="ask-cite" data-testid="ask-cite" :data-page="pg"
                    :title="t(unit === 'chapter' ? 'ai.citeChapter' : 'ai.cite', { page: pg })"
                    @click="emit('goto', pg)"
                  >{{ chip(pg) }}</button>
                </template>
              </template>
            </div>
          </div>
          <div v-if="e.status === 'error'" class="ask-err" data-testid="ask-error">{{ errorText(e) }}</div>
          <div v-if="e.status === 'cancelled'" class="ask-note">{{ t('ai.cancelled') }}</div>
          <!-- nothing reached the server when it was unreachable: don't claim it was sent -->
          <div
            v-if="e.sources.length && !isRunning(e) && e.error?.code !== 'network' && e.error?.code !== 'config'"
            class="ask-note"
          >{{ sourcesText(e) }}</div>
          <div v-if="e.truncated" class="ask-note">{{ t('ai.truncated') }}</div>
          <div class="ask-entry-actions">
            <template v-if="!isRunning(e)">
              <button v-if="e.status === 'error' || e.status === 'cancelled'" @click="retry(e)">{{ t('ai.retry') }}</button>
              <template v-if="e.status === 'done'">
                <button @click="copy(e)">{{ t('ai.copy') }}</button>
                <button v-if="!saved(e)" data-testid="ask-save" @click="save(e)">{{ t('ai.saveNote') }}</button>
                <template v-else>
                  <span class="ask-saved">✓ {{ t('ai.savedShort') }}</span>
                  <button data-testid="ask-undo" @click="emit('undo')">{{ t('ai.undo') }}</button>
                </template>
              </template>
            </template>
          </div>
        </div>
      </div>

      <div v-if="consent" class="ask-consent" data-testid="ask-consent">
        <h4>{{ t('ai.consentTitle') }}</h4>
        <p>{{ t('ai.consentBody', { doc: tab?.name ?? '' }) }}</p>
        <div class="ask-consent-url">{{ info.url }} · {{ info.model }}</div>
        <p :class="info.local ? 'ask-local' : 'ask-warn'">{{ t(info.local ? 'ai.consentLocal' : 'ai.consentRemote') }}</p>
        <div class="ask-consent-btns">
          <button @click="consent = null">{{ t('ai.cancel') }}</button>
          <button class="primary" data-testid="ask-allow" @click="allow">{{ t('ai.allow') }}</button>
        </div>
      </div>

      <form class="ask-input" @submit.prevent="ask">
        <textarea
          ref="inputEl"
          v-model="question"
          rows="2"
          data-testid="ask-input"
          :placeholder="t('ai.placeholder')"
          @keydown.enter.exact.prevent="ask"
        ></textarea>
        <!-- Stop lives here, not under the answer: a streaming answer keeps
             pushing anything below it, and a moving target can't be hit -->
        <button v-if="busy" type="button" class="ask-stop" data-testid="ask-stop" @click="stopAll">■ {{ t('ai.stop') }}</button>
        <button v-else type="submit" class="primary" data-testid="ask-send" :disabled="!question.trim()">{{ t('ai.ask') }}</button>
      </form>
    </template>
  </aside>
</template>

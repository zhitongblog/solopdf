/**
 * Wires the speech engine to whichever view is on screen.
 *
 * Two sources, one behaviour:
 *   PDF view  — sentences come from pdf.js text items; the sentence being
 *               read is painted over its glyphs and scrolled into view
 *   book mode — sentences come from the rendered blocks; the sentence is
 *               wrapped in a <mark> and the page turns itself at the end
 *
 * Both feed the same Speaker, so pause/skip/rate behave identically and the
 * control bar has one state to show.
 */
import { store, controllers, bookApis } from './store'
import { Speaker, splitSentences, type Utterance } from './tts'
import { clearSpeaking, markSpeaking } from './book/marks'

export const speaker = new Speaker()

/** which tab is being read; stopping any other tab's playback is deliberate */
let activeTabId = 0

export function readingTab(): number {
  return activeTabId
}

function pdfSource(tabId: number) {
  const ctrl = () => controllers.get(tabId)

  const forPage = async (page: number): Promise<Utterance[]> => {
    const c = ctrl()
    if (!c || page < 1 || page > c.numPages) return []
    const sentences = await c.pageSentences(page)
    return sentences.map((s) => ({ text: s.text, page, locator: s.itemRange }))
  }

  return {
    async initial(): Promise<Utterance[]> {
      const tab = store.tabs.find((t) => t.id === tabId)
      const start = tab?.currentPage ?? 1
      let out = await forPage(start)
      // an empty page (a plate, a divider) must not end the reading
      let p = start
      while (!out.length && p < (ctrl()?.numPages ?? 0)) out = await forPage(++p)
      return out
    },
    async more(afterPage: number): Promise<Utterance[]> {
      const c = ctrl()
      let p = afterPage + 1
      while (c && p <= c.numPages) {
        const got = await forPage(p)
        if (got.length) return got
        p++
      }
      return []
    },
    highlight(u: Utterance): void {
      const c = ctrl()
      if (!c) return
      const range = u.locator as [number, number] | undefined
      const quads = range ? c.quadsForCharRange(u.page, range) : []
      c.setSpeaking(u.page, quads)
      if (quads.length) c.revealQuad(u.page, quads[0])
      const tab = store.tabs.find((t) => t.id === tabId)
      if (tab && tab.currentPage !== u.page) tab.currentPage = u.page
    },
    clear(): void {
      ctrl()?.setSpeaking(null)
    },
  }
}

function bookSource(tabId: number) {
  const api = () => bookApis.get(tabId)

  const collect = (): Utterance[] => {
    const blocks = api()?.blocks() ?? []
    const out: Utterance[] = []
    for (const el of blocks) {
      const text = (el.textContent ?? '').trim()
      if (!text) continue
      const page = parseInt(el.dataset.page ?? '1', 10) || 1
      for (const s of splitSentences(text)) out.push({ text: s, page, locator: el })
    }
    return out
  }

  return {
    async initial(): Promise<Utterance[]> {
      return collect()
    },
    async more(): Promise<Utterance[]> {
      const a = api()
      if (!a) return []
      // walk forward until a section with actual text turns up
      for (let i = 0; i < 20; i++) {
        if (!(await a.advance())) return []
        const got = collect()
        if (got.length) return got
      }
      return []
    },
    highlight(u: Utterance): void {
      const el = u.locator as HTMLElement | undefined
      if (!el?.isConnected) return
      const mark = markSpeaking(el, u.text)
      ;(mark ?? el).scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    },
    clear(): void {
      const host = document.querySelector(`.bk-scroll`) as HTMLElement | null
      if (host) clearSpeaking(host)
    },
  }
}

type Source = ReturnType<typeof pdfSource>

let source: Source | null = null

export function isBookTab(tabId: number): boolean {
  const tab = store.tabs.find((t) => t.id === tabId)
  return !!tab && (tab.bookMode || tab.kind !== 'pdf')
}

export async function startReading(tabId: number): Promise<void> {
  stopReading()
  activeTabId = tabId
  source = (isBookTab(tabId) ? bookSource(tabId) : pdfSource(tabId)) as Source
  speaker.fetchMore = (after) => source!.more(after)
  speaker.onSentence = (u) => source?.highlight(u)
  const initial = await source.initial()
  if (!initial.length) {
    activeTabId = 0
    source = null
    return
  }
  speaker.setOptions({
    rate: store.settings.tts.rate,
    pitch: store.settings.tts.pitch,
    voiceURI: store.settings.tts.voiceURI,
    lang: store.settings.tts.lang,
  })
  await speaker.start(initial)
}

export function stopReading(): void {
  speaker.stop()
  source?.clear()
  source = null
  activeTabId = 0
}

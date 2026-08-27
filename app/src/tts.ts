/**
 * Read aloud.
 *
 * Uses the platform speech synthesiser through the WebView (Web Speech API),
 * which means zero bundle size, zero network, and the same voices the user
 * already picked in their OS settings — exactly the trade the rest of this
 * app makes.
 *
 * Speech is driven one SENTENCE at a time rather than one page at a time:
 *  - engines truncate or stall on very long utterances (WebKit in particular)
 *  - it gives the caller a natural unit to highlight and scroll to
 *  - pause/skip land on a boundary a listener recognises
 *
 * The caller supplies sentences lazily via `fetchMore`, so a 1000-page book
 * is never flattened into memory to start reading page 3.
 */

export interface Utterance {
  /** raw text, spoken as-is */
  text: string
  /** 1-based page (PDF) or section (book mode) this came from */
  page: number
  /** opaque locator the caller uses to highlight this sentence */
  locator?: unknown
}

export interface TtsOptions {
  rate: number
  pitch: number
  voiceURI: string
  /** BCP-47 hint used when no explicit voice is chosen */
  lang: string
}

export const DEFAULT_TTS: TtsOptions = { rate: 1, pitch: 1, voiceURI: '', lang: '' }

export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/**
 * Voices arrive asynchronously in WebKit: the first getVoices() is empty and
 * a `voiceschanged` event follows. Resolve on whichever happens first.
 */
export function loadVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  if (!ttsSupported()) return Promise.resolve([])
  const now = speechSynthesis.getVoices()
  if (now.length) return Promise.resolve(now)
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      speechSynthesis.removeEventListener('voiceschanged', finish)
      resolve(speechSynthesis.getVoices())
    }
    speechSynthesis.addEventListener('voiceschanged', finish)
    setTimeout(finish, timeoutMs)
  })
}

/**
 * Split text into speakable sentences.
 *
 * CJK has no spaces and uses full-width terminators; Latin scripts need the
 * terminator plus a following boundary so "Dr. Who" stays one sentence. Very
 * long runs (tables, references) are hard-split so the engine never chokes.
 */
export function splitSentences(text: string, maxLen = 220): string[] {
  const out: string[] = []
  const push = (s: string): void => {
    const t = s.trim()
    if (!t) return
    if (t.length <= maxLen) { out.push(t); return }
    // hard-split on the last comma-ish break before the limit, else on length
    let rest = t
    while (rest.length > maxLen) {
      const window = rest.slice(0, maxLen)
      const at = Math.max(
        window.lastIndexOf('，'), window.lastIndexOf(','),
        window.lastIndexOf('；'), window.lastIndexOf(';'),
        window.lastIndexOf(' '),
      )
      const cut = at > maxLen * 0.5 ? at + 1 : maxLen
      out.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut)
    }
    if (rest.trim()) out.push(rest.trim())
  }
  // terminator, then (for ASCII punctuation) a space/quote/end boundary
  const re = /([^。．！？!?…\n]*?(?:[。．！？…]+|[!?]+(?=\s|$|["'”’)\]])|\n+))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    push(m[0])
    last = re.lastIndex
  }
  push(text.slice(last))
  return out
}

type State = 'idle' | 'speaking' | 'paused'

export class Speaker {
  private queue: Utterance[] = []
  private at = 0
  private state: State = 'idle'
  private opts: TtsOptions = { ...DEFAULT_TTS }
  private current: SpeechSynthesisUtterance | null = null
  private fetching = false
  /** guards against the "ended" callback firing after we stopped on purpose */
  private epoch = 0

  /** consecutive engine errors; a run of them means speech is not working */
  private errors = 0

  /** called before each sentence with its index in the queue */
  onSentence: (u: Utterance, index: number) => void = () => {}
  onStateChange: (s: State) => void = () => {}
  /** engine gave up (no voice, autoplay blocked, …) — surfaced to the user */
  onError: (reason: string) => void = () => {}
  /** ask the caller for more sentences; return [] when the document ends */
  fetchMore: (afterPage: number) => Promise<Utterance[]> = async () => []

  get status(): State {
    return this.state
  }

  get position(): number {
    return this.at
  }

  setOptions(o: Partial<TtsOptions>): void {
    this.opts = { ...this.opts, ...o }
    // a rate change mid-sentence only takes effect on the next one; restart
    // the current sentence so the change is audible immediately
    if (this.state === 'speaking') this.speakCurrent()
  }

  async start(initial: Utterance[]): Promise<void> {
    this.stop()
    this.errors = 0
    this.queue = initial
    this.at = 0
    if (!this.queue.length) return
    this.setState('speaking')
    this.speakCurrent()
  }

  pause(): void {
    if (this.state !== 'speaking') return
    speechSynthesis.pause()
    this.setState('paused')
  }

  resume(): void {
    if (this.state !== 'paused') return
    speechSynthesis.resume()
    this.setState('speaking')
    // WebKit sometimes drops the utterance while paused; if nothing is
    // pending after resume, re-speak the current sentence
    setTimeout(() => {
      if (this.state === 'speaking' && !speechSynthesis.speaking) this.speakCurrent()
    }, 250)
  }

  toggle(): void {
    if (this.state === 'speaking') this.pause()
    else if (this.state === 'paused') this.resume()
  }

  stop(): void {
    this.epoch++
    this.current = null
    if (ttsSupported()) speechSynthesis.cancel()
    this.setState('idle')
  }

  skip(delta: number): void {
    const next = this.at + delta
    if (next < 0) return
    if (next >= this.queue.length) { void this.advance(); return }
    this.at = next
    if (this.state === 'idle') this.setState('speaking')
    this.speakCurrent()
  }

  private setState(s: State): void {
    if (this.state === s) return
    this.state = s
    this.onStateChange(s)
  }

  private speakCurrent(): void {
    if (!ttsSupported()) return
    const u = this.queue[this.at]
    if (!u) return
    const mine = ++this.epoch
    speechSynthesis.cancel()
    const utter = new SpeechSynthesisUtterance(u.text)
    utter.rate = this.opts.rate
    utter.pitch = this.opts.pitch
    const voices = speechSynthesis.getVoices()
    const voice = this.opts.voiceURI ? voices.find((v) => v.voiceURI === this.opts.voiceURI) : undefined
    if (voice) utter.voice = voice
    else if (this.opts.lang) utter.lang = this.opts.lang
    utter.onend = () => {
      if (mine !== this.epoch) return // superseded by a skip/stop
      this.errors = 0
      void this.advance()
    }
    utter.onerror = (ev) => {
      if (mine !== this.epoch) return // cancelled on purpose; not an error
      const reason = (ev as SpeechSynthesisErrorEvent).error || 'unknown'
      // Autoplay policy blocks speech that wasn't started by a gesture, and a
      // missing voice fails every sentence identically. Racing silently
      // through a 1000-page book in that state is the worst possible answer:
      // stop and say what happened.
      this.errors++
      if (reason === 'not-allowed' || reason === 'audio-busy' || this.errors >= 3) {
        // report BEFORE stopping: stop() flips the state to idle, and the
        // listener uses "idle without an error" to mean "finished cleanly"
        this.onError(reason)
        this.stop()
        return
      }
      void this.advance()
    }
    this.current = utter
    this.onSentence(u, this.at)
    // Chrome/WebKit both need a tick between cancel() and speak(), or the
    // new utterance is swallowed by the cancellation
    setTimeout(() => {
      if (mine === this.epoch && this.state !== 'idle') speechSynthesis.speak(utter)
    }, 0)
  }

  private async advance(): Promise<void> {
    if (this.state === 'idle') return
    if (this.at + 1 < this.queue.length) {
      this.at++
      this.speakCurrent()
      return
    }
    if (this.fetching) return
    this.fetching = true
    try {
      const lastPage = this.queue[this.queue.length - 1]?.page ?? 0
      const more = await this.fetchMore(lastPage)
      if (!more.length) { this.stop(); return }
      this.queue = [...this.queue, ...more]
      this.at++
      this.speakCurrent()
    } finally {
      this.fetching = false
    }
  }
}

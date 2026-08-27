/**
 * Reading statistics — local, and only local.
 *
 * A tick runs while a document is open, the window is focused, and the reader
 * has done something (scroll, key, tap) in the last IDLE_MS. That last
 * condition is the whole point: a book left open on a desk overnight must not
 * report eight hours of reading, or the numbers stop meaning anything.
 *
 * Stored in the same state.json as everything else, keyed by path with a
 * content-hash mirror so a moved file keeps its history.
 */
import { store, type TabState } from './store'

const TICK_MS = 5000
/** no input for this long and we stop counting */
const IDLE_MS = 90_000

export interface DocStat {
  /** display name, so the panel can list a file that has since moved away */
  name: string
  seconds: number
  /** page turns, a rough proxy for "how much did I get through" */
  turns: number
  sessions: number
  firstAt: number
  lastAt: number
}

export interface Stats {
  docs: Record<string, DocStat>
  /** YYYY-MM-DD → seconds */
  days: Record<string, number>
}

export const EMPTY_STATS: Stats = { docs: {}, days: {} }

function today(at = Date.now()): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function keysFor(tab: TabState): string[] {
  const h = store.hashes[tab.path]
  return h ? [tab.path, `hash:${h}`] : [tab.path]
}

let lastInput = Date.now()
let timer = 0
let sessionTab = 0

function noteInput(): void {
  lastInput = Date.now()
}

function record(seconds: number): void {
  const tab = store.activeTab
  if (!tab) return
  const now = Date.now()
  for (const key of keysFor(tab)) {
    const prev = store.stats.docs[key]
    store.stats.docs[key] = {
      name: tab.name,
      seconds: (prev?.seconds ?? 0) + seconds,
      turns: prev?.turns ?? 0,
      sessions: prev?.sessions ?? 0,
      firstAt: prev?.firstAt ?? now,
      lastAt: now,
    }
  }
  const day = today(now)
  store.stats.days[day] = (store.stats.days[day] ?? 0) + seconds
}

/** call when the reader moves to another page */
export function noteTurn(): void {
  const tab = store.activeTab
  if (!tab) return
  noteInput()
  for (const key of keysFor(tab)) {
    const prev = store.stats.docs[key]
    if (prev) prev.turns += 1
  }
}

function tick(): void {
  const tab = store.activeTab
  if (!tab) { sessionTab = 0; return }
  if (document.visibilityState !== 'visible') return
  if (Date.now() - lastInput > IDLE_MS) return
  if (sessionTab !== tab.id) {
    sessionTab = tab.id
    for (const key of keysFor(tab)) {
      const prev = store.stats.docs[key]
      if (prev) prev.sessions += 1
      else store.stats.docs[key] = {
        name: tab.name, seconds: 0, turns: 0, sessions: 1,
        firstAt: Date.now(), lastAt: Date.now(),
      }
    }
  }
  record(TICK_MS / 1000)
}

export function startStats(): void {
  if (timer) return
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const) {
    window.addEventListener(ev, noteInput, { passive: true, capture: true })
  }
  document.addEventListener('visibilitychange', noteInput)
  timer = window.setInterval(tick, TICK_MS)
}

export function stopStats(): void {
  if (timer) { clearInterval(timer); timer = 0 }
}

// ── queries for the panel ────────────────────────────────────────────────

export function secondsToday(): number {
  return store.stats.days[today()] ?? 0
}

export function totalSeconds(): number {
  return Object.values(store.stats.days).reduce((a, b) => a + b, 0)
}

/**
 * Consecutive days ending today (or yesterday, so a streak isn't "broken"
 * at one minute past midnight before you have read anything).
 */
export function streak(): number {
  const days = store.stats.days
  const day = (offset: number): string => today(Date.now() - offset * 86400_000)
  let start = 0
  if (!days[day(0)]) {
    if (!days[day(1)]) return 0
    start = 1
  }
  let n = 0
  for (let i = start; i < 3650; i++) {
    if (!days[day(i)]) break
    n++
  }
  return n
}

/** per-document rows, newest first, with hash mirrors folded away */
export function docRows(): (DocStat & { key: string })[] {
  const seen = new Set<string>()
  const rows: (DocStat & { key: string })[] = []
  for (const [key, stat] of Object.entries(store.stats.docs)) {
    if (key.startsWith('hash:')) continue
    seen.add(stat.name)
    rows.push({ ...stat, key })
  }
  // a file only ever seen under a hash key (moved away) still deserves a row
  for (const [key, stat] of Object.entries(store.stats.docs)) {
    if (!key.startsWith('hash:') || seen.has(stat.name)) continue
    rows.push({ ...stat, key })
  }
  return rows.sort((a, b) => b.lastAt - a.lastAt)
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h && m) return `${h} h ${m} min`
  if (h) return `${h} h`
  return `${m} min`
}

/** last 14 days, oldest first — the panel's little bar chart */
export function recentDays(n = 14): { day: string; seconds: number }[] {
  const out: { day: string; seconds: number }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = today(Date.now() - i * 86400_000)
    out.push({ day: d, seconds: store.stats.days[d] ?? 0 })
  }
  return out
}

export function exportMarkdown(): string {
  const lines: string[] = ['# SoloPDF 阅读统计', '']
  lines.push(`- 今日：${formatDuration(secondsToday())}`)
  lines.push(`- 累计：${formatDuration(totalSeconds())}`)
  lines.push(`- 连续天数：${streak()}`)
  lines.push('', '## 按文档', '')
  lines.push('| 文档 | 时长 | 翻页 | 次数 | 最近 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const r of docRows()) {
    lines.push(
      `| ${r.name} | ${formatDuration(r.seconds)} | ${r.turns} | ${r.sessions} | ${new Date(r.lastAt).toLocaleDateString()} |`,
    )
  }
  lines.push('', '## 按天', '')
  for (const { day, seconds } of recentDays(30)) {
    if (seconds) lines.push(`- ${day}：${formatDuration(seconds)}`)
  }
  return lines.join('\n') + '\n'
}

export function clearStats(): void {
  store.stats = { docs: {}, days: {} }
}

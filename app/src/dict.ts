/**
 * Offline word lookup.
 *
 * Two sources, in order:
 *  1. the system dictionary (Dictionary.app on macOS, the look-up panel on
 *     iOS) — every language Apple ships, zero bytes in our bundle
 *  2. bundled CC-CEDICT shards — Chinese↔English on every platform, and the
 *     only dictionary on Windows/Linux
 *
 * Plus any plain-text dictionaries the user drops into the app data folder,
 * so this is extensible without us shipping more data.
 *
 * Nothing here touches the network. An online lookup exists as an explicit,
 * opt-in button that opens the system browser — never a silent request.
 */
import { gunzipSync } from 'fflate'
import { isTauri } from './platform'

/** must match scripts/build-dict.mjs */
const BUCKETS = 128
const FS = String.fromCharCode(31)
const RS = String.fromCharCode(30)

export interface DictEntry {
  word: string
  /** traditional form, when it differs */
  traditional?: string
  pronunciation?: string
  definition: string
  source: string
}

type Shard = Map<string, string>

const shards = new Map<number, Shard | null>()
const userEntries = new Map<string, DictEntry[]>()
let userLoaded = false

const bucketOf = (word: string): number => (word.codePointAt(0) ?? 0) % BUCKETS

async function loadShard(bucket: number): Promise<Shard | null> {
  if (shards.has(bucket)) return shards.get(bucket)!
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}dict/${bucket}.dic`)
    if (!res.ok) throw new Error(String(res.status))
    const bytes = new Uint8Array(await res.arrayBuffer())
    // gzip magic — a server that already decompressed for us hands over plain
    // UTF-8, and gunzipping that would throw
    const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes
    const text = new TextDecoder().decode(raw)
    const map: Shard = new Map()
    for (const line of text.split('\n')) {
      const at = line.indexOf(FS)
      if (at < 0) continue
      map.set(line.slice(0, at), line.slice(at + 1))
    }
    shards.set(bucket, map)
    return map
  } catch {
    // a missing shard is not an error the reader should ever see; it just
    // means this build has no bundled dictionary for that range
    shards.set(bucket, null)
    return null
  }
}

function parseRecords(word: string, blob: string): DictEntry[] {
  return blob.split(RS).map((rec) => {
    const [trad, pron, def] = rec.split(FS)
    return {
      word,
      traditional: trad || undefined,
      pronunciation: pron || undefined,
      definition: def ?? '',
      source: 'CC-CEDICT',
    }
  })
}

async function lookupBundled(word: string): Promise<DictEntry[]> {
  const shard = await loadShard(bucketOf(word))
  const blob = shard?.get(word)
  if (!blob) return []
  // traditional headwords are stored as a pointer to the simplified entry
  if (blob.startsWith('>' + FS)) {
    const target = blob.slice(2)
    const other = await loadShard(bucketOf(target))
    const real = other?.get(target)
    return real ? parseRecords(target, real) : []
  }
  return parseRecords(word, blob)
}

/**
 * User dictionaries: one `.txt` per dictionary in <appData>/dictionaries,
 * each line `word<TAB>definition`. Small enough to hold in memory — these
 * are hand-made glossaries, not another CC-CEDICT.
 */
async function loadUserDicts(): Promise<void> {
  if (userLoaded || !isTauri()) return
  userLoaded = true
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const files = await invoke<{ name: string; text: string }[]>('read_user_dicts')
    for (const f of files) {
      for (const line of f.text.split('\n')) {
        const at = line.search(/[\t=]/)
        if (at <= 0) continue
        const word = line.slice(0, at).trim()
        const def = line.slice(at + 1).trim()
        if (!word || !def) continue
        const list = userEntries.get(word) ?? []
        list.push({ word, definition: def, source: f.name })
        userEntries.set(word, list)
      }
    }
  } catch {
    /* no user dictionaries is the normal case */
  }
}

/**
 * Look a selection up. For CJK the selection is often a phrase, so we try the
 * longest prefix first and shorten until something matches — the same
 * greedy-longest rule a Chinese segmenter uses, and the reason tapping
 * "汉字文化圈" finds 汉字文化圈 rather than just 汉.
 */
export async function lookup(selection: string, maxLen = 8): Promise<DictEntry[]> {
  const word = selection.trim().replace(/\s+/g, ' ')
  if (!word) return []
  await loadUserDicts()
  const candidates: string[] = []
  const cjk = /[㐀-鿿豈-﫿]/.test(word)
  if (cjk) {
    const head = [...word].slice(0, maxLen)
    for (let n = head.length; n >= 1; n--) candidates.push(head.slice(0, n).join(''))
  } else {
    candidates.push(word, word.toLowerCase(), word.replace(/[.,;:!?)"']+$/, ''))
  }
  for (const c of candidates) {
    const user = userEntries.get(c)
    if (user?.length) return user
    const hits = await lookupBundled(c)
    if (hits.length) return hits
  }
  return []
}

/** Ask the OS to show its own dictionary panel. */
export async function systemDefine(word: string): Promise<'shown' | 'none' | 'unsupported'> {
  if (!isTauri()) return 'unsupported'
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<'shown' | 'none' | 'unsupported'>('define_word', { word })
  } catch {
    return 'unsupported'
  }
}

/** Explicit, user-initiated web lookup — opens the system browser. */
export async function webLookup(word: string, template: string): Promise<void> {
  const url = template.replace('%s', encodeURIComponent(word))
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } else {
    window.open(url, '_blank', 'noopener')
  }
}

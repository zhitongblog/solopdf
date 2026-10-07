/**
 * Optional content (PDF "layers", OCGs — ISO 32000-1 §8.11).
 *
 * pdf.js parses the groups, the default ON/OFF state, the /Order tree and
 * the /RBGroups radio sets into an OptionalContentConfig; rendering consults
 * that object, so toggling a layer = flip it there + re-render. Two things
 * pdf.js does NOT expose are filled in here:
 *
 *   - /Locked (layers the author froze): scanned from the raw file bytes
 *     by findLockedOcgs(), including compressed object streams when the
 *     caller passes an inflate function.
 *   - the radio/locked interplay: turning a radio member on must not switch
 *     off a LOCKED sibling, so setLayer() refuses that instead of silently
 *     breaking the lock.
 *
 * Shared by the viewer (Layers sidebar tab), the CLI (`solopdf layers`) and
 * the MCP server (`solopdf_layers`). Engine-agnostic: only the
 * OptionalContentConfig surface in `OcConfigLike` is used.
 */

export interface OcGroupLike {
  name: string | null
  visible: boolean
  /** radio-button sets this group belongs to (pdf.js: array of Set<id>) */
  rbGroups?: Iterable<string>[]
}

export interface OcConfigLike {
  getOrder(): unknown[] | null
  getGroup(id: string): OcGroupLike | null
  setVisibility(id: string, visible?: boolean, preserveRB?: boolean): void
  [Symbol.iterator](): Iterator<[string, OcGroupLike]>
}

export type LayerRow =
  | {
    type: 'layer'
    id: string
    name: string
    visible: boolean
    locked: boolean
    /** 0-based index of the radio group this layer belongs to, null if none */
    radio: number | null
    depth: number
  }
  | { type: 'heading'; name: string; depth: number }

/** does this config hold any optional content at all? */
export function hasLayers(config: OcConfigLike | null | undefined): boolean {
  return !!config && config.getOrder() !== null
}

/** distinct radio groups across all layers, as sorted id lists */
export function radioGroups(config: OcConfigLike): string[][] {
  const seen = new Map<string, string[]>()
  for (const [, g] of config) {
    for (const set of g.rbGroups ?? []) {
      const ids = [...set].sort()
      if (ids.length) seen.set(ids.join('|'), ids)
    }
  }
  return [...seen.values()]
}

/**
 * Flatten /Order into display rows. Nested arrays become indented runs; a
 * nested array whose first entry is a string is a labelled heading (pdf.js
 * hands those over as `{ name, order }`). Groups missing from /Order still
 * appear (pdf.js appends them under a nameless entry).
 */
export function layerRows(config: OcConfigLike, locked: Iterable<string> = []): LayerRow[] {
  const lockedSet = new Set(locked)
  const radios = radioGroups(config)
  const radioOf = (id: string): number | null => {
    const i = radios.findIndex((ids) => ids.includes(id))
    return i < 0 ? null : i
  }
  const rows: LayerRow[] = []
  const placed = new Set<string>()
  const walk = (items: unknown[], depth: number): void => {
    for (const it of items) {
      if (typeof it === 'string') {
        const g = config.getGroup(it)
        if (!g || placed.has(it)) continue
        placed.add(it)
        rows.push({
          type: 'layer', id: it, name: g.name ?? it, visible: g.visible,
          locked: lockedSet.has(it), radio: radioOf(it), depth,
        })
      } else if (Array.isArray(it)) {
        walk(it, depth + 1)
      } else if (it && typeof it === 'object' && Array.isArray((it as { order?: unknown }).order)) {
        const { name, order } = it as { name: string | null; order: unknown[] }
        if (name) {
          rows.push({ type: 'heading', name, depth })
          walk(order, depth + 1)
        } else walk(order, depth)
      }
    }
  }
  walk(config.getOrder() ?? [], 0)
  // anything the order tree skipped (pdf.js already appends these, but a
  // hand-built config might not)
  for (const [id, g] of config) {
    if (placed.has(id)) continue
    rows.push({ type: 'layer', id, name: g.name ?? id, visible: g.visible, locked: lockedSet.has(id), radio: radioOf(id), depth: 0 })
  }
  return rows
}

/** id → visible, for every group */
export function layerStates(config: OcConfigLike): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [id, g] of config) out[id] = g.visible
  return out
}

export type SetLayerResult =
  | { ok: true; changed: string[] }
  | { ok: false; reason: 'unknown' | 'locked' | 'radio-locked'; by?: string }

/**
 * Turn one layer on/off, honouring the document's rules:
 *   - a locked layer never changes
 *   - turning a radio member ON switches its siblings OFF — unless a sibling
 *     that is currently on is locked, in which case nothing changes
 * Returns the ids whose visibility actually changed.
 */
export function setLayer(
  config: OcConfigLike, id: string, visible: boolean, locked: Iterable<string> = [],
): SetLayerResult {
  const g = config.getGroup(id)
  if (!g) return { ok: false, reason: 'unknown' }
  const lockedSet = new Set(locked)
  if (lockedSet.has(id)) return { ok: false, reason: 'locked' }
  const before = layerStates(config)
  if (visible) {
    for (const set of g.rbGroups ?? []) {
      for (const other of set) {
        if (other !== id && lockedSet.has(other) && config.getGroup(other)?.visible) {
          return { ok: false, reason: 'radio-locked', by: other }
        }
      }
    }
  }
  config.setVisibility(id, visible, true)
  const after = layerStates(config)
  return { ok: true, changed: Object.keys(after).filter((k) => after[k] !== before[k]) }
}

/**
 * Re-apply a saved per-document state (only the layers the reader changed
 * are stored). Locked layers and ids that no longer exist are skipped; ON
 * entries go last so radio exclusivity resolves the same way it did when
 * the reader clicked.
 */
export function applyLayerStates(
  config: OcConfigLike, saved: Record<string, boolean> | undefined, locked: Iterable<string> = [],
): void {
  if (!saved) return
  const lockedSet = new Set(locked)
  const entries = Object.entries(saved).filter(([id]) => config.getGroup(id) && !lockedSet.has(id))
  for (const [id, v] of entries) if (!v) config.setVisibility(id, false, false)
  for (const [id, v] of entries) if (v) config.setVisibility(id, true, true)
}

/** the subset of `now` that differs from `initial` — what gets persisted */
export function layerDiff(
  initial: Record<string, boolean>, now: Record<string, boolean>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [id, v] of Object.entries(now)) if (initial[id] !== v) out[id] = v
  return out
}

const refId = (num: string, gen: string): string => (gen === '0' ? `${num}R` : `${num}R${gen}`)

function lockedIn(text: string, out: Set<string>): void {
  // /Locked only appears in optional-content configuration dictionaries
  // (signature fields use /Lock, annotations use flag bits)
  const re = /\/Locked\s*\[([^\]]*)\]/g
  for (const m of text.matchAll(re)) {
    for (const r of m[1].matchAll(/(\d+)\s+(\d+)\s+R/g)) out.add(refId(r[1], r[2]))
  }
}

/**
 * Ids (pdf.js form, "12R") of the layers listed in any /Locked array.
 * Scans the plain file text, plus every FlateDecode object stream when
 * `inflate` is given (PDF 1.5+ writers usually compress the catalog's
 * neighbours into one). Best effort: an unreadable stream is skipped.
 */
export function findLockedOcgs(bytes: Uint8Array, inflate?: (data: Uint8Array) => Uint8Array): string[] {
  const out = new Set<string>()
  const text = latin1(bytes)
  lockedIn(text, out)
  if (inflate && /\/ObjStm/.test(text)) {
    const re = /\/Type\s*\/ObjStm[^]*?stream\r?\n/g
    for (const m of text.matchAll(re)) {
      const dictStart = text.lastIndexOf('obj', m.index)
      const dict = text.slice(dictStart, m.index + m[0].length)
      if (!/\/FlateDecode/.test(dict)) continue
      const start = m.index + m[0].length
      const end = text.indexOf('endstream', start)
      if (end < 0) continue
      try {
        lockedIn(latin1(inflate(bytes.subarray(start, end))), out)
      } catch { /* damaged stream — nothing to learn from it */ }
    }
  }
  return [...out]
}

function latin1(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])
  }
  return s
}

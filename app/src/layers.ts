/**
 * Optional content ("layers") for open PDF tabs.
 *
 *   openPath ──prepareLayers()──▶ one OptionalContentConfig per tab
 *                                   │  (saved docPrefs.layers applied
 *                                   │   BEFORE the first render)
 *        ┌──────────────┬───────────┼──────────────┬──────────────┐
 *     main pane     split pane   thumbnails      print      region/preview
 *     (all render with the SAME config object — toggling flips it once
 *      and every consumer re-renders)
 *
 * The rules (radio groups, locked layers) live in core/src/layers.ts and are
 * shared with the CLI and MCP server. /Locked isn't parsed by pdf.js, so it
 * comes from a background scan of the file bytes; until that finishes a
 * locked layer merely looks unlocked, and any saved state that touched it is
 * rolled back once the scan knows better.
 */
import { reactive } from 'vue'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { unzlibSync } from 'fflate'
import {
  layerRows, layerStates, layerDiff, setLayer, applyLayerStates, findLockedOcgs,
  type LayerRow, type SetLayerResult,
} from '@solopdf/core'
import { controllers, splitControllers, docPrefsFor, saveDocPrefs, tabCloseHooks, type TabState } from './store'
import { platform } from './platform'

export type OcConfig = Awaited<ReturnType<PDFDocumentProxy['getOptionalContentConfig']>>

interface LayerDoc {
  path: string
  config: OcConfig
  /** the document's own default visibility (what "reset" returns to) */
  initial: Record<string, boolean>
  locked: string[]
}

/** non-reactive: pdf.js objects stay out of Vue proxies */
const docs = new Map<number, LayerDoc>()

/** what the sidebar draws; `tick` bumps on every visibility change so
 *  thumbnails know to re-render */
export const layerView = reactive<Record<number, { rows: LayerRow[]; tick: number; changed: boolean }>>({})

/** bigger files are not read whole just to learn which layers are locked */
const LOCK_SCAN_MAX = 64 * 1024 * 1024

tabCloseHooks.push((id) => {
  docs.delete(id)
  delete layerView[id]
})

/**
 * Load the tab's layer config and re-apply the reader's saved choices.
 * Resolves to null for documents without optional content (render then
 * uses pdf.js's own default, exactly as before this feature existed).
 */
export async function prepareLayers(tab: TabState, doc: PDFDocumentProxy): Promise<OcConfig | null> {
  let config: OcConfig
  try {
    config = await doc.getOptionalContentConfig({ intent: 'display' })
  } catch {
    return null
  }
  if (config.getOrder() === null) return null
  const initial = layerStates(config)
  applyLayerStates(config, docPrefsFor(tab.path).layers)
  const d: LayerDoc = { path: tab.path, config, initial, locked: [] }
  docs.set(tab.id, d)
  sync(tab.id, false)
  void scanLocked(tab.id, d)
  return config
}

async function scanLocked(tabId: number, d: LayerDoc): Promise<void> {
  try {
    const meta = await platform().fileMeta(d.path)
    if (meta.size > LOCK_SCAN_MAX) return
    const bytes = await platform().readChunk(d.path, 0, meta.size)
    const locked = findLockedOcgs(bytes, (b) => unzlibSync(b)).filter((id) => d.config.getGroup(id))
    if (docs.get(tabId) !== d || !locked.length) return
    d.locked = locked
    // a locked layer shows the document's state, whatever was saved
    let rolledBack = false
    for (const id of locked) {
      if (d.config.getGroup(id)!.visible !== d.initial[id]) {
        d.config.setVisibility(id, d.initial[id], false)
        rolledBack = true
      }
    }
    sync(tabId, rolledBack)
  } catch { /* unreadable → nothing is known to be locked */ }
}

/** refresh the sidebar rows; `repaint` also re-renders every view */
function sync(tabId: number, repaint: boolean): void {
  const d = docs.get(tabId)
  if (!d) return
  const prev = layerView[tabId]
  const now = layerStates(d.config)
  layerView[tabId] = {
    rows: layerRows(d.config, d.locked),
    tick: (prev?.tick ?? 0) + (repaint ? 1 : 0),
    changed: Object.keys(layerDiff(d.initial, now)).length > 0,
  }
  if (!repaint) return
  controllers.get(tabId)?.refreshContent()
  splitControllers.get(tabId)?.refreshContent()
}

function persist(tabId: number): void {
  const d = docs.get(tabId)
  if (!d) return
  saveDocPrefs(d.path, { layers: layerDiff(d.initial, layerStates(d.config)) })
}

/** the shared config for a tab (null = no optional content) */
export function layerConfig(tabId: number): OcConfig | null {
  return docs.get(tabId)?.config ?? null
}

export function hasLayers(tabId: number): boolean {
  return docs.has(tabId)
}

/** switch one layer, honouring radio groups and locks; persists + repaints */
export function toggleLayer(tabId: number, id: string, visible: boolean): SetLayerResult {
  const d = docs.get(tabId)
  if (!d) return { ok: false, reason: 'unknown' }
  const r = setLayer(d.config, id, visible, d.locked)
  if (r.ok && r.changed.length) {
    persist(tabId)
    sync(tabId, true)
  }
  return r
}

/** back to the document's own default visibility */
export function resetLayers(tabId: number): void {
  const d = docs.get(tabId)
  if (!d) return
  for (const [id, v] of Object.entries(d.initial)) d.config.setVisibility(id, v, false)
  persist(tabId)
  sync(tabId, true)
}

/**
 * AnnotationManager — one per open document.
 * Bridges: selection -> Annotation -> sidecar text (core) -> platform write,
 * plus focus-driven re-parse so external SoloMD edits appear live.
 *
 * Write policy (design doc): locate-and-replace by anchor id via core's
 * upsertAnnotation — the manager NEVER regenerates the whole file over an
 * existing one.
 *
 * Undo/redo: every write goes through write(), which diffs the sidecar by
 * anchor id and pushes the touched sections onto a per-document history
 * (core/history.ts). New mutating methods therefore get undo for free as
 * long as they write through write() — never call platform().writeSidecar
 * directly from here. Region images are never deleted on remove, and the
 * bytes of any image a command touches are kept in memory so an undone
 * delete (or redone create) can put a missing file back.
 */
import {
  parse, upsertAnnotation, removeAnnotation, stripPrivate, genId, makeFingerprint,
  diffSidecar, applyEdit, UndoStack,
} from '@solopdf/core'
import type { SidecarEdit } from '@solopdf/core'
import type { Annotation, AnnotationKind, Quad, SidecarMeta, SidecarLabels } from '@solopdf/core'
import { platform } from '../platform'
import { t } from '../i18n'
import type { SelectionInfo } from '../viewer/controller'

/** sidecar display labels follow the app language (parser is label-agnostic) */
function labels(): SidecarLabels {
  return {
    annotations: t('sc.annotations'),
    highlight: t('sc.highlight'),
    jumpBack: t('sc.jumpBack'),
    kinds: {
      highlight: t('sc.highlight'),
      underline: t('sc.underline'),
      strike: t('sc.strike'),
      squiggly: t('sc.squiggly'),
      note: t('sc.note'),
      region: t('sc.region'),
    },
  }
}

/**
 * What an undo step did, for the toast. `kind` is the annotation kind
 * (unknown kinds pass through — the UI falls back to a generic word).
 */
export interface UndoLabel {
  op: 'add' | 'delete' | 'note' | 'color' | 'kind' | 'edit' | 'multi'
  kind: string
  count: number
}

interface UndoEntry {
  edit: SidecarEdit
  label: UndoLabel
  /** image file name -> bytes, for every region image the edit touched */
  assets: Map<string, Uint8Array>
}

export type UndoResult =
  | { ok: true; label: UndoLabel }
  | { ok: false; reason: 'empty' | 'busy' | 'conflict' | 'error'; message?: string }

/** "删除高亮" / "Delete Highlight" … — the action name used in toasts and tooltips */
export function undoLabelText(l: UndoLabel): string {
  if (l.op === 'multi') return t('un.multi', { n: l.count })
  const word = t('sc.' + l.kind)
  const kind = word === 'sc.' + l.kind ? t('un.annot') : word
  return t('un.' + l.op, { kind })
}

function sectionAnnot(section: string | null): Annotation | undefined {
  return section ? parse(section).annotations[0] : undefined
}

/** Describe an edit from its before/after sections — works for any kind. */
function describe(edit: SidecarEdit): UndoLabel {
  const ch = edit.changes
  if (ch.length > 1) {
    const a = sectionAnnot(ch[0].after ?? ch[0].before)
    return { op: 'multi', kind: a?.kind ?? 'highlight', count: ch.length }
  }
  const b = sectionAnnot(ch[0].before)
  const a = sectionAnnot(ch[0].after)
  const kind = (a ?? b)?.kind ?? 'highlight'
  if (!b) return { op: 'add', kind, count: 1 }
  if (!a) return { op: 'delete', kind: b.kind ?? 'highlight', count: 1 }
  if (a.kind !== b.kind) return { op: 'kind', kind, count: 1 }
  if (a.color !== b.color) return { op: 'color', kind, count: 1 }
  if (a.note !== b.note) return { op: 'note', kind, count: 1 }
  return { op: 'edit', kind, count: 1 }
}

export class AnnotationManager {
  annotations: Annotation[] = []
  sidecarLocation = ''
  private text = ''
  private assetUrls = new Map<string, string>()
  private meta: SidecarMeta
  private history = new UndoStack<UndoEntry>(100)
  private undoBusy = false
  onChange: (annots: Annotation[]) => void = () => {}

  constructor(
    private pdfPath: string,
    pdfName: string,
    /** strip excerpts + fingerprints (privacy mode for encrypted PDFs) */
    public stripExcerpts: boolean,
  ) {
    this.meta = { version: 1, pdfName }
  }

  async load(): Promise<void> {
    const { text, location } = await platform().readSidecar(this.pdfPath)
    this.text = text
    this.sidecarLocation = location
    this.annotations = text.trim() ? parse(text).annotations : []
    this.onChange(this.annotations)
  }

  /** re-read on window focus — pick up external edits from SoloMD */
  async refresh(): Promise<void> {
    const { text } = await platform().readSidecar(this.pdfPath)
    if (text === this.text) return
    this.text = text
    // edited outside the app: our recorded sections may no longer describe
    // the file, so history starts over (same rule as any editor on reload)
    this.history.clear()
    this.annotations = text.trim() ? parse(text).annotations : []
    this.onChange(this.annotations)
  }

  async addFromSelection(
    sel: SelectionInfo,
    color: string,
    note = '',
    kind: AnnotationKind = 'highlight',
  ): Promise<Annotation> {
    const fp = makeFingerprint(sel.pre, sel.text, sel.post)
    let a: Annotation = {
      id: genId(),
      anchor: { page: sel.page, quads: sel.quads, pre: fp.pre, post: fp.post, text: fp.text },
      excerpt: sel.text.length > 500 ? sel.text.slice(0, 500) + '…' : sel.text,
      note,
      color,
      kind,
      createdAt: new Date().toISOString(),
    }
    if (this.stripExcerpts) a = stripPrivate(a)
    await this.write(upsertAnnotation(this.text, a, this.pdfPath, this.meta, labels()))
    this.annotations = parse(this.text).annotations
    this.onChange(this.annotations)
    return a
  }

  /**
   * Pin a sticky note at one point (PDF user space). There is no text to
   * fingerprint, so the anchor is page+point — same two-factor fallback the
   * privacy mode uses. A zero-size quad would be rejected by the resolver,
   * so the point is stored as a 1pt box.
   */
  async addNote(page: number, x: number, y: number, note: string): Promise<Annotation> {
    const a: Annotation = {
      id: genId(),
      anchor: { page, quads: [{ x1: x, y1: y, x2: x + 1, y2: y + 1 }], pre: '', post: '' },
      excerpt: '',
      note,
      color: 'yellow',
      kind: 'note',
      createdAt: new Date().toISOString(),
    }
    await this.write(upsertAnnotation(this.text, a, this.pdfPath, this.meta, labels()))
    this.annotations = parse(this.text).annotations
    this.onChange(this.annotations)
    return a
  }

  /**
   * Capture a rectangular region as a PNG beside the sidecar and reference it
   * from the note body — the figure ends up rendered inline in SoloMD, which
   * is the whole point of "highlights are notes" for charts and equations.
   */
  async addRegion(
    page: number,
    rect: Quad,
    png: Uint8Array,
    note = '',
    color = 'blue',
  ): Promise<Annotation> {
    const id = genId()
    const name = `${id}.png`
    await platform().writeSidecarAsset(this.pdfPath, name, png)
    const a: Annotation = {
      id,
      anchor: { page, quads: [rect], pre: '', post: '' },
      excerpt: '',
      note,
      color,
      kind: 'region',
      image: name,
      createdAt: new Date().toISOString(),
    }
    await this.write(upsertAnnotation(this.text, a, this.pdfPath, this.meta, labels()))
    this.annotations = parse(this.text).annotations
    this.onChange(this.annotations)
    return a
  }

  /** Blob URL for a region screenshot, cached per annotation id. */
  async assetUrl(a: Annotation): Promise<string | null> {
    if (!a.image) return null
    const hit = this.assetUrls.get(a.id)
    if (hit) return hit
    const bytes = await platform().readSidecarAsset(this.pdfPath, a.image).catch(() => null)
    if (!bytes) return null
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }))
    this.assetUrls.set(a.id, url)
    return url
  }

  async updateNote(id: string, note: string): Promise<void> {
    await this.update(id, { note })
  }

  /** Change note / colour / kind of one annotation in a single undo step. */
  async update(id: string, patch: Partial<Pick<Annotation, 'note' | 'color' | 'kind'>>): Promise<void> {
    const a = this.annotations.find((x) => x.id === id)
    if (!a) return
    await this.write(upsertAnnotation(this.text, { ...a, ...patch }, this.pdfPath, this.meta, labels()))
    this.annotations = parse(this.text).annotations
    this.onChange(this.annotations)
  }

  async remove(id: string): Promise<void> {
    await this.write(removeAnnotation(this.text, id))
    this.annotations = parse(this.text).annotations
    this.onChange(this.annotations)
  }

  /** release blob URLs (called when the tab closes) */
  dispose(): void {
    for (const u of this.assetUrls.values()) URL.revokeObjectURL(u)
    this.assetUrls.clear()
  }

  // ── undo / redo ──

  get canUndo(): boolean { return this.history.canUndo }
  get canRedo(): boolean { return this.history.canRedo }
  /** label of the step the next undo / redo would apply (button tooltips) */
  get nextUndo(): UndoLabel | undefined { return this.history.peekUndo()?.label }
  get nextRedo(): UndoLabel | undefined { return this.history.peekRedo()?.label }

  undo(): Promise<UndoResult> { return this.step('undo') }
  redo(): Promise<UndoResult> { return this.step('redo') }

  private async step(dir: 'undo' | 'redo'): Promise<UndoResult> {
    if (this.undoBusy) return { ok: false, reason: 'busy' }
    const entry = dir === 'undo' ? this.history.peekUndo() : this.history.peekRedo()
    if (!entry) return { ok: false, reason: 'empty' }
    this.undoBusy = true
    try {
      // the focus refresh may not have run yet (e.g. SoloMD saved while we
      // kept focus) — look at the file itself before splicing into it
      const { text } = await platform().readSidecar(this.pdfPath)
      const next = text === this.text ? applyEdit(text, entry.edit, dir) : null
      if (next === null) {
        this.history.clear()
        if (text !== this.text) {
          this.text = text
          this.annotations = text.trim() ? parse(text).annotations : []
        }
        this.onChange(this.annotations)
        return { ok: false, reason: 'conflict' }
      }
      await this.restoreAssets(entry, next)
      this.sidecarLocation = await platform().writeSidecar(this.pdfPath, next)
      this.text = next
      if (dir === 'undo') this.history.undo()
      else this.history.redo()
      this.annotations = parse(next).annotations
      this.onChange(this.annotations)
      return { ok: true, label: entry.label }
    } catch (err) {
      return { ok: false, reason: 'error', message: (err as Error).message }
    } finally {
      this.undoBusy = false
    }
  }

  /** put back any image the restored sections reference but the disk lost */
  private async restoreAssets(entry: UndoEntry, text: string): Promise<void> {
    for (const [name, bytes] of entry.assets) {
      if (!text.includes(name)) continue
      const have = await platform().readSidecarAsset(this.pdfPath, name).catch(() => null)
      if (!have) await platform().writeSidecarAsset(this.pdfPath, name, bytes)
    }
  }

  private async record(oldText: string, newText: string): Promise<void> {
    const edit = diffSidecar(oldText, newText)
    if (!edit) return
    const assets = new Map<string, Uint8Array>()
    for (const c of edit.changes) {
      for (const sec of [c.before, c.after]) {
        const img = sectionAnnot(sec)?.image
        if (!img || assets.has(img)) continue
        const bytes = await platform().readSidecarAsset(this.pdfPath, img).catch(() => null)
        if (bytes) assets.set(img, bytes)
      }
    }
    this.history.push({ edit, label: describe(edit), assets })
  }

  private async write(newText: string): Promise<void> {
    const old = this.text
    this.sidecarLocation = await platform().writeSidecar(this.pdfPath, newText)
    this.text = newText
    await this.record(old, newText)
  }
}

/**
 * AnnotationManager — one per open document.
 * Bridges: selection -> Annotation -> sidecar text (core) -> platform write,
 * plus focus-driven re-parse so external SoloMD edits appear live.
 *
 * Write policy (design doc): locate-and-replace by anchor id via core's
 * upsertAnnotation — the manager NEVER regenerates the whole file over an
 * existing one.
 */
import {
  parse, upsertAnnotation, removeAnnotation, stripPrivate, genId, makeFingerprint,
} from '@solopdf/core'
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
      ink: t('sc.ink'),
      textbox: t('sc.textbox'),
      rect: t('sc.rect'),
      ellipse: t('sc.ellipse'),
      line: t('sc.line'),
      arrow: t('sc.arrow'),
    },
  }
}

export class AnnotationManager {
  annotations: Annotation[] = []
  sidecarLocation = ''
  private text = ''
  private assetUrls = new Map<string, string>()
  private meta: SidecarMeta
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

  /**
   * Add a drawn mark (ink / shape / text box). Geometry is already in
   * `anchor` (PDF user space); `png` is its picture for the sidecar, written
   * BEFORE the section so the Markdown never points at a missing file.
   */
  async addDrawn(
    fields: Pick<Annotation, 'anchor' | 'kind' | 'color'> & { note?: string },
    png?: Uint8Array | null,
  ): Promise<Annotation> {
    const id = genId()
    let image: string | undefined
    if (png) {
      image = `${id}.png`
      await platform().writeSidecarAsset(this.pdfPath, image, png)
    }
    const a: Annotation = {
      id,
      anchor: fields.anchor,
      excerpt: '',
      note: fields.note ?? '',
      color: fields.color,
      kind: fields.kind,
      image,
      createdAt: new Date().toISOString(),
    }
    await this.write(upsertAnnotation(this.text, a, this.pdfPath, this.meta, labels()))
    this.annotations = parse(this.text).annotations
    this.onChange(this.annotations)
    return a
  }

  /**
   * Generic in-place change of one annotation (move / recolour / reshape /
   * retext). Spliced by id like every other write. A new `png` overwrites
   * the mark's picture under the same name.
   */
  async update(
    id: string,
    patch: Partial<Pick<Annotation, 'anchor' | 'note' | 'color' | 'kind'>>,
    png?: Uint8Array | null,
  ): Promise<Annotation | null> {
    const a = this.annotations.find((x) => x.id === id)
    if (!a) return null
    const next: Annotation = { ...a, ...patch }
    if (png) {
      next.image = a.image ?? `${id}.png`
      await platform().writeSidecarAsset(this.pdfPath, next.image, png)
      this.dropAssetUrl(id)
    }
    await this.write(upsertAnnotation(this.text, next, this.pdfPath, this.meta, labels()))
    this.annotations = parse(this.text).annotations
    this.onChange(this.annotations)
    return this.annotations.find((x) => x.id === id) ?? null
  }

  private dropAssetUrl(id: string): void {
    const u = this.assetUrls.get(id)
    if (u) URL.revokeObjectURL(u)
    this.assetUrls.delete(id)
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
    const a = this.annotations.find((x) => x.id === id)
    if (!a) return
    await this.write(upsertAnnotation(this.text, { ...a, note }, this.pdfPath, this.meta, labels()))
    this.annotations = parse(this.text).annotations
    this.onChange(this.annotations)
  }

  async remove(id: string): Promise<void> {
    this.dropAssetUrl(id)
    await this.write(removeAnnotation(this.text, id))
    this.annotations = parse(this.text).annotations
    this.onChange(this.annotations)
  }

  /** release blob URLs (called when the tab closes) */
  dispose(): void {
    for (const u of this.assetUrls.values()) URL.revokeObjectURL(u)
    this.assetUrls.clear()
  }

  private async write(newText: string): Promise<void> {
    this.sidecarLocation = await platform().writeSidecar(this.pdfPath, newText)
    this.text = newText
  }
}

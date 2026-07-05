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
import type { Annotation, SidecarMeta } from '@solopdf/core'
import { platform } from '../platform'
import type { SelectionInfo } from '../viewer/controller'

export class AnnotationManager {
  annotations: Annotation[] = []
  sidecarLocation = ''
  private text = ''
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

  async addFromSelection(sel: SelectionInfo, color: string, note = ''): Promise<Annotation> {
    const fp = makeFingerprint(sel.pre, sel.text, sel.post)
    let a: Annotation = {
      id: genId(),
      anchor: { page: sel.page, quads: sel.quads, pre: fp.pre, post: fp.post, text: fp.text },
      excerpt: sel.text.length > 500 ? sel.text.slice(0, 500) + '…' : sel.text,
      note,
      color,
      createdAt: new Date().toISOString(),
    }
    if (this.stripExcerpts) a = stripPrivate(a)
    await this.write(upsertAnnotation(this.text, a, this.pdfPath, this.meta))
    this.annotations = parse(this.text).annotations
    this.onChange(this.annotations)
    return a
  }

  async updateNote(id: string, note: string): Promise<void> {
    const a = this.annotations.find((x) => x.id === id)
    if (!a) return
    await this.write(upsertAnnotation(this.text, { ...a, note }, this.pdfPath, this.meta))
    this.annotations = parse(this.text).annotations
    this.onChange(this.annotations)
  }

  async remove(id: string): Promise<void> {
    await this.write(removeAnnotation(this.text, id))
    this.annotations = parse(this.text).annotations
    this.onChange(this.annotations)
  }

  private async write(newText: string): Promise<void> {
    this.sidecarLocation = await platform().writeSidecar(this.pdfPath, newText)
    this.text = newText
  }
}

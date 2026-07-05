/**
 * SoloPDF annotation data model.
 *
 * An annotation lives in two places:
 *  - human-readable body in the `.annotations.md` sidecar (editable in SoloMD)
 *  - machine anchor data in a `<!-- solopdf:anchor ... -->` HTML comment
 *
 * Triple anchoring (resolution priority):
 *   text fingerprint (pre/post context)  >  page + quads
 *
 *   fingerprint hit on stored page  -> relocate by fingerprint
 *   fingerprint miss everywhere     -> orphan (grey in sidebar, body kept)
 */

/** One rectangle in PDF user space (origin bottom-left, y-up), per visual line. */
export interface Quad {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface AnchorData {
  /** 1-based page number */
  page: number
  /** rects in PDF user space, one per visual selection line */
  quads: Quad[]
  /** up to 32 chars of text before the selection (empty if privacy-stripped) */
  pre: string
  /** up to 32 chars after */
  post: string
  /** the selected text itself (empty if privacy-stripped) */
  text?: string
}

export interface Annotation {
  /** stable short id, e.g. "a1b2c3" */
  id: string
  anchor: AnchorData
  /** highlighted excerpt shown as `> quote` (may be '' when privacy-stripped) */
  excerpt: string
  /** user's note body, freely editable in SoloMD */
  note: string
  /** highlight color name */
  color: string
  /** ISO timestamp */
  createdAt: string
  /** true when the anchor comment was lost/corrupt — plain note, no jump link */
  orphan?: boolean
}

export interface SidecarMeta {
  version: 1
  /** sha256 of the PDF at annotation time — reference metadata ONLY, never a file key */
  pdfSha256?: string
  /** display name of the PDF */
  pdfName: string
}

export interface Sidecar {
  meta: SidecarMeta
  annotations: Annotation[]
}

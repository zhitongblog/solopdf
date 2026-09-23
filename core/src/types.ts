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
  /**
   * Geometry of a drawn mark (ink / shape / text box), PDF user space.
   * Lives INSIDE the anchor JSON on purpose: an older SoloPDF that doesn't
   * know these kinds still round-trips the anchor object verbatim when it
   * rewrites the section (e.g. after a note edit), so the strokes survive.
   */
  draw?: DrawData
}

/**
 * Drawn-mark geometry. quads[0] of the anchor always holds the mark's
 * bounding box as well, so an app version without drawing support still
 * resolves, lists, jumps to and exports (as a box) the mark.
 */
export interface DrawData {
  /** stroke width in PDF points (ink: base width before pressure) */
  width: number
  /** ink: strokes, each a flat [x0, y0, x1, y1, …] list of smoothed-curve
   *  control points (the curve is a Catmull-Rom spline through them) */
  strokes?: number[][]
  /** ink: per-point width factors (stylus pressure), parallel to `strokes`
   *  (one factor per point); absent when every stroke is uniform */
  pressure?: number[][]
  /** line/arrow: start → end, [x1, y1, x2, y2] */
  line?: [number, number, number, number]
  /** text box: font size in points */
  fontSize?: number
  /** text box: the page's total on-screen rotation when it was written
   *  (0/90/180/270). The text runs along that screen's x axis, so a note
   *  typed on a sideways scan stays readable with the scan; absent = 0. */
  rotate?: number
}

/**
 * Mark kind. Absent in v1 sidecars → 'highlight', so old files keep working
 * byte-for-byte (the kind is only written when it is not the default).
 *
 *   highlight/underline/strike/squiggly — text marks, quads per visual line
 *   note   — a pin at a point; anchor.quads holds one degenerate quad
 *   region — a rectangular screenshot; anchor.quads holds the rect, and
 *            `image` names a file inside the sidecar's assets folder
 *   ink / rect / ellipse / line / arrow — drawn on the page; geometry in
 *            anchor.draw, a rendered PNG in `image` (Markdown can't show a
 *            stroke, but it can show a picture of one)
 *   textbox — free text placed on the page; the note body IS the text
 */
export type AnnotationKind =
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'squiggly'
  | 'note'
  | 'region'
  | 'ink'
  | 'textbox'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'

/** kinds drawn on the page rather than anchored to text (see DrawData) */
export const DRAWN_KINDS: readonly AnnotationKind[] = ['ink', 'textbox', 'rect', 'ellipse', 'line', 'arrow']
export const SHAPE_KINDS: readonly AnnotationKind[] = ['rect', 'ellipse', 'line', 'arrow']

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
  /** mark kind; undefined means 'highlight' (v1 compatibility) */
  kind?: AnnotationKind
  /** region/drawn marks: image file name relative to the assets folder */
  image?: string
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

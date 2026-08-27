/**
 * Page geometry: PDF user space ⇄ viewport pixels, with rotation and crop.
 *
 * Everything the viewer stores on disk (annotation quads) lives in TRUE PDF
 * user space — origin at the MediaBox corner, y-up, unrotated. Everything the
 * DOM needs is viewport space — origin top-left of the *rotated* page, y-down.
 * These helpers are the only place the two meet.
 *
 * The rotation formulas mirror pdf.js's PageViewport transform exactly
 * (derived from its rotateA/B/C/D matrix), so a quad converted here lands on
 * the same pixel pdf.js paints the glyph on:
 *
 *   R=0    (u, H−v)      viewport size (W, H)
 *   R=90   (v, u)                      (H, W)
 *   R=180  (W−u, v)                    (W, H)
 *   R=270  (H−v, W−u)                  (H, W)
 *
 * where u = x − x0, v = y − y0 are page-box-relative PDF coordinates.
 *
 * Crop is a *display-only* trim expressed as fractions of the rotated page.
 * It never touches stored coordinates: the page element clips, and an inner
 * element holding the canvas/text/highlight layers is offset negatively. So
 * all layer coordinates stay full-page and crop stays a pure CSS concern.
 */

/** The page's MediaBox/CropBox origin + size and its intrinsic /Rotate. */
export interface PageBox {
  x0: number
  y0: number
  /** unrotated width in PDF units */
  w: number
  /** unrotated height in PDF units */
  h: number
  /** intrinsic page rotation (0/90/180/270) */
  rotate: number
}

/** Display-only margin trim, fractions (0–0.45) of the ROTATED page. */
export interface CropRect {
  l: number
  t: number
  r: number
  b: number
}

export const NO_CROP: CropRect = { l: 0, t: 0, r: 0, b: 0 }

export function normRotation(deg: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360
  return r as 0 | 90 | 180 | 270
}

/** Size of the page after rotation, at scale 1. */
export function rotatedSize(box: PageBox, rotation: number): { w: number; h: number } {
  return normRotation(rotation) % 180 ? { w: box.h, h: box.w } : { w: box.w, h: box.h }
}

/** Size actually shown after rotation AND crop, at scale 1. */
export function displaySize(box: PageBox, rotation: number, crop: CropRect): { w: number; h: number } {
  const r = rotatedSize(box, rotation)
  return {
    w: Math.max(1, r.w * (1 - crop.l - crop.r)),
    h: Math.max(1, r.h * (1 - crop.t - crop.b)),
  }
}

/** Pixel offset of the crop window inside the full rotated page, at `scale`. */
export function cropOffset(box: PageBox, rotation: number, crop: CropRect, scale: number): { x: number; y: number } {
  const r = rotatedSize(box, rotation)
  return { x: r.w * crop.l * scale, y: r.h * crop.t * scale }
}

/** PDF user-space point → viewport point (top-left origin of rotated page). */
export function pdfToView(
  x: number,
  y: number,
  box: PageBox,
  rotation: number,
  scale = 1,
): { x: number; y: number } {
  const u = x - box.x0
  const v = y - box.y0
  const { w: W, h: H } = box
  switch (normRotation(rotation)) {
    case 90: return { x: v * scale, y: u * scale }
    case 180: return { x: (W - u) * scale, y: v * scale }
    case 270: return { x: (H - v) * scale, y: (W - u) * scale }
    default: return { x: u * scale, y: (H - v) * scale }
  }
}

/** Viewport point (rotated page, top-left origin) → PDF user space. */
export function viewToPdf(
  vx: number,
  vy: number,
  box: PageBox,
  rotation: number,
  scale = 1,
): { x: number; y: number } {
  const px = vx / scale
  const py = vy / scale
  const { w: W, h: H } = box
  let u: number
  let v: number
  switch (normRotation(rotation)) {
    case 90: v = px; u = py; break
    case 180: u = W - px; v = py; break
    case 270: v = H - px; u = W - py; break
    default: u = px; v = H - py; break
  }
  return { x: u + box.x0, y: v + box.y0 }
}

/** PDF-space rect → viewport rect (left/top/width/height), rotation-aware. */
export function pdfRectToView(
  q: { x1: number; y1: number; x2: number; y2: number },
  box: PageBox,
  rotation: number,
  scale = 1,
): { left: number; top: number; width: number; height: number } {
  const a = pdfToView(q.x1, q.y1, box, rotation, scale)
  const b = pdfToView(q.x2, q.y2, box, rotation, scale)
  const left = Math.min(a.x, b.x)
  const top = Math.min(a.y, b.y)
  return { left, top, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
}

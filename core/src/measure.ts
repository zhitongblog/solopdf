/**
 * PDF Measurement Tools — Scale Calibration, Distance, Perimeter & Polygon Area
 *
 * Coordinates (`Point2D`) are normalized `0..1` relative to the page's physical
 * PDF dimensions (`pageWidthPt`, `pageHeightPt` in 1/72-inch PDF points).
 */

export type MeasureUnit = 'pt' | 'mm' | 'cm' | 'm' | 'km' | 'in' | 'ft'

export interface MeasureScale {
  unit: MeasureUnit
  unitsPerPoint: number
  label: string
}

export interface Point2D {
  x: number
  y: number
}

export interface LinearMeasurement {
  points: number
  value: number
  unit: MeasureUnit
  formatted: string
}

export interface AreaMeasurement {
  pointsSq: number
  value: number
  unit: string
  formatted: string
}

const UNITS_PER_PT: Record<MeasureUnit, number> = {
  pt: 1,
  in: 1 / 72,
  ft: 1 / (72 * 12),
  mm: 25.4 / 72,
  cm: 2.54 / 72,
  m: 0.0254 / 72,
  km: 0.0000254 / 72,
}

/**
 * Format a numeric measurement and its unit (e.g. `12.35 mm`, `100 cm²`).
 */
export function formatMeasurement(value: number, unit: string): string {
  if (!Number.isFinite(value)) return `0 ${unit}`
  const rounded = Math.round(value * 100) / 100
  const numStr = rounded.toFixed(2).replace(/\.?0+$/, '')
  return `${numStr} ${unit}`
}

/**
 * Return the default uncalibrated 1:1 physical scale for the given unit (defaults to `'mm'`).
 * 1 PDF point = 1/72 inch = 25.4/72 mm (~0.3527778 mm).
 */
export function defaultMeasureScale(unit: MeasureUnit = 'mm'): MeasureScale {
  const unitsPerPoint = UNITS_PER_PT[unit] ?? UNITS_PER_PT.mm
  return {
    unit,
    unitsPerPoint,
    label: `1:1 (${unit})`,
  }
}

function distanceInPoints(
  p1: Point2D,
  p2: Point2D,
  pageWidthPt: number,
  pageHeightPt: number,
): number {
  const dx = (p2.x - p1.x) * pageWidthPt
  const dy = (p2.y - p1.y) * pageHeightPt
  return Math.hypot(dx, dy)
}

/**
 * Calibrate a custom drawing scale from two normalized points on a page and a known real-world distance.
 */
export function calibrateMeasureScale(
  p1: Point2D,
  p2: Point2D,
  pageWidthPt: number,
  pageHeightPt: number,
  realDistance: number,
  unit: MeasureUnit,
): MeasureScale {
  const distPt = distanceInPoints(p1, p2, pageWidthPt, pageHeightPt)
  if (distPt <= 1e-9 || !Number.isFinite(realDistance) || realDistance <= 0) {
    return defaultMeasureScale(unit)
  }
  const unitsPerPoint = realDistance / distPt
  return {
    unit,
    unitsPerPoint,
    label: `${formatMeasurement(realDistance, unit)} / ${distPt.toFixed(1)} pt`,
  }
}

/**
 * Measure Euclidean distance between two normalized points on a PDF page.
 */
export function measureDistance(
  p1: Point2D,
  p2: Point2D,
  pageWidthPt: number,
  pageHeightPt: number,
  scale?: MeasureScale,
): LinearMeasurement {
  const s = scale ?? defaultMeasureScale('mm')
  const points = distanceInPoints(p1, p2, pageWidthPt, pageHeightPt)
  const value = points * s.unitsPerPoint
  return {
    points,
    value,
    unit: s.unit,
    formatted: formatMeasurement(value, s.unit),
  }
}

/**
 * Measure polyline or closed polygon perimeter across a sequence of normalized points.
 */
export function measurePerimeter(
  pts: Point2D[],
  pageWidthPt: number,
  pageHeightPt: number,
  scale?: MeasureScale,
  closed = false,
): LinearMeasurement {
  const s = scale ?? defaultMeasureScale('mm')
  if (pts.length < 2) {
    return {
      points: 0,
      value: 0,
      unit: s.unit,
      formatted: formatMeasurement(0, s.unit),
    }
  }

  let points = 0
  for (let i = 0; i < pts.length - 1; i++) {
    points += distanceInPoints(pts[i], pts[i + 1], pageWidthPt, pageHeightPt)
  }
  if (closed && pts.length >= 2) {
    points += distanceInPoints(pts[pts.length - 1], pts[0], pageWidthPt, pageHeightPt)
  }

  const value = points * s.unitsPerPoint
  return {
    points,
    value,
    unit: s.unit,
    formatted: formatMeasurement(value, s.unit),
  }
}

/**
 * Measure closed polygon area using the Shoelace formula in physical PDF points squared,
 * converted to `unit²` (e.g. `mm²`, `cm²`, `m²`).
 */
export function measurePolygonArea(
  pts: Point2D[],
  pageWidthPt: number,
  pageHeightPt: number,
  scale?: MeasureScale,
): AreaMeasurement {
  const s = scale ?? defaultMeasureScale('mm')
  const areaUnit = `${s.unit}²`
  if (pts.length < 3) {
    return {
      pointsSq: 0,
      value: 0,
      unit: areaUnit,
      formatted: formatMeasurement(0, areaUnit),
    }
  }

  let twiceSignedArea = 0
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i]
    const next = pts[(i + 1) % pts.length]
    const x1 = cur.x * pageWidthPt
    const y1 = cur.y * pageHeightPt
    const x2 = next.x * pageWidthPt
    const y2 = next.y * pageHeightPt
    twiceSignedArea += x1 * y2 - x2 * y1
  }

  const pointsSq = Math.abs(twiceSignedArea) / 2
  const value = pointsSq * s.unitsPerPoint * s.unitsPerPoint
  return {
    pointsSq,
    value,
    unit: areaUnit,
    formatted: formatMeasurement(value, areaUnit),
  }
}

/**
 * Compute the geometric centroid of a polygon in normalized 0..1 coordinates.
 */
export function polygonCentroid(pts: Point2D[]): Point2D {
  if (pts.length === 0) return { x: 0, y: 0 }
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y }
  if (pts.length === 2) {
    return {
      x: (pts[0].x + pts[1].x) / 2,
      y: (pts[0].y + pts[1].y) / 2,
    }
  }

  let twiceSignedArea = 0
  let cx = 0
  let cy = 0

  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i]
    const p1 = pts[(i + 1) % pts.length]
    const cross = p0.x * p1.y - p1.x * p0.y
    twiceSignedArea += cross
    cx += (p0.x + p1.x) * cross
    cy += (p0.y + p1.y) * cross
  }

  if (Math.abs(twiceSignedArea) < 1e-12) {
    const sumX = pts.reduce((acc, p) => acc + p.x, 0)
    const sumY = pts.reduce((acc, p) => acc + p.y, 0)
    return { x: sumX / pts.length, y: sumY / pts.length }
  }

  const factor = 1 / (3 * twiceSignedArea)
  return {
    x: cx * factor,
    y: cy * factor,
  }
}

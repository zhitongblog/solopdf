/**
 * Region Table Extraction (Markdown / CSV)
 *
 * Extracts structured 2D tables from spatially positioned text items within an
 * optional selection rectangle, clustering rows by Y tolerance and aligning
 * columns across rows (including sparse/empty cells).
 */
import { joinLines } from './reflow.js'

export interface SnipTextItem {
  str: string
  x: number
  y: number
  width: number
  height: number
}

export interface SnipRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ExtractTableOptions {
  /**
   * Coordinate system vertical direction:
   * - `'down'` (default): top-down viewport / normalized coordinates (smaller Y = higher on page)
   * - `'up'`: PDF bottom-up user space coordinates (larger Y = higher on page)
   */
  yDirection?: 'down' | 'up'
}

interface CellFragment {
  text: string
  x: number
  y: number
  width: number
  height: number
}

function median(xs: number[]): number {
  if (!xs.length) return 10
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function overlapsRect(item: SnipTextItem, rect: SnipRect): boolean {
  const iw = Math.max(0, item.width)
  const ih = Math.max(0, item.height)
  const rx2 = rect.x + rect.width
  const ry2 = rect.y + rect.height
  return item.x + iw >= rect.x && item.x <= rx2 && item.y + ih >= rect.y && item.y <= ry2
}

/**
 * Extract a 2D string table (`rows[rowIndex][colIndex]`) from spatial text items.
 */
export function extractTableFromItems(
  items: SnipTextItem[],
  rect?: SnipRect,
  opts: ExtractTableOptions = {},
): string[][] {
  const yDir = opts.yDirection ?? 'down'

  const filtered = items.filter((item) => {
    if (!item.str || !item.str.trim()) return false
    if (rect && !overlapsRect(item, rect)) return false
    return true
  })

  if (!filtered.length) return []

  const medH = median(filtered.map((i) => i.height).filter((h) => h > 0))
  const yTol = medH * 0.45

  // Sort items top-to-bottom according to yDirection, then left-to-right
  const sorted = [...filtered].sort((a, b) => {
    if (Math.abs(a.y - b.y) <= yTol) return a.x - b.x
    return yDir === 'up' ? b.y - a.y : a.y - b.y
  })

  // Group into visual rows
  const rawRows: SnipTextItem[][] = []
  for (const item of sorted) {
    const lastRow = rawRows[rawRows.length - 1]
    if (!lastRow) {
      rawRows.push([item])
      continue
    }
    const rowAvgY = lastRow.reduce((acc, cur) => acc + cur.y, 0) / lastRow.length
    if (Math.abs(item.y - rowAvgY) <= yTol) {
      lastRow.push(item)
    } else {
      rawRows.push([item])
    }
  }

  // Within each row, sort by X and merge fragments that are tightly adjacent (same cell words)
  const rowCells: CellFragment[][] = rawRows.map((row) => {
    row.sort((a, b) => a.x - b.x)
    const merged: CellFragment[] = []
    for (const item of row) {
      const text = item.str.trim()
      const prev = merged[merged.length - 1]
      // Merge only when gap is very small (< 0.55 * medH), representing space within a single phrase
      if (prev && item.x - (prev.x + prev.width) <= medH * 0.55) {
        prev.text = joinLines(prev.text, text)
        prev.width = Math.max(prev.x + prev.width, item.x + item.width) - prev.x
        prev.height = Math.max(prev.height, item.height)
      } else {
        merged.push({
          text,
          x: item.x,
          y: item.y,
          width: Math.max(item.width, medH * 0.5),
          height: item.height || medH,
        })
      }
    }
    return merged
  })

  // Collect all cell fragments tagged with their row index to cluster columns
  const taggedCells: Array<{ rowIdx: number; cell: CellFragment }> = []
  rowCells.forEach((cells, rowIdx) => {
    for (const cell of cells) {
      taggedCells.push({ rowIdx, cell })
    }
  })

  taggedCells.sort((a, b) => a.cell.x - b.cell.x)

  interface ColCluster {
    minX: number
    maxX: number
    anchorX: number
    rows: Set<number>
    xs: number[]
  }

  const colClusters: ColCluster[] = []
  const colTol = medH * 1.5

  for (const { rowIdx, cell } of taggedCells) {
    const cx1 = cell.x
    const cx2 = cell.x + cell.width

    // Find best matching existing column cluster that does not already have a cell from this row
    let matchedCluster: ColCluster | null = null
    for (const cluster of colClusters) {
      if (cluster.rows.has(rowIdx)) continue
      const horizOverlap = Math.min(cluster.maxX, cx2) - Math.max(cluster.minX, cx1)
      const startDiff = Math.abs(cx1 - cluster.anchorX)
      if (horizOverlap > 0 || startDiff <= colTol) {
        matchedCluster = cluster
        break
      }
    }

    if (matchedCluster) {
      matchedCluster.minX = Math.min(matchedCluster.minX, cx1)
      matchedCluster.maxX = Math.max(matchedCluster.maxX, cx2)
      matchedCluster.xs.push(cx1)
      matchedCluster.anchorX =
        matchedCluster.xs.reduce((acc, v) => acc + v, 0) / matchedCluster.xs.length
      matchedCluster.rows.add(rowIdx)
    } else {
      colClusters.push({
        minX: cx1,
        maxX: cx2,
        anchorX: cx1,
        rows: new Set([rowIdx]),
        xs: [cx1],
      })
    }
  }

  // Sort columns left-to-right
  colClusters.sort((a, b) => a.anchorX - b.anchorX)
  const numCols = colClusters.length
  if (numCols === 0) return []

  // Assign each row's cells into the aligned column slots
  const matrix: string[][] = rowCells.map((cells) => {
    const rowOut = new Array<string>(numCols).fill('')
    for (const cell of cells) {
      let bestCol = 0
      let bestScore = Infinity
      for (let c = 0; c < numCols; c++) {
        const cl = colClusters[c]
        const dist = Math.abs(cell.x - cl.anchorX)
        if (dist < bestScore) {
          bestScore = dist
          bestCol = c
        }
      }
      rowOut[bestCol] = rowOut[bestCol] ? joinLines(rowOut[bestCol], cell.text) : cell.text
    }
    return rowOut
  })

  return matrix
}

function escapeMarkdownCell(cell: string): string {
  return cell.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/**
 * Format a 2D table array as a GitHub-Flavored Markdown table.
 */
export function tableToMarkdown(rows: string[][]): string {
  if (!rows.length) return ''
  const colCount = Math.max(...rows.map((r) => r.length), 0)
  if (colCount === 0) return ''

  const lines: string[] = []
  rows.forEach((row, idx) => {
    const cells: string[] = []
    for (let c = 0; c < colCount; c++) {
      cells.push(escapeMarkdownCell(row[c] ?? ''))
    }
    lines.push(`| ${cells.join(' | ')} |`)
    if (idx === 0) {
      lines.push(`| ${new Array(colCount).fill('---').join(' | ')} |`)
    }
  })

  return lines.join('\n')
}

function escapeCsvCell(cell: string): string {
  const val = cell ?? ''
  if (/[",\r\n]/.test(val) || /^\s|\s$/.test(val)) {
    return `"${val.replace(/"/g, '""')}"`
  }
  return val
}

/**
 * Format a 2D table array as RFC 4180 CSV.
 */
export function tableToCsv(rows: string[][]): string {
  if (!rows.length) return ''
  const colCount = Math.max(...rows.map((r) => r.length), 0)
  if (colCount === 0) return ''

  return rows
    .map((row) => {
      const cells: string[] = []
      for (let c = 0; c < colCount; c++) {
        cells.push(escapeCsvCell(row[c] ?? ''))
      }
      return cells.join(',')
    })
    .join('\n')
}

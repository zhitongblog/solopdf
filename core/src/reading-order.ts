/**
 * OCR 阅读顺序:把识别出的文本行排成人类阅读顺序。
 *
 * 单栏文档:自上而下(同一行内自左而右)。
 * 多栏文档(论文/杂志):先检测竖直"栏沟"(gutter),把页面切成列;
 * 跨栏的行(大标题、页眉)作为分隔符把页面切成上下几段(band),
 * 每段内部按 列→列内自上而下 输出。
 *
 * 输入坐标为归一化 [0,1]、左上原点(与 OCR 引擎输出一致)。
 * app 与 CLI 共用这一实现(单引擎规则)。
 */

export interface OcrBox {
  /** text */
  t: string
  x: number
  y: number
  w: number
  h: number
}

const BINS = 100
/** 栏沟最小宽度(页面宽度比例) */
const MIN_GUTTER = 0.02
/** 每列至少要有的行数比例,防止把右侧孤立页码当成一列 */
const MIN_COL_LINES = 3
/** 跨越栏沟且宽度超过此比例的行视为"跨栏行"(标题/页眉) */
const SPAN_WIDTH = 0.55

function byYThenX<T extends OcrBox>(a: T, b: T): number {
  // 垂直重叠超过一半视作同一行 → 按 x
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (overlap > 0.5 * Math.min(a.h, b.h)) return a.x - b.x
  return a.y - b.y
}

/** 找栏沟:x 覆盖直方图中,页面中部"几乎为空"的区间。
 *  超宽行(候选跨栏标题)不参与统计;另外容忍少量横穿线
 *  (标题不够宽、图注等),否则一两条线就把沟填平了。 */
function findGutters(lines: OcrBox[]): Array<{ start: number; end: number }> {
  const hist = new Array(BINS).fill(0)
  let counted = 0
  for (const l of lines) {
    if (l.w >= SPAN_WIDTH) continue
    counted++
    const from = Math.max(0, Math.floor(l.x * BINS))
    const to = Math.min(BINS - 1, Math.ceil((l.x + l.w) * BINS))
    for (let i = from; i <= to; i++) hist[i]++
  }
  const tolerance = Math.max(1, Math.floor(counted * 0.12))
  const gutters: Array<{ start: number; end: number }> = []
  let runStart = -1
  for (let i = 0; i <= BINS; i++) {
    const empty = i < BINS && hist[i] <= tolerance
    if (empty && runStart < 0) runStart = i
    if (!empty && runStart >= 0) {
      const s = runStart / BINS
      const e = i / BINS
      // 只认页面中部的沟(排除左右页边距)
      if (e - s >= MIN_GUTTER && s > 0.15 && e < 0.85) gutters.push({ start: s, end: e })
      runStart = -1
    }
  }
  return gutters
}

/** 把行排成阅读顺序;lines 不会被原地修改 */
export function orderLinesForReading<T extends OcrBox>(lines: T[]): T[] {
  const items = lines.filter((l) => l.t.trim().length > 0)
  if (items.length < 6) return [...items].sort(byYThenX)

  const gutters = findGutters(items)
  if (!gutters.length) return [...items].sort(byYThenX)

  // 分列边界 = 沟中心;跨栏行单独拿出来当 band 分隔符
  const cuts = gutters.map((g) => (g.start + g.end) / 2)
  const spanning: T[] = []
  const columnar: T[] = []
  for (const l of items) {
    // 跨栏行:两侧都明显越过沟中心(居中的标题即使不够宽也算)
    const spans = cuts.some((c) => l.x < c - 0.04 && l.x + l.w > c + 0.04)
    if (spans) spanning.push(l)
    else columnar.push(l)
  }

  // 每列行数太少 → 判定失败,退回单栏
  const colOf = (l: OcrBox): number => {
    const cx = l.x + l.w / 2
    let col = 0
    for (const c of cuts) if (cx > c) col++
    return col
  }
  const counts = new Array(cuts.length + 1).fill(0)
  for (const l of columnar) counts[colOf(l)]++
  if (counts.some((n) => n < MIN_COL_LINES)) return [...items].sort(byYThenX)

  // 跨栏行把页面切成上下 band,band 内按列输出
  spanning.sort(byYThenX)
  const bounds = [0, ...spanning.map((s) => s.y + s.h / 2), 1.000001]
  const out: T[] = []
  for (let b = 0; b < bounds.length - 1; b++) {
    if (b > 0) out.push(spanning[b - 1])
    const band = columnar.filter((l) => {
      const cy = l.y + l.h / 2
      return cy >= bounds[b] && cy < bounds[b + 1]
    })
    for (let col = 0; col <= cuts.length; col++) {
      out.push(...band.filter((l) => colOf(l) === col).sort(byYThenX))
    }
  }
  return out
}

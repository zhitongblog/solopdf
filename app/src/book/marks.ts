/**
 * 在已渲染的图书内容里内联标记高亮:跨文本节点搜索批注摘录,命中后用
 * Range.surroundContents 不可行(跨节点),改为逐节点切割包裹 <mark>。
 * PDF 块与 EPUB 章节共用;匹配在"去空白"空间进行,容忍重排差异。
 */
import type { Annotation } from '@solopdf/core'

interface FlatNode {
  node: Text
  /** 该节点在压缩文本里的起始偏移 */
  start: number
  /** 压缩后文本 */
  flat: string
  /** 压缩偏移 → 节点内原始偏移 */
  map: number[]
}

function flatten(root: HTMLElement): { flat: string; nodes: FlatNode[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n.parentElement?.closest('mark') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  let flat = ''
  const nodes: FlatNode[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n as Text).data
    let f = ''
    const map: number[] = []
    for (let i = 0; i < text.length; i++) {
      if (!/\s/.test(text[i])) {
        f += text[i]
        map.push(i)
      }
    }
    if (f) {
      nodes.push({ node: n as Text, start: flat.length, flat: f, map })
      flat += f
    }
  }
  return { flat, nodes }
}

/** 把 [from, to)(压缩坐标)范围包进 mark */
function wrapRange(nodes: FlatNode[], from: number, to: number, cls: string, id: string): void {
  // 倒序处理,避免前面的切割使后面的偏移失效
  const touched = nodes.filter((fn) => fn.start < to && fn.start + fn.flat.length > from)
  for (const fn of touched.reverse()) {
    const s = Math.max(from - fn.start, 0)
    const e = Math.min(to - fn.start, fn.flat.length)
    const rawS = fn.map[s]
    const rawE = fn.map[e - 1] + 1
    const target = fn.node.splitText(rawS)
    target.splitText(rawE - rawS)
    const mark = document.createElement('mark')
    mark.className = cls
    mark.dataset.annot = id
    target.parentNode?.replaceChild(mark, target)
    mark.appendChild(target)
  }
}

/** 对 root 内的内容套用批注标记(只处理给定页/章的批注) */
export function applyMarks(root: HTMLElement, annots: Annotation[]): void {
  const candidates = annots.filter((a) => !a.orphan && a.excerpt && a.excerpt.length >= 2)
  if (!candidates.length) return
  const { flat, nodes } = flatten(root)
  if (!flat) return
  for (const a of candidates) {
    if (root.querySelector(`mark[data-annot="${a.id}"]`)) continue
    const needle = a.excerpt!.replace(/…$/, '').replace(/\s+/g, '')
    if (needle.length < 2) continue
    const at = flat.indexOf(needle)
    if (at < 0) continue
    wrapRange(nodes, at, at + needle.length, `bk-hl bk-hl-${a.color}`, a.id)
  }
}

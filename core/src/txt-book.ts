/**
 * TXT → 图书流:纯文本(网文/小说/笔记)转 ReflowBlock 序列。
 *
 * 章节检测(标题行独占一行,趋势匹配):
 *   第X章/节/回/卷/部/篇(中文数字或阿拉伯数字,可带标题)
 *   Chapter N / 卷N / 番外 / 序章 / 楔子 / 尾声 / 后记
 * 命中的行成为 heading 并进目录;block.page = 章序(1-based,无章节时全文为第 1 章)。
 * 段落:空行分段;无空行的紧凑排版按行首缩进/单行成段。
 */
import { joinLines, type ReflowBlock } from './reflow.js'

export interface TxtToc {
  title: string
  /** 章序(对应 block.page) */
  chapter: number
  depth: number
}

export interface TxtBook {
  blocks: ReflowBlock[]
  toc: TxtToc[]
}

const CHAPTER_RES = [
  /^\s*(第\s*[0-9一二三四五六七八九十百千万零两〇]+\s*[章节回卷部篇集](?:\s+\S.{0,40})?)\s*$/,
  /^\s*((?:序章|序言|楔子|引子|前言|尾声|后记|番外|終章|终章|附录)(?:\s+\S.{0,30})?)\s*$/,
  /^\s*(Chapter\s+[0-9IVXLC]+(?:[.:．:]?\s+\S.{0,50})?)\s*$/i,
  /^\s*(卷[0-9一二三四五六七八九十]+(?:\s+\S.{0,30})?)\s*$/,
]

function isChapterLine(line: string): string | null {
  if (line.length > 60) return null
  for (const re of CHAPTER_RES) {
    const m = line.match(re)
    if (m) return m[1].trim()
  }
  return null
}

/** 归一化换行 + 去 BOM */
function normalize(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

export function txtToBlocks(raw: string): TxtBook {
  const text = normalize(raw)
  const lines = text.split('\n')
  const blocks: ReflowBlock[] = []
  const toc: TxtToc[] = []
  let chapter = 0
  let para: string[] = []
  let seq = 0 // 章内块序,用于 yTop 的相对定位(粗略回跳)

  const flush = () => {
    const t = para.join('').trim()
    if (t) {
      blocks.push({ type: 'para', text: t, page: Math.max(chapter, 1), yTop: Math.min(seq * 0.01, 0.99) })
      seq++
    }
    para = []
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (!trimmed) {
      flush()
      continue
    }
    const title = isChapterLine(trimmed)
    if (title) {
      flush()
      chapter++
      seq = 0
      blocks.push({ type: 'heading', level: 2, text: title, page: chapter, yTop: 0 })
      toc.push({ title, chapter, depth: 0 })
      seq++
      continue
    }
    // 缩进的行视为新段落开头(常见中文排版:全角空格缩进、无空行)
    if (para.length && /^[　 \t]{1,}/.test(rawLine) && /^[　\t]|^ {2,}/.test(rawLine)) flush()
    para = [para.length ? joinLines(para[0], trimmed) : trimmed]
  }
  flush()

  // 全文无章节 → 单章
  if (!toc.length && blocks.length) {
    for (const b of blocks) b.page = 1
  }
  return { blocks, toc }
}

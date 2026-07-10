import { describe, it, expect } from 'vitest'
import { txtToBlocks } from '../src/txt-book.js'

describe('txtToBlocks', () => {
  it('detects Chinese chapter headings and builds toc', () => {
    const txt = `第一章 风起\n\n　　夜色深沉,城门紧闭。\n　　更夫敲过三更。\n\n第二章 云涌\n\n　　次日清晨。`
    const { blocks, toc } = txtToBlocks(txt)
    expect(toc).toHaveLength(2)
    expect(toc[0]).toMatchObject({ title: '第一章 风起', chapter: 1 })
    expect(blocks[0]).toMatchObject({ type: 'heading', page: 1 })
    const ch2 = blocks.filter((b) => b.page === 2)
    expect(ch2[0].text).toBe('第二章 云涌')
    expect(ch2[1].text).toContain('次日清晨')
  })

  it('splits paragraphs on blank lines and full-width indents', () => {
    const txt = `　　第一段第一行,\n继续第一段。\n　　第二段开始。`
    const { blocks } = txtToBlocks(txt)
    expect(blocks.map((b) => b.text)).toEqual(['第一段第一行,继续第一段。', '第二段开始。'])
  })

  it('joins latin lines with a space', () => {
    const txt = `Hello world,\nthis is line two.`
    const { blocks } = txtToBlocks(txt)
    expect(blocks[0].text).toBe('Hello world, this is line two.')
  })

  it('supports Chapter N / 序章 / 番外 styles', () => {
    const txt = `序章\n\ntext a\n\nChapter 12: The End\n\ntext b\n\n番外 甲\n\ntext c`
    const { toc } = txtToBlocks(txt)
    expect(toc.map((t) => t.chapter)).toEqual([1, 2, 3])
  })

  it('no chapters → single implicit chapter', () => {
    const { blocks, toc } = txtToBlocks('只有一段普通文字。\n\n第二段。')
    expect(toc).toHaveLength(0)
    expect(blocks.every((b) => b.page === 1)).toBe(true)
  })

  it('does not mistake long prose containing 第x章 for a heading', () => {
    const txt = '他说第三章的内容其实是伏笔,这句话很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长。'
    const { toc } = txtToBlocks(txt)
    expect(toc).toHaveLength(0)
  })

  it('strips BOM and handles CRLF', () => {
    const { blocks } = txtToBlocks('﻿第一章 测试\r\n\r\n正文。\r\n')
    expect(blocks[0].text).toBe('第一章 测试')
    expect(blocks[1].text).toBe('正文。')
  })
})

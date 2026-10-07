import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  parseFb2, detectXmlEncoding, decodeFb2Text, parseXml, htmlToText, pickFb2Entry, isZipBytes,
  base64ToBytes,
} from '../src/fb2.js'

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test-fixtures')

const wrap = (body: string, extra = ''): string =>
  `<?xml version="1.0" encoding="UTF-8"?><FictionBook xmlns:l="http://www.w3.org/1999/xlink">` +
  `<description><title-info><book-title>T</book-title></title-info></description>${body}${extra}</FictionBook>`

describe('encoding detection', () => {
  it('reads the XML declaration', () => {
    const b = new TextEncoder().encode('<?xml version="1.0" encoding="windows-1251"?><a/>')
    expect(detectXmlEncoding(b)).toBe('windows-1251')
    const c = new TextEncoder().encode("<?xml version='1.0' encoding='CP1251'?><a/>")
    expect(detectXmlEncoding(c)).toBe('windows-1251')
  })

  it('honours BOMs', () => {
    expect(detectXmlEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c]))).toBe('utf-8')
    expect(detectXmlEncoding(new Uint8Array([0xff, 0xfe, 0x3c, 0]))).toBe('utf-16le')
  })

  it('falls back to windows-1251 when a "UTF-8" file is not', () => {
    // "Привет" in cp1251, wrapped in a declaration claiming UTF-8
    const head = new TextEncoder().encode('<?xml version="1.0" encoding="utf-8"?><p>')
    const ru = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])
    const tail = new TextEncoder().encode('</p>')
    const all = new Uint8Array([...head, ...ru, ...tail])
    const { text, encoding } = decodeFb2Text(all)
    expect(encoding).toBe('windows-1251')
    expect(text).toContain('Привет')
  })
})

describe('parseXml', () => {
  it('handles entities, CDATA, comments, namespaces and self-closing tags', () => {
    const root = parseXml('<?xml version="1.0"?><!-- c --><x:a b="1 &amp; 2"><b>&lt;&#1046;&#x416;&nbsp;</b><![CDATA[<raw>]]><c/></x:a>')
    const a = root.children[0] as any
    expect(a.name).toBe('a')
    expect(a.attrs.b).toBe('1 & 2')
    expect(a.children[0].children[0]).toBe('<ЖЖ ')
    expect(a.children[1]).toBe('<raw>')
    expect(a.children[2].name).toBe('c')
  })

  it('survives a stray end tag', () => {
    const root = parseXml('<a><b>x</c></b><d/></a>')
    const a = root.children[0] as any
    expect(a.children.map((c: any) => c.name)).toEqual(['b', 'd'])
  })
})

describe('parseFb2', () => {
  it('turns nested sections into chapters and a TOC', () => {
    const book = parseFb2(wrap(`<body>
      <section><title><p>Part 1</p></title><p>lead</p>
        <section><title><p>Ch 1</p></title><p>one</p></section>
        <section><title><p>Ch 2</p></title><p>two</p></section>
      </section>
      <section><title><p>Part 2</p></title><p>three</p></section>
    </body>`))
    expect(book.chapters.map((c) => c.text)).toEqual(['Part 1\nlead', 'Ch 1\none', 'Ch 2\ntwo', 'Part 2\nthree'])
    expect(book.toc).toEqual([
      { title: 'Part 1', chapter: 1, depth: 0 },
      { title: 'Ch 1', chapter: 2, depth: 1 },
      { title: 'Ch 2', chapter: 3, depth: 1 },
      { title: 'Part 2', chapter: 4, depth: 0 },
    ])
  })

  it('a part with only a title points at its first sub-chapter', () => {
    const book = parseFb2(wrap(`<body><section><title><p>Part</p></title>
      <section><title><p>A</p></title><p>a</p></section></section></body>`))
    // the part title still renders (its own tiny chapter), TOC targets it
    expect(book.toc[0]).toEqual({ title: 'Part', chapter: 1, depth: 0 })
    expect(book.toc[1]).toEqual({ title: 'A', chapter: 2, depth: 1 })
  })

  it('renders inline markup, images and tables from a whitelist only', () => {
    const book = parseFb2(wrap(
      `<body><section><p>a <emphasis>b</emphasis> <strong>c</strong><a l:href="#n1" type="note">[1]</a></p>
        <p onclick="evil()"><script>alert(1)</script>x</p>
        <image l:href="#pic.png"/>
        <table><tr><th>h</th></tr><tr><td>d</td></tr></table></section></body>`,
      '<binary id="pic.png" content-type="image/png">iVBO\nRw==</binary>',
    ))
    const html = book.chapters[0].html
    expect(html).toContain('<em>b</em>')
    expect(html).toContain('<strong>c</strong>')
    expect(html).toContain('<sup>[1]</sup>')
    expect(html).toContain('<img data-fb2-src="pic.png"')
    expect(html).toContain('<table><tr><th>h</th></tr><tr><td>d</td></tr></table>')
    expect(html).not.toMatch(/script|onclick/)
    expect(html).toContain('alert(1)x') // the text survives as text
    expect(book.binaries.get('pic.png')).toEqual({ contentType: 'image/png', base64: 'iVBORw==' })
  })

  it('keeps a notes body as one chapter', () => {
    const book = parseFb2(wrap(`<body><section><p>main</p></section></body>
      <body name="notes"><title><p>Notes</p></title>
      <section id="n1"><title><p>1</p></title><p>first</p></section>
      <section id="n2"><title><p>2</p></title><p>second</p></section></body>`))
    expect(book.chapters).toHaveLength(2)
    expect(book.chapters[1].text).toContain('first')
    expect(book.chapters[1].text).toContain('second')
    expect(book.toc.at(-1)).toEqual({ title: 'Notes', chapter: 2, depth: 0 })
  })

  it('rejects non-FB2 XML', () => {
    expect(() => parseFb2('<?xml version="1.0"?><html><p>x</p></html>')).toThrow('fb2Bad')
  })

  it('reads the windows-1251 fixture: metadata, TOC, cyrillic, images', () => {
    const book = parseFb2(new Uint8Array(readFileSync(path.join(FIX, 'fb2-cyrillic-1251.fb2'))))
    expect(book.encoding).toBe('windows-1251')
    expect(book.title).toBe('Пробная книга: стихи и проза')
    expect(book.authors).toEqual(['Александр Сергеевич Пушкин'])
    expect(book.lang).toBe('ru')
    expect(book.coverId).toBe('cover.jpg')
    expect(book.toc.map((e) => [e.title, e.depth])).toEqual([
      ['Часть первая. Стихи', 0],
      ['Глава 1. К ***', 1],
      ['Глава 2. Зимнее утро', 1],
      ['Часть вторая. Проза', 0],
      ['Глава 3. Рисунок', 1],
      ['Глава 4. Таблица', 1],
      ['Примечания', 0],
    ])
    const all = book.chapters.map((c) => c.text).join('\n')
    expect(all).toContain('Я помню чудное мгновенье:')
    expect(all).toContain('«ёлочки» и тире — всё')
    expect(all).toContain('ЖУРАВЛЬ')
    expect(all).toContain('Москва\t1147')
    expect(book.chapters.some((c) => c.html.includes('data-fb2-src="figure1.png"'))).toBe(true)
    // the binaries really are the images
    const png = base64ToBytes(book.binaries.get('figure1.png')!.base64)
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG')
    const jpg = base64ToBytes(book.binaries.get('cover.jpg')!.base64)
    expect(jpg[0]).toBe(0xff)
    expect(jpg[1]).toBe(0xd8)
    // every TOC entry points at a chapter that starts with its title
    for (const e of book.toc) expect(book.chapters[e.chapter - 1].text.startsWith(e.title)).toBe(true)
  })

  it('keeps a full-width paragraph indent (it is content in Chinese books)', () => {
    const book = parseFb2(wrap('<body><section><p>\n　　床前明月光。\n</p></section></body>'))
    expect(book.chapters[0].html).toBe('<p>　　床前明月光。</p>')
    expect(book.chapters[0].text).toBe('　　床前明月光。')
  })

  it('recognises the zipped fixture and its member', () => {
    const bytes = new Uint8Array(readFileSync(path.join(FIX, 'fb2-chinese.fbz')))
    expect(isZipBytes(bytes)).toBe(true)
    expect(pickFb2Entry(['__MACOSX/x.fb2', 'img/a.jpg', 'book.fb2'])).toBe('book.fb2')
  })
})

describe('htmlToText', () => {
  it('puts each block on its own line', () => {
    expect(htmlToText('<h2>T</h2><p>a &amp; b</p><p class="fb2-empty"><br></p><p>c</p>')).toBe('T\na & b\nc')
  })
})

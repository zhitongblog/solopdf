/**
 * EPUB 解析(EPUB 2/3):
 *   zip(fflate) → META-INF/container.xml → OPF(manifest/spine/metadata)
 *   → 章节 XHTML 按需净化渲染;目录取 EPUB3 nav,回退 EPUB2 NCX。
 *
 * 渲染策略:排版交给我们的主题(出版商 CSS 一律剥离,阅读器统一观感),
 * 保留结构标签;图片重写为 blob URL;script/iframe/事件属性全部拔除。
 */
import { unzipSync } from 'fflate'

export interface EpubTocEntry {
  title: string
  /** 1-based 章节序(spine 索引 + 1);无法定位时 0 */
  chapter: number
  depth: number
}

export interface EpubChapter {
  /** spine 内 href(解码后) */
  href: string
}

const dec = new TextDecoder()

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i + 1)
}

/** 归一化 zip 内相对路径(处理 ../ 与 ./) */
function resolvePath(base: string, rel: string): string {
  if (rel.startsWith('/')) return rel.slice(1)
  const parts = (base + rel).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p !== '.' && p !== '') out.push(p)
  }
  return out.join('/')
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp',
}

export class EpubBook {
  title = ''
  chapters: EpubChapter[] = []
  toc: EpubTocEntry[] = []
  private files: Record<string, Uint8Array> = {}
  private opfDir = ''
  private blobUrls = new Map<string, string>()
  private htmlCache = new Map<number, string>()

  load(bytes: Uint8Array): void {
    this.files = unzipSync(bytes)
    const container = this.text('META-INF/container.xml')
    const opfPath = new DOMParser()
      .parseFromString(container, 'application/xml')
      .querySelector('rootfile')
      ?.getAttribute('full-path')
    if (!opfPath) throw new Error('EPUB: container.xml 缺 rootfile')
    this.opfDir = dirOf(opfPath)
    const opf = new DOMParser().parseFromString(this.text(opfPath), 'application/xml')

    this.title =
      opf.getElementsByTagName('dc:title')[0]?.textContent?.trim() ||
      opf.querySelector('title')?.textContent?.trim() || ''

    const manifest = new Map<string, { href: string; type: string; props: string }>()
    opf.querySelectorAll('manifest > item').forEach((it) => {
      manifest.set(it.getAttribute('id') ?? '', {
        href: decodeURIComponent(it.getAttribute('href') ?? ''),
        type: it.getAttribute('media-type') ?? '',
        props: it.getAttribute('properties') ?? '',
      })
    })
    opf.querySelectorAll('spine > itemref').forEach((ref) => {
      const item = manifest.get(ref.getAttribute('idref') ?? '')
      if (item && item.type.includes('html')) this.chapters.push({ href: item.href })
    })
    if (!this.chapters.length) throw new Error('EPUB: spine 为空')

    // 目录:EPUB3 nav 优先,退 NCX
    const chapterOf = (href: string): number => {
      const clean = decodeURIComponent(href.split('#')[0])
      const i = this.chapters.findIndex(
        (c) => c.href === clean || resolvePath(this.opfDir, c.href) === resolvePath(this.opfDir, clean),
      )
      return i < 0 ? 0 : i + 1
    }
    const navItem = [...manifest.values()].find((m) => m.props.includes('nav'))
    if (navItem) {
      const navPath = resolvePath(this.opfDir, navItem.href)
      const doc = new DOMParser().parseFromString(this.text(navPath), 'text/html')
      // epub:type 带命名空间,querySelector 不可靠——遍历 nav 找 type=toc,
      // 否则会命中 landmarks 导致目录只剩一条
      const navs = [...doc.querySelectorAll('nav')]
      const nav =
        navs.find((n) => {
          const t0 =
            n.getAttribute('epub:type') ??
            n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ??
            [...n.attributes].find((a) => a.name.endsWith(':type'))?.value
          return t0 === 'toc'
        }) ?? navs[0] ?? null
      const navDir = dirOf(navItem.href)
      const walk = (ol: Element | null, depth: number): void => {
        if (!ol) return
        for (const li of ol.children) {
          if (li.tagName.toLowerCase() !== 'li') continue
          const a = li.querySelector(':scope > a')
          if (a) {
            this.toc.push({
              title: a.textContent?.trim() ?? '',
              chapter: chapterOf(navDir + (a.getAttribute('href') ?? '')),
              depth,
            })
          }
          walk(li.querySelector(':scope > ol'), depth + 1)
        }
      }
      walk(nav?.querySelector('ol') ?? null, 0)
    } else {
      const ncxId = opf.querySelector('spine')?.getAttribute('toc')
      const ncx = ncxId && manifest.get(ncxId)
      if (ncx) {
        const doc = new DOMParser().parseFromString(
          this.text(resolvePath(this.opfDir, ncx.href)), 'application/xml')
        const ncxDir = dirOf(ncx.href)
        const walk = (el: Element, depth: number): void => {
          for (const np of el.children) {
            if (np.tagName !== 'navPoint') continue
            const label = np.querySelector('navLabel > text')?.textContent?.trim() ?? ''
            const src = np.querySelector('content')?.getAttribute('src') ?? ''
            this.toc.push({ title: label, chapter: chapterOf(ncxDir + src), depth })
            walk(np, depth + 1)
          }
        }
        walk(doc.querySelector('navMap') ?? doc.documentElement, 0)
      }
    }
  }

  private text(path: string): string {
    const f = this.files[path]
    if (!f) throw new Error(`EPUB: 缺文件 ${path}`)
    return dec.decode(f)
  }

  private blobUrl(path: string): string | null {
    const hit = this.blobUrls.get(path)
    if (hit) return hit
    const f = this.files[path]
    if (!f) return null
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const url = URL.createObjectURL(new Blob([new Uint8Array(f)], { type: MIME[ext] ?? 'application/octet-stream' }))
    this.blobUrls.set(path, url)
    return url
  }

  /** 章节 → 净化后的 HTML(缓存);chapter 1-based */
  chapterHtml(chapter: number): string {
    const cached = this.htmlCache.get(chapter)
    if (cached !== undefined) return cached
    const ch = this.chapters[chapter - 1]
    if (!ch) return ''
    const path = resolvePath(this.opfDir, ch.href)
    const chDir = dirOf(path)
    let doc: Document
    try {
      doc = new DOMParser().parseFromString(this.text(path), 'application/xhtml+xml')
      if (doc.querySelector('parsererror')) throw new Error('xhtml parse error')
    } catch {
      doc = new DOMParser().parseFromString(this.text(path), 'text/html')
    }
    const body = doc.body ?? doc.documentElement
    // 拔除危险/样式节点
    body.querySelectorAll('script, iframe, object, embed, link, style, video, audio').forEach((e) => e.remove())
    body.querySelectorAll('*').forEach((el) => {
      for (const attr of [...el.attributes]) {
        const n = attr.name.toLowerCase()
        if (n.startsWith('on') || n === 'style' || n === 'class' || n === 'id') el.removeAttribute(attr.name)
      }
    })
    // 图片 → blob
    body.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src')
      const url = src && this.blobUrl(resolvePath(chDir, decodeURIComponent(src)))
      if (url) img.setAttribute('src', url)
      else img.remove()
      img.removeAttribute('width'); img.removeAttribute('height')
    })
    body.querySelectorAll('image').forEach((img) => {
      const href = img.getAttribute('xlink:href') || img.getAttribute('href')
      const url = href && this.blobUrl(resolvePath(chDir, decodeURIComponent(href)))
      const svg = img.closest('svg')
      if (url && svg) {
        const rep = doc.createElement('img')
        rep.setAttribute('src', url)
        svg.replaceWith(rep)
      } else svg?.remove()
    })
    // 内链拔除 href(避免 webview 内跳转),保留文字
    body.querySelectorAll('a').forEach((a) => a.removeAttribute('href'))
    const html = body.innerHTML
    this.htmlCache.set(chapter, html)
    return html
  }

  /** 粗略字数(用于空书检测) */
  probeTextLength(maxChapters = 5): number {
    let n = 0
    for (let c = 1; c <= Math.min(maxChapters, this.chapters.length); c++) {
      const div = document.createElement('div')
      div.innerHTML = this.chapterHtml(c)
      n += (div.textContent ?? '').trim().length
    }
    return n
  }

  destroy(): void {
    for (const url of this.blobUrls.values()) URL.revokeObjectURL(url)
    this.blobUrls.clear()
    this.htmlCache.clear()
    this.files = {}
  }
}

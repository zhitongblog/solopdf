/**
 * Cross-PDF Topic Digest & Literature Synthesis (`#tag` Knowledge Graph -> SoloMD Markdown)
 *
 * Aggregates annotations across multiple PDFs in the user's library/folder,
 * groups them by `#tag` or document, and renders a structured Markdown
 * literature review / study digest with clickable `solopdf://` deep links.
 */
import type { Annotation } from './types.js'
import { collectAllTags, extractTags, filterAnnotations } from './flashcards.js'
import { assetsDirName, deepLink } from './sidecar.js'

export interface DigestDocInput {
  docTitle: string
  filePath: string
  annotations: Annotation[]
}

export interface TopicDigestOptions {
  /** Custom H1 document title */
  title?: string
  /** Filter to specific `#tags` (without or with leading `#`) */
  tags?: string[]
  /** Filter to specific highlight colors */
  colors?: string[]
  /** Filter by text search query */
  query?: string
  /** Include annotations that have no `#tag` under an "Untagged" section (default `true`) */
  includeUntagged?: boolean
  /** Grouping mode: `'tag'` (default, cross-document thematic synthesis) or `'document'` */
  groupBy?: 'tag' | 'document'
  /** Untag section label */
  untaggedLabel?: string
}

export interface TopicDigestItem {
  docTitle: string
  filePath: string
  annotation: Annotation
  page: number
  tags: string[]
  deepLink: string
}

export interface TopicDigestGroup {
  key: string
  label: string
  count: number
  items: TopicDigestItem[]
}

export interface TopicDigestResult {
  markdown: string
  groups: TopicDigestGroup[]
  totalAnnotations: number
  totalDocuments: number
  allTags: string[]
}

function getExcerpt(a: Annotation): string {
  return (a.excerpt || a.anchor?.text || '').trim()
}

function getNote(a: Annotation): string {
  return (a.note || '').trim()
}

function getPage(a: Annotation): number {
  return a.anchor?.page ?? 1
}

function renderDigestItem(item: TopicDigestItem, showDocHeader: boolean): string {
  const { docTitle, filePath, annotation: a, page, deepLink: link } = item
  const excerpt = getExcerpt(a)
  const note = getNote(a)
  const lines: string[] = []

  const citeLabel = showDocHeader ? `**《${docTitle}》 p.${page}**` : `**p.${page}**`
  lines.push(`- ${citeLabel} — [跳回原文](${link})`)

  if (a.image) {
    const baseName = filePath.split(/[/\\]/).pop() ?? docTitle
    const dir = assetsDirName(baseName)
    lines.push(`  ![p.${page}](${dir}/${a.image})`)
  }
  if (excerpt) {
    for (const l of excerpt.split(/\r?\n/)) {
      lines.push(`  > ${l}`)
    }
  }
  if (note) {
    lines.push(`  ${note.replace(/\r?\n/g, '\n  ')}`)
  }

  return lines.join('\n')
}

/**
 * Build a cross-PDF Markdown topic digest from multiple documents' annotations.
 */
export function buildTopicDigest(
  docs: DigestDocInput[],
  opts: TopicDigestOptions = {},
): TopicDigestResult {
  const groupBy = opts.groupBy ?? 'tag'
  const includeUntagged = opts.includeUntagged ?? true
  const untaggedLabel = opts.untaggedLabel ?? '未分类 (Untagged)'
  const h1 = (opts.title || '跨文档专题综述 (Topic Digest)').trim()

  // Collect all tags across the entire input set before filtering
  const allAnnotsUnfiltered: Annotation[] = []
  for (const d of docs) {
    allAnnotsUnfiltered.push(...d.annotations)
  }
  const allTags = collectAllTags(allAnnotsUnfiltered)

  // Filter annotations per document
  const matchedDocs = new Set<string>()
  const flatItems: TopicDigestItem[] = []

  const normalizedFilterTags =
    opts.tags && opts.tags.length > 0
      ? opts.tags.map((t) => t.trim().replace(/^#+/, '').toLowerCase()).filter(Boolean)
      : undefined

  for (const doc of docs) {
    const filtered = filterAnnotations(doc.annotations, {
      tags: normalizedFilterTags,
      colors: opts.colors,
      query: opts.query,
    })

    for (const a of filtered) {
      const excerpt = getExcerpt(a)
      const note = getNote(a)
      if (!excerpt && !note && !a.image) continue

      const tags = extractTags(`${excerpt}\n${note}`)
      if (!includeUntagged && tags.length === 0 && !normalizedFilterTags?.length) {
        continue
      }

      const page = getPage(a)
      matchedDocs.add(doc.filePath || doc.docTitle)
      flatItems.push({
        docTitle: doc.docTitle,
        filePath: doc.filePath,
        annotation: a,
        page,
        tags,
        deepLink: deepLink(doc.filePath || doc.docTitle, page, a.id),
      })
    }
  }

  const groups: TopicDigestGroup[] = []

  if (groupBy === 'document') {
    const byDoc = new Map<string, TopicDigestItem[]>()
    for (const item of flatItems) {
      const key = item.filePath || item.docTitle
      const arr = byDoc.get(key)
      if (arr) arr.push(item)
      else byDoc.set(key, [item])
    }
    for (const [key, items] of byDoc.entries()) {
      items.sort((a, b) => a.page - b.page)
      groups.push({
        key,
        label: `《${items[0].docTitle}》`,
        count: items.length,
        items,
      })
    }
  } else {
    const byTag = new Map<string, TopicDigestItem[]>()
    const untaggedItems: TopicDigestItem[] = []

    for (const item of flatItems) {
      if (item.tags.length === 0) {
        if (includeUntagged) untaggedItems.push(item)
        continue
      }
      for (const tag of item.tags) {
        if (
          normalizedFilterTags &&
          normalizedFilterTags.length > 0 &&
          !normalizedFilterTags.some((ft) => tag === ft || tag.startsWith(`${ft}/`))
        ) {
          continue
        }
        const list = byTag.get(tag)
        if (list) list.push(item)
        else byTag.set(tag, [item])
      }
    }

    const sortedTags = Array.from(byTag.keys()).sort((a, b) => a.localeCompare(b))
    for (const tag of sortedTags) {
      const items = byTag.get(tag)!
      items.sort((a, b) => a.docTitle.localeCompare(b.docTitle) || a.page - b.page)
      groups.push({
        key: tag,
        label: `#${tag}`,
        count: items.length,
        items,
      })
    }

    if (includeUntagged && untaggedItems.length > 0 && !normalizedFilterTags?.length) {
      untaggedItems.sort((a, b) => a.docTitle.localeCompare(b.docTitle) || a.page - b.page)
      groups.push({
        key: '__untagged__',
        label: untaggedLabel,
        count: untaggedItems.length,
        items: untaggedItems,
      })
    }
  }

  // Render Markdown
  const mdLines: string[] = []
  mdLines.push(`# ${h1}`)
  mdLines.push('')
  mdLines.push(
    `> 共收录 **${matchedDocs.size}** 篇文档、**${flatItems.length}** 条批注` +
      (allTags.length ? ` · 标签：${allTags.map((t) => `\`#${t}\``).join(' ')}` : ''),
  )
  mdLines.push('')

  if (groups.length > 1) {
    mdLines.push('## 目录 (Contents)')
    for (const g of groups) {
      mdLines.push(`- **${g.label}** (${g.count})`)
    }
    mdLines.push('')
  }

  for (const g of groups) {
    mdLines.push(`## ${g.label} (${g.count})`)
    mdLines.push('')
    for (const item of g.items) {
      mdLines.push(renderDigestItem(item, groupBy !== 'document'))
      mdLines.push('')
    }
  }

  return {
    markdown: mdLines.join('\n').trimEnd() + '\n',
    groups,
    totalAnnotations: flatItems.length,
    totalDocuments: matchedDocs.size,
    allTags,
  }
}

#!/usr/bin/env node
/**
 * solopdf CLI — same pdf.js engine as the app, so text extraction matches
 * what the viewer sees (single-engine rule from the design doc).
 *
 *   solopdf info <file.pdf> [--password pw]
 *   solopdf extract-text <file.pdf> [--pages 1-5] [--password pw]
 *   solopdf export-annotations <file.pdf>       # sidecar -> JSON
 *   solopdf selftest <fixtures-dir>             # acceptance run over fixtures
 *
 * Used by Claude/CI for self-testing (global rule #2) and by users for
 * scripting. Read-only; it never modifies PDFs or sidecars.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { parse } from '@solopdf/core'

const args = process.argv.slice(2)
const cmd = args[0]

function flag(name) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : undefined
}

function die(msg, code = 1) {
  console.error(msg)
  process.exit(code)
}

async function open(file) {
  if (!existsSync(file)) die(`文件不存在: ${file}`)
  const data = new Uint8Array(await readFile(file))
  const task = getDocument({
    data,
    password: flag('password'),
    // node has no DOM canvas; disable font rendering paths we don't need
    disableFontFace: true,
    verbosity: 0,
  })
  try {
    return await task.promise
  } catch (e) {
    if (String(e?.name) === 'PasswordException') {
      die(`该 PDF 受密码保护（用 --password 提供密码）: ${e.message}`)
    }
    throw e
  }
}

function parsePages(spec, numPages) {
  if (!spec) return [1, numPages]
  const m = spec.match(/^(\d+)(?:-(\d+))?$/)
  if (!m) die(`--pages 格式: N 或 A-B`)
  const a = parseInt(m[1], 10)
  const b = m[2] ? parseInt(m[2], 10) : a
  return [Math.max(1, a), Math.min(numPages, b)]
}

async function pageText(doc, p) {
  const page = await doc.getPage(p)
  const tc = await page.getTextContent()
  let out = ''
  for (const it of tc.items) {
    if ('str' in it) out += it.str + (it.hasEOL ? '\n' : '')
  }
  return out
}

async function cmdInfo(file) {
  const doc = await open(file)
  const meta = await doc.getMetadata().catch(() => null)
  const outline = await doc.getOutline().catch(() => null)
  const countOutline = (items) =>
    !items ? 0 : items.reduce((n, it) => n + 1 + countOutline(it.items), 0)
  console.log(JSON.stringify({
    file: path.resolve(file),
    pages: doc.numPages,
    fingerprint: doc.fingerprints?.[0] ?? null,
    title: meta?.info?.Title || null,
    producer: meta?.info?.Producer || null,
    encrypted: !!meta?.info?.IsEncrypted || !!flag('password'),
    outlineEntries: countOutline(outline),
  }, null, 2))
}

async function cmdExtract(file) {
  const doc = await open(file)
  const [a, b] = parsePages(flag('pages'), doc.numPages)
  for (let p = a; p <= b; p++) {
    process.stdout.write(await pageText(doc, p))
    process.stdout.write('\n\f\n')
  }
}

async function cmdExportAnnotations(file) {
  const sidecar = file.replace(/\.pdf$/i, '') + '.annotations.md'
  if (!existsSync(sidecar)) die(`没有伴生批注文件: ${sidecar}`)
  const text = await readFile(sidecar, 'utf-8')
  const sc = parse(text)
  console.log(JSON.stringify(sc, null, 2))
}

async function cmdFormFields(file) {
  const doc = await open(file)
  const fields = await doc.getFieldObjects()
  if (!fields) {
    console.log(JSON.stringify({ file, fields: null, note: '无 AcroForm 表单域' }))
    return
  }
  const out = {}
  for (const [name, objs] of Object.entries(fields)) {
    const f = objs[0]
    out[name] = { type: f.type, value: f.value ?? '', page: (f.page ?? -1) + 1 }
  }
  console.log(JSON.stringify({ file, count: Object.keys(out).length, fields: out }, null, 2))
}

async function cmdExportMd(file) {
  const doc = await open(file)
  // outline -> headings
  const outline = []
  const walk = async (items, depth) => {
    for (const it of items ?? []) {
      try {
        let dest = it.dest
        if (typeof dest === 'string') dest = await doc.getDestination(dest)
        if (Array.isArray(dest) && dest[0]) outline.push({ title: it.title ?? '', page: (await doc.getPageIndex(dest[0])) + 1, depth })
      } catch {}
      if (it.items?.length) await walk(it.items, depth + 1)
    }
  }
  await walk(await doc.getOutline().catch(() => null), 0)
  const byPage = new Map()
  for (const o of outline.sort((a,b) => a.page - b.page)) {
    if (!byPage.has(o.page)) byPage.set(o.page, [])
    byPage.get(o.page).push(o)
  }
  const name = path.basename(file)
  process.stdout.write(`# ${name.replace(/\.pdf$/i, '')}\n\n> Source: ${name} · Pages: ${doc.numPages}\n\n`)
  for (let p = 1; p <= doc.numPages; p++) {
    for (const h of byPage.get(p) ?? []) process.stdout.write(`${'#'.repeat(Math.min(h.depth + 2, 6))} ${h.title}\n\n`)
    process.stdout.write(`<!-- p.${p} -->\n`)
    const t = await pageText(doc, p)
    if (t.trim()) process.stdout.write(t.trim() + '\n\n')
  }
}

async function cmdSelftest(dir) {
  // acceptance sweep over the standard fixture set (design doc test plan)
  const cases = [
    { f: 'chinese-wikipedia-hanzi.pdf', minPages: 20, expectText: '漢字文化圈' },
    { f: 'toc-pdf-spec-iso32000.pdf', minPages: 700, expectOutline: 800 },
    { f: 'scanned-sherlock-1892.pdf', minPages: 300 },
    { f: 'scanned-no-textlayer.pdf', minPages: 10, expectNoText: true },
    { f: 'form-irs-w9.pdf', minPages: 6 },
    { f: 'encrypted-password-solopdf.pdf', minPages: 20, password: 'solopdf' },
    { f: 'large-britannica-v1.pdf', minPages: 1000, optional: true },
  ]
  let pass = 0, fail = 0, skip = 0
  for (const c of cases) {
    const file = path.join(dir, c.f)
    if (!existsSync(file)) {
      if (c.optional) { console.log(`SKIP ${c.f} (缺文件，可选)`); skip++; continue }
      console.log(`FAIL ${c.f}: 文件不存在`); fail++; continue
    }
    try {
      const data = new Uint8Array(await readFile(file))
      const doc = await getDocument({ data, password: c.password, disableFontFace: true, verbosity: 0 }).promise
      const problems = []
      if (doc.numPages < c.minPages) problems.push(`页数 ${doc.numPages} < ${c.minPages}`)
      if (c.expectText) {
        const t1 = (await pageText(doc, 1)).normalize('NFKC')
        if (!t1.includes(c.expectText)) problems.push(`第 1 页未找到「${c.expectText}」`)
      }
      if (c.expectNoText) {
        const t1 = (await pageText(doc, 1)).trim()
        if (t1.length > 0) problems.push(`预期无文字层但提取到 ${t1.length} 字符`)
      }
      if (c.expectOutline) {
        const outline = await doc.getOutline()
        const count = (items) => !items ? 0 : items.reduce((n, it) => n + 1 + count(it.items), 0)
        const n = count(outline)
        if (n < c.expectOutline) problems.push(`书签 ${n} < ${c.expectOutline}`)
      }
      if (problems.length) { console.log(`FAIL ${c.f}: ${problems.join('; ')}`); fail++ }
      else { console.log(`PASS ${c.f} (${doc.numPages} 页)`); pass++ }
      await doc.destroy()
    } catch (e) {
      console.log(`FAIL ${c.f}: ${e.message}`)
      fail++
    }
  }
  console.log(`\n${pass} pass, ${fail} fail, ${skip} skip`)
  process.exit(fail ? 1 : 0)
}

const file = args[1]
switch (cmd) {
  case 'info': await cmdInfo(file ?? die('用法: solopdf info <file.pdf>')); break
  case 'extract-text': await cmdExtract(file ?? die('用法: solopdf extract-text <file.pdf>')); break
  case 'export-annotations': await cmdExportAnnotations(file ?? die('用法: solopdf export-annotations <file.pdf>')); break
  case 'form-fields': await cmdFormFields(file ?? die('用法: solopdf form-fields <file.pdf>')); break
  case 'export-md': await cmdExportMd(file ?? die('用法: solopdf export-md <file.pdf>')); break
  case 'selftest': await cmdSelftest(file ?? die('用法: solopdf selftest <fixtures-dir>')); break
  default:
    console.log(`solopdf — SoloPDF 命令行工具（与应用同一渲染引擎）

用法:
  solopdf info <file.pdf> [--password pw]          文档信息（页数/书签/元数据）
  solopdf extract-text <file.pdf> [--pages A-B]    提取文字
  solopdf export-annotations <file.pdf>            批注伴生文件 → JSON
  solopdf form-fields <file.pdf>                   AcroForm 表单域与当前值 → JSON
  solopdf export-md <file.pdf>                     全文导出为 Markdown（stdout）
  solopdf selftest <fixtures-dir>                  标准测试集验收`)
    process.exit(cmd ? 1 : 0)
}

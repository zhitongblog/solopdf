#!/usr/bin/env node
/**
 * i18n completeness check.
 *
 * Two failure modes this catches, both of which ship silently otherwise:
 *   1. a key present in one locale and missing in another — the UI falls back
 *      to the raw key and shows "sb.orphanTip" to a Japanese reader
 *   2. a key used in the code that no locale defines at all
 *
 * Run: node scripts/check-i18n.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../app/src')
const I18N = path.join(SRC, 'i18n.ts')

const source = fs.readFileSync(I18N, 'utf8')

/** the dictionaries, in declaration order */
const dicts = {}
for (const m of source.matchAll(/^const (zhCN|zhTW|en|ja): Dict = \{([\s\S]*?)^\}/gm)) {
  const [, name, body] = m
  const keys = new Set()
  // several short entries share a line, so scan every 'key': on it, not just
  // the first one (that miss reported bk.font.serif as undefined)
  // values may be single- OR double-quoted (English strings with an
  // apostrophe use double quotes), and several entries can share a line
  for (const k of body.matchAll(/'([a-zA-Z][\w.]*)':\s*["']/g)) keys.add(k[1])
  dicts[name] = keys
}

const names = Object.keys(dicts)
if (names.length !== 4) {
  console.error(`expected 4 locales, found ${names.length}: ${names.join(', ')}`)
  process.exit(1)
}

let problems = 0

// 1. every locale must define the same keys
const union = new Set(names.flatMap((n) => [...dicts[n]]))
for (const name of names) {
  const missing = [...union].filter((k) => !dicts[name].has(k)).sort()
  if (missing.length) {
    problems += missing.length
    console.error(`${name}: missing ${missing.length} keys`)
    for (const k of missing.slice(0, 20)) console.error(`   ${k}`)
    if (missing.length > 20) console.error(`   … and ${missing.length - 20} more`)
  }
}

// 2. every t('…') in the code must resolve
function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (/\.(ts|vue)$/.test(entry.name)) out.push(p)
  }
  return out
}

const used = new Map()
for (const file of walk(SRC)) {
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(/\bt\(\s*'([^']+)'/g)) {
    if (!used.has(m[1])) used.set(m[1], file)
  }
}
// t('prefix.' + variable) leaves a literal prefix ending in '.' — treat it
// as satisfied when at least one real key lives under it
const unknown = [...used.keys()]
  .filter((k) => {
    if (union.has(k)) return false
    if (k.endsWith('.')) return ![...union].some((u) => u.startsWith(k))
    return true
  })
  .sort()
if (unknown.length) {
  problems += unknown.length
  console.error(`\n${unknown.length} keys used in code but defined nowhere:`)
  for (const k of unknown) console.error(`   ${k}  (${path.relative(SRC, used.get(k))})`)
}

// 3. placeholders must match across locales — {file} in one and {name} in
//    another is a silently broken message
for (const key of union) {
  const shapes = new Map()
  for (const name of names) {
    const body = source.match(new RegExp(`^const ${name}: Dict = \\{([\\s\\S]*?)^\\}`, 'm'))?.[1] ?? ''
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const line =
      body.match(new RegExp(`'${esc}':\\s*'([^']*)'`)) ??
      body.match(new RegExp(`'${esc}':\\s*"([^"]*)"`))
    if (!line) continue
    const vars = [...line[1].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
    shapes.set(name, vars)
  }
  const distinct = new Set(shapes.values())
  if (distinct.size > 1) {
    problems++
    console.error(`\nplaceholder mismatch for ${key}:`)
    for (const [n, v] of shapes) console.error(`   ${n}: {${v || '—'}}`)
  }
}

const counts = names.map((n) => `${n}=${dicts[n].size}`).join(' ')
if (problems) {
  console.error(`\n${problems} problem(s). ${counts}`)
  process.exit(1)
}
console.log(`i18n ok — ${union.size} keys × 4 locales (${counts}), ${used.size} used in code`)

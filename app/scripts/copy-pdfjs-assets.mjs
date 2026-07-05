// Copy pdf.js cmaps + standard fonts into public/ so cMapUrl works
// identically in dev and production builds.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'))
const publicDir = path.resolve(import.meta.dirname, '../public/pdfjs')

for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  const src = path.join(pdfjsRoot, dir)
  const dst = path.join(publicDir, dir)
  fs.mkdirSync(dst, { recursive: true })
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f)
    const d = path.join(dst, f)
    if (!fs.existsSync(d) || fs.statSync(s).mtimeMs > fs.statSync(d).mtimeMs) {
      fs.copyFileSync(s, d)
    }
  }
}
console.log('pdfjs assets copied to', publicDir)

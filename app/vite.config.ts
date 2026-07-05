import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Dev-only fixtures API so the full UI can run and be E2E-tested in a plain
 * browser (Unzoo) without Tauri:
 *   GET  /__fixtures            -> JSON list of test-fixtures/*.pdf
 *   GET  /__fixtures/<name>     -> the PDF, native Range support via sendFile
 *   GET  /__sidecar?p=<abs>     -> sidecar text ('' if absent)
 *   PUT  /__sidecar?p=<abs>     -> write sidecar text
 * Never shipped: only registered by configureServer (vite dev).
 */
function fixturesApi(): Plugin {
  const FIXTURES = path.resolve(__dirname, '../test-fixtures')
  return {
    name: 'solopdf-fixtures-api',
    configureServer(server) {
      server.middlewares.use('/__fixtures', (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const rel = decodeURIComponent(url.pathname.replace(/^\//, ''))
        if (!rel) {
          const list = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.pdf'))
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(list))
          return
        }
        const file = path.join(FIXTURES, rel)
        if (!file.startsWith(FIXTURES)) return next()
        if (req.method === 'PUT') {
          const chunks: Buffer[] = []
          req.on('data', (c) => chunks.push(c))
          req.on('end', () => {
            fs.writeFileSync(file, Buffer.concat(chunks))
            res.end('ok')
          })
          return
        }
        if (!fs.existsSync(file)) return next()
        const stat = fs.statSync(file)
        const range = req.headers.range
        if (range) {
          const m = range.match(/bytes=(\d+)-(\d*)/)
          if (m) {
            const start = parseInt(m[1], 10)
            const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1
            res.statusCode = 206
            res.setHeader('content-range', `bytes ${start}-${end}/${stat.size}`)
            res.setHeader('accept-ranges', 'bytes')
            res.setHeader('content-length', end - start + 1)
            res.setHeader('content-type', 'application/pdf')
            fs.createReadStream(file, { start, end }).pipe(res)
            return
          }
        }
        res.setHeader('accept-ranges', 'bytes')
        res.setHeader('content-length', stat.size)
        res.setHeader('content-type', 'application/pdf')
        fs.createReadStream(file).pipe(res)
      })
      server.middlewares.use('/__sidecar', (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const p = url.searchParams.get('p')
        if (!p) return next()
        // sandbox to test-fixtures for the dev API
        const file = path.resolve(p)
        if (!file.startsWith(FIXTURES)) {
          res.statusCode = 403
          res.end('forbidden')
          return
        }
        if (req.method === 'GET') {
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end(fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '')
        } else if (req.method === 'PUT') {
          let body = ''
          req.setEncoding('utf-8')
          req.on('data', (c) => (body += c))
          req.on('end', () => {
            fs.writeFileSync(file, body, 'utf-8')
            res.end('ok')
          })
        } else next()
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), fixturesApi()],
  resolve: {
    alias: {
      // app consumes core TS sources directly (HMR); CLI/MCP use core/dist
      '@solopdf/core': path.resolve(__dirname, '../core/src/index.ts'),
    },
  },
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
  },
  build: {
    target: 'es2022',
  },
})

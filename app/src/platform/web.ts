/**
 * WebBackend — vite dev server backend for browser E2E testing.
 * PDFs come from /__fixtures with native HTTP Range; sidecars via /__sidecar.
 * State lives in localStorage. Never active inside Tauri.
 */
import type { FileMeta, PlatformBackend } from './types'

const STATE_KEY = 'solopdf-state'

export class WebBackend implements PlatformBackend {
  readonly kind = 'web' as const

  private fixtureUrl(path: string): string {
    const name = path.split('/').pop()!
    return `/__fixtures/${encodeURIComponent(name)}`
  }

  async fileMeta(path: string): Promise<FileMeta> {
    const res = await fetch(this.fixtureUrl(path), { method: 'GET', headers: { range: 'bytes=0-0' } })
    if (!res.ok && res.status !== 206) throw new Error(`无法打开文件: ${path} (${res.status})`)
    const cr = res.headers.get('content-range')
    const size = cr ? parseInt(cr.split('/')[1], 10) : parseInt(res.headers.get('content-length') ?? '0', 10)
    return { path, name: path.split('/').pop()!, size }
  }

  async readChunk(path: string, offset: number, length: number): Promise<Uint8Array> {
    const res = await fetch(this.fixtureUrl(path), {
      headers: { range: `bytes=${offset}-${offset + length - 1}` },
    })
    if (!res.ok && res.status !== 206) throw new Error(`读取失败: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  private sidecarPath(pdfPath: string): string {
    return pdfPath.replace(/\.pdf$/i, '') + '.annotations.md'
  }

  async readSidecar(pdfPath: string) {
    const loc = this.sidecarPath(pdfPath)
    const res = await fetch(`/__sidecar?p=${encodeURIComponent(loc)}`)
    return { text: res.ok ? await res.text() : '', location: loc }
  }

  async writeSidecar(pdfPath: string, text: string): Promise<string> {
    const loc = this.sidecarPath(pdfPath)
    const res = await fetch(`/__sidecar?p=${encodeURIComponent(loc)}`, { method: 'PUT', body: text })
    if (!res.ok) throw new Error(`伴生文件写入失败: ${res.status}`)
    return loc
  }

  async pickFiles(): Promise<string[] | null> {
    // web mode: pick from fixtures list (E2E harness uses store.openPath directly)
    const res = await fetch('/__fixtures')
    const list: string[] = await res.json()
    return list.map((f) => `/Volumes/Dev/code/pdf/test-fixtures/${f}`)
  }

  async loadState(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}')
    } catch {
      return {}
    }
  }

  async saveState(state: Record<string, unknown>): Promise<void> {
    localStorage.setItem(STATE_KEY, JSON.stringify(state))
  }

  async fileHash(path: string): Promise<string> {
    // cheap web impl: hash first 1MB via SubtleCrypto (lazy, off render path)
    const chunk = await this.readChunk(path, 0, 1024 * 1024)
    const digest = await crypto.subtle.digest('SHA-256', chunk as BufferSource)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  async revealFile(): Promise<void> {
    /* no-op on web */
  }
}

/**
 * WebBackend — vite dev server backend for browser E2E testing.
 * PDFs come from /__fixtures with native HTTP Range; sidecars via /__sidecar.
 * State lives in localStorage. Never active inside Tauri.
 */
import type { FileMeta, PlatformBackend } from './types'

const STATE_KEY = 'solopdf-state'

/** web stand-in for the app cache: attachments opened from a PDF live in
 *  memory under a /__staged/… pseudo-path for the life of the page */
const STAGED = new Map<string, Uint8Array>()
const STAGED_SIDECARS = new Map<string, string>()
const isStaged = (path: string): boolean => path.startsWith('/__staged/')

/** E2E seam: every browser download saveBytes() started, newest last */
export const webDownloads: { name: string; size: number }[] = []

function mimeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', txt: 'text/plain', csv: 'text/csv', epub: 'application/epub+zip',
  }
  return map[ext] ?? 'application/octet-stream'
}

export class WebBackend implements PlatformBackend {
  readonly kind = 'web' as const

  private fixtureUrl(path: string): string {
    const name = path.split('/').pop()!
    return `/__fixtures/${encodeURIComponent(name)}`
  }

  async fileMeta(path: string): Promise<FileMeta> {
    const staged = STAGED.get(path)
    if (staged) return { path, name: path.split('/').pop()!, size: staged.length }
    const res = await fetch(this.fixtureUrl(path), { method: 'GET', headers: { range: 'bytes=0-0' } })
    if (!res.ok && res.status !== 206) throw new Error(`无法打开文件: ${path} (${res.status})`)
    const cr = res.headers.get('content-range')
    const size = cr ? parseInt(cr.split('/')[1], 10) : parseInt(res.headers.get('content-length') ?? '0', 10)
    return { path, name: path.split('/').pop()!, size }
  }

  async readChunk(path: string, offset: number, length: number): Promise<Uint8Array> {
    const staged = STAGED.get(path)
    if (staged) return staged.slice(offset, offset + length)
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
    if (isStaged(pdfPath)) return { text: STAGED_SIDECARS.get(loc) ?? '', location: loc }
    const res = await fetch(`/__sidecar?p=${encodeURIComponent(loc)}`)
    return { text: res.ok ? await res.text() : '', location: loc }
  }

  async writeSidecar(pdfPath: string, text: string): Promise<string> {
    const loc = this.sidecarPath(pdfPath)
    if (isStaged(pdfPath)) { STAGED_SIDECARS.set(loc, text); return loc }
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

  async savePdf(suggestedName: string, bytes: Uint8Array): Promise<string | null> {
    // E2E mode: write into test-fixtures via the dev API
    const res = await fetch(`/__fixtures/${encodeURIComponent(suggestedName)}`, {
      method: 'PUT',
      body: bytes as BodyInit,
    })
    if (!res.ok) throw new Error(`保存失败: ${res.status}`)
    return `/Volumes/Dev/code/pdf/test-fixtures/${suggestedName}`
  }

  private assetPath(pdfPath: string, name: string): string {
    const stem = pdfPath.replace(/\.[^./]+$/, '')
    return `${stem}.annotations.assets/${name}`
  }

  async writeSidecarAsset(pdfPath: string, name: string, bytes: Uint8Array): Promise<string> {
    const loc = this.assetPath(pdfPath, name)
    const res = await fetch(`/__asset?p=${encodeURIComponent(loc)}`, { method: 'PUT', body: bytes as BodyInit })
    if (!res.ok) throw new Error(`资源写入失败: ${res.status}`)
    return loc
  }

  async readSidecarAsset(pdfPath: string, name: string): Promise<Uint8Array | null> {
    const res = await fetch(`/__asset?p=${encodeURIComponent(this.assetPath(pdfPath, name))}`)
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  }

  async importDocument(path: string): Promise<string> {
    return path // the browser harness reads fixtures straight off disk
  }

  async listImported(): Promise<string[]> {
    return []
  }

  async stageFile(name: string, bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
    const key = [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')
    const path = `/__staged/${key}/${name}`
    STAGED.set(path, bytes.slice())
    return path
  }

  async openStagedExternally(path: string): Promise<void> {
    const bytes = STAGED.get(path)
    if (!bytes) throw new Error(`not staged: ${path}`)
    const name = path.split('/').pop()!
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeFor(name) }))
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  async saveBytes(suggestedName: string, bytes: Uint8Array): Promise<string | null> {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeFor(suggestedName) }))
    const a = document.createElement('a')
    a.href = url
    a.download = suggestedName
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    webDownloads.push({ name: suggestedName, size: bytes.length })
    return suggestedName
  }

  async saveText(suggestedName: string, text: string): Promise<string | null> {
    const res = await fetch(`/__fixtures/${encodeURIComponent(suggestedName)}`, {
      method: 'PUT',
      body: text,
    })
    if (!res.ok) throw new Error(`保存失败: ${res.status}`)
    return `/Volumes/Dev/code/pdf/test-fixtures/${suggestedName}`
  }
}

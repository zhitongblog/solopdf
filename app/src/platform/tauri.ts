/**
 * TauriBackend — production backend over Rust commands.
 * Binary chunks travel via tauri::ipc::Response (ArrayBuffer, no base64).
 */
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import type { FileMeta, PlatformBackend } from './types'

export class TauriBackend implements PlatformBackend {
  readonly kind = 'tauri' as const

  async fileMeta(path: string): Promise<FileMeta> {
    return await invoke<FileMeta>('file_meta', { path })
  }

  async readChunk(path: string, offset: number, length: number): Promise<Uint8Array> {
    const buf = await invoke<ArrayBuffer>('read_chunk', { path, offset, length })
    return new Uint8Array(buf)
  }

  async readSidecar(pdfPath: string): Promise<{ text: string; location: string }> {
    return await invoke<{ text: string; location: string }>('read_sidecar', { pdfPath })
  }

  async writeSidecar(pdfPath: string, text: string): Promise<string> {
    return await invoke<string>('write_sidecar', { pdfPath, text })
  }

  async pickFiles(): Promise<string[] | null> {
    const sel = await open({
      multiple: true,
      filters: [{ name: 'PDF / EPUB', extensions: ['pdf', 'epub'] }],
    })
    if (!sel) return null
    return Array.isArray(sel) ? sel : [sel]
  }

  async loadState(): Promise<Record<string, unknown>> {
    return await invoke<Record<string, unknown>>('load_state')
  }

  async saveState(state: Record<string, unknown>): Promise<void> {
    await invoke('save_state', { state })
  }

  async fileHash(path: string): Promise<string> {
    return await invoke<string>('file_hash', { path })
  }

  async revealFile(path: string): Promise<void> {
    await invoke('reveal_file', { path })
  }

  async savePdf(suggestedName: string, bytes: Uint8Array): Promise<string | null> {
    const dest = await save({
      defaultPath: suggestedName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (!dest) return null
    // raw body upload — no base64/JSON copy for multi-MB PDFs
    await invoke('save_pdf_bytes', bytes, { headers: { 'x-dest': encodeURIComponent(dest) } })
    return dest
  }

  async saveText(suggestedName: string, text: string): Promise<string | null> {
    if (/iPhone|iPad|Android/i.test(navigator.userAgent)) {
      // no save dialogs on mobile — write to the app Documents folder,
      // which UIFileSharingEnabled exposes in the iOS Files app
      return await invoke<string>('save_to_documents', { name: suggestedName, text })
    }
    const dest = await save({
      defaultPath: suggestedName,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (!dest) return null
    // save_pdf_bytes is a generic raw-body file writer despite the name
    await invoke('save_pdf_bytes', new TextEncoder().encode(text), {
      headers: { 'x-dest': encodeURIComponent(dest) },
    })
    return dest
  }
}

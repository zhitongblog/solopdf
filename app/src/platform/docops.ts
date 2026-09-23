/**
 * Document operations — the write side of the app.
 *
 * Everything here produces a NEW file: rotate, reorder, merge, split, export
 * images, compress, sign, set/remove a password, and bake sidecar marks into
 * standard PDF annotations. The source is never modified in place.
 *
 * Implemented in Rust (src-tauri/src/pdfops.rs) via lopdf. There is no web
 * fallback on purpose: a browser build has no file to write back to, and a
 * silently half-working "save" is worse than a disabled button.
 */
import type { AnnotExportSpec } from '@solopdf/core'
import { isTauri } from './index'

/** mirror of pdfops.rs AnnotSpec — built by core exportSpec() so the app,
 *  the CLI and the MCP server hand the exporter identical JSON */
export type AnnotSpec = AnnotExportSpec

export interface StampInput {
  page: number
  /** PDF user space: [x, y, width, height] */
  rect: [number, number, number, number]
  imagePath: string
}

export interface CompressResult {
  path: string
  before: number
  after: number
}

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return await invoke<T>(cmd, args)
}

export function docOpsAvailable(): boolean {
  return isTauri()
}

export const docOps = {
  writeAnnotations: (srcPath: string, destPath: string | null, password: string | null, annots: AnnotSpec[]) =>
    call<string>('pdf_write_annotations', { srcPath, destPath, password, annots }),

  rotatePages: (srcPath: string, destPath: string | null, password: string | null, pages: number[], degrees: number) =>
    call<string>('pdf_rotate_pages', { srcPath, destPath, password, pages, degrees }),

  arrangePages: (srcPath: string, destPath: string | null, password: string | null, order: number[]) =>
    call<string>('pdf_arrange_pages', { srcPath, destPath, password, order }),

  merge: (srcPaths: string[], destPath: string | null) =>
    call<string>('pdf_merge', { srcPaths, destPath }),

  split: (srcPath: string, destDir: string | null, password: string | null, ranges: [number, number][]) =>
    call<string[]>('pdf_split', { srcPath, destDir, password, ranges }),

  fromImages: (imagePaths: string[], destPath: string | null, dpi: number) =>
    call<string>('pdf_from_images', { imagePaths, destPath, dpi }),

  compress: (srcPath: string, destPath: string | null, password: string | null, maxDim: number, quality: number) =>
    call<CompressResult>('pdf_compress', { srcPath, destPath, password, maxDim, quality }),

  stamp: (srcPath: string, destPath: string | null, password: string | null, stamps: StampInput[]) =>
    call<string>('pdf_stamp', {
      srcPath, destPath, password,
      stamps: stamps.map((s) => ({ page: s.page, rect: s.rect, image_path: s.imagePath })),
    }),

  setPassword: (srcPath: string, destPath: string | null, current: string | null, user: string, owner: string) =>
    call<string>('pdf_set_password', { srcPath, destPath, current, user, owner }),

  removePassword: (srcPath: string, destPath: string | null, password: string) =>
    call<string>('pdf_remove_password', { srcPath, destPath, password }),

  // ── signature library (appData, never beside a document) ──
  async saveSignature(name: string, bytes: Uint8Array): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<string>('save_signature', bytes, {
      headers: { 'x-name': encodeURIComponent(name) },
    })
  },
  listSignatures: () => call<string[]>('list_signatures', {}),
  deleteSignature: (path: string) => call<void>('delete_signature', { path }),

  async readFileBytes(path: string): Promise<Uint8Array> {
    const { invoke } = await import('@tauri-apps/api/core')
    const buf = await invoke<ArrayBuffer>('read_file_bytes', { path })
    return new Uint8Array(buf)
  },
}

// ── file pickers (desktop dialogs; mobile falls back to the app folder) ──

export function mobileNoDialogs(): boolean {
  return /iPhone|iPad|Android/i.test(navigator.userAgent)
}

/** null destination = "let the backend put it in the app Documents folder" */
export async function pickSavePath(suggested: string, ext: string): Promise<string | null | undefined> {
  if (mobileNoDialogs()) return null
  const { save } = await import('@tauri-apps/plugin-dialog')
  const dest = await save({ defaultPath: suggested, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
  // undefined = the user cancelled; null = "backend picks"
  return dest ?? undefined
}

export async function pickOpenPaths(extensions: string[], multiple = true): Promise<string[]> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const sel = await open({ multiple, filters: [{ name: 'Files', extensions }] })
  if (!sel) return []
  const items = Array.isArray(sel) ? sel : [sel]
  return items
    .map((it) => (typeof it === 'string' ? it : ((it as { path?: string }).path ?? '')))
    .filter(Boolean)
    .map((s) => (s.startsWith('file://') ? decodeURIComponent(s.replace(/^file:\/\//, '')) : s))
}

export async function pickDirectory(): Promise<string | null> {
  if (mobileNoDialogs()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const sel = await open({ directory: true, multiple: false })
  return typeof sel === 'string' ? sel : null
}

/** #rrggbb (or a named highlight colour) → 0–1 RGB triple (lives in core now,
 *  shared with the CLI and MCP exporters) */
export { colorTriple } from '@solopdf/core'

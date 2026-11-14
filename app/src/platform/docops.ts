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
import type { AnnotExportSpec, OutlineNode, PipelineStepSpec } from '@solopdf/core'
import { isTauri } from './index'

export type { OutlineNode, PipelineStepSpec }

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

export interface CropSpec {
  margins?: [number, number, number, number]
  odd_margins?: [number, number, number, number] | null
  even_margins?: [number, number, number, number] | null
  box_rect?: [number, number, number, number] | null
  per_page?: Array<[number, [number, number, number, number]]>
  pages?: number[]
}

export interface WatermarkSpec {
  text?: string
  font_size?: number
  color?: [number, number, number]
  opacity?: number
  rotate?: number
  position?: string
  tile_spacing?: number
  scale?: number
  under?: boolean
  pages?: number[]
}

export interface PageNumberSpec {
  format?: string
  position?: string
  start_number?: number
  from_page?: number
  to_page?: number
  font_size?: number
  margin?: number
  color?: [number, number, number]
}

export interface ExtractedImageOut {
  path: string
  page: number
  index: number
  width: number
  height: number
  format: string
}

export interface SanitizeSpec {
  metadata: boolean
  annotations: boolean
  attachments: boolean
  javascript_actions: boolean
  forms: boolean
}

export interface SanitizeReport {
  removed_metadata: boolean
  removed_annotations: number
  removed_attachments: boolean
  removed_actions: number
  removed_forms: boolean
}

export interface SanitizeResult {
  path: string
  report: SanitizeReport
}

export interface RedactRectInput {
  page: number
  rect: [number, number, number, number]
  color?: [number, number, number]
  label?: string
}

export interface NupSpec {
  cols: number
  rows: number
  landscape?: boolean | null
  margin?: number
  gap?: number
  border?: boolean
}

export interface SignatureInfo {
  fieldName: string
  signerName: string
  organization: string | null
  email: string | null
  reason: string | null
  location: string | null
  signingTime: string | null
  byteRangeValid: boolean
  coversWholeDocument: boolean
  digestValid: boolean
  status: 'valid' | 'modified' | 'invalid'
  subFilter: string
}

export interface CertSignSpec {
  signerName: string
  reason?: string | null
  location?: string | null
  contact?: string | null
  page?: number | null
  rect?: [number, number, number, number] | null
  p12Bytes?: number[] | null
  passphrase?: string | null
  p12Path?: string | null
}

export interface Split2upSpec {
  direction?: 'vertical' | 'horizontal'
  rtl?: boolean
  only_wide?: boolean
  overlap?: number
}

export interface RemoveBlankResult {
  path: string
  removed: number[]
}

export interface DeskewResult {
  path: string
  angles: number[]
}

export interface EmbeddedAttachmentInfo {
  name: string
  size: number
  description: string
}

export interface AttachmentFileSpec {
  path: string
  name?: string
  description?: string
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

  cropPages: (srcPath: string, destPath: string | null, password: string | null, spec: CropSpec) =>
    call<string>('pdf_crop_pages', { srcPath, destPath, password, spec }),

  watermark: (
    srcPath: string,
    destPath: string | null,
    password: string | null,
    spec: WatermarkSpec,
    imagePath?: string | null,
  ) => call<string>('pdf_watermark', { srcPath, destPath, password, spec, imagePath: imagePath ?? null }),

  addPageNumbers: (srcPath: string, destPath: string | null, password: string | null, spec: PageNumberSpec) =>
    call<string>('pdf_add_page_numbers', { srcPath, destPath, password, spec }),

  extractImages: (srcPath: string, destDir: string | null, password: string | null, minDim = 32) =>
    call<ExtractedImageOut[]>('pdf_extract_images', { srcPath, destDir, password, minDim }),

  sanitize: (srcPath: string, destPath: string | null, password: string | null, spec: SanitizeSpec) =>
    call<SanitizeResult>('pdf_sanitize', { srcPath, destPath, password, spec }),

  flatten: (srcPath: string, destPath: string | null, password: string | null) =>
    call<string>('pdf_flatten', { srcPath, destPath, password }),

  redact: (
    srcPath: string,
    destPath: string | null,
    password: string | null,
    rects: RedactRectInput[],
    stripMetadata = true,
  ) => call<string>('pdf_redact', { srcPath, destPath, password, rects, stripMetadata }),

  getOutlines: (srcPath: string, password: string | null) =>
    call<OutlineNode[]>('pdf_get_outlines', { srcPath, password }),

  setOutlines: (
    srcPath: string,
    destPath: string | null,
    password: string | null,
    outlines: OutlineNode[],
  ) => call<string>('pdf_set_outlines', { srcPath, destPath, password, outlines }),

  nup: (srcPath: string, destPath: string | null, password: string | null, spec: NupSpec) =>
    call<string>('pdf_nup', { srcPath, destPath, password, spec }),

  booklet: (srcPath: string, destPath: string | null, password: string | null, border: boolean) =>
    call<string>('pdf_booklet', { srcPath, destPath, password, border }),

  grayscale: (srcPath: string, destPath: string | null, password: string | null, whitenBg: boolean) =>
    call<string>('pdf_grayscale', { srcPath, destPath, password, whitenBg }),

  resizePages: (
    srcPath: string,
    destPath: string | null,
    password: string | null,
    targetWidth: number,
    targetHeight: number,
  ) =>
    call<string>('pdf_resize_pages', {
      srcPath,
      destPath,
      password,
      targetWidth,
      targetHeight,
      width: targetWidth,
      height: targetHeight,
    }),

  verifySignatures: (srcPath: string, password: string | null) =>
    call<SignatureInfo[]>('pdf_verify_signatures', { srcPath, password }),

  certSign: (
    srcPath: string,
    destPath: string | null,
    password: string | null,
    spec: CertSignSpec,
    p12Path?: string | null,
  ) =>
    call<string>('pdf_cert_sign', {
      srcPath,
      destPath,
      password,
      spec,
      p12Path: p12Path ?? spec.p12Path ?? null,
    }),

  split2up: (
    srcPath: string,
    destPath: string | null,
    password: string | null,
    spec: Split2upSpec,
  ) => call<string>('pdf_split_2up', { srcPath, destPath, password, spec }),

  singleLargePage: (
    srcPath: string,
    destPath: string | null,
    password: string | null,
    gap = 16,
    border = false,
  ) => call<string>('pdf_single_large_page', { srcPath, destPath, password, gap, border }),

  detectBlankPages: (srcPath: string, password: string | null, threshold = 0.005) =>
    call<number[]>('pdf_detect_blank_pages', { srcPath, password, threshold }),

  removeBlankPages: (
    srcPath: string,
    destPath: string | null,
    password: string | null,
    threshold = 0.005,
  ) => call<RemoveBlankResult>('pdf_remove_blank_pages', { srcPath, destPath, password, threshold }),

  overlay: (
    srcPath: string,
    destPath: string | null,
    password: string | null,
    overlayPath: string,
    overlayPassword: string | null,
    under = true,
    repeat = true,
  ) =>
    call<string>('pdf_overlay', {
      srcPath,
      destPath,
      password,
      overlayPath,
      overlayPassword,
      under,
      repeat,
    }),

  listAttachments: (srcPath: string, password: string | null) =>
    call<EmbeddedAttachmentInfo[]>('pdf_list_attachments', { srcPath, password }),

  addAttachments: (
    srcPath: string,
    destPath: string | null,
    password: string | null,
    files: AttachmentFileSpec[],
  ) => call<string>('pdf_add_attachments', { srcPath, destPath, password, files }),

  removeAttachments: (
    srcPath: string,
    destPath: string | null,
    password: string | null,
    names: string[],
  ) => call<string>('pdf_remove_attachments', { srcPath, destPath, password, names }),

  runPipeline: (
    srcPath: string,
    destPath: string | null,
    password: string | null,
    steps: PipelineStepSpec[],
  ) => call<string>('pdf_run_pipeline', { srcPath, destPath, password, steps }),

  deskew: (
    srcPath: string,
    destPath: string | null,
    password: string | null,
    maxAngle = 12,
    cleanBorders = 0.02,
  ) =>
    call<DeskewResult>('pdf_deskew', {
      srcPath,
      destPath,
      password,
      maxAngle,
      cleanBorders,
    }),

  binarize: (
    srcPath: string,
    destPath: string | null,
    password: string | null,
    k = 0.2,
    windowSize = 31,
    cleanBorders = 0.02,
  ) =>
    call<string>('pdf_binarize', {
      srcPath,
      destPath,
      password,
      k,
      windowSize,
      cleanBorders,
    }),

  batchPipeline: (
    srcPaths: string[],
    destDir: string | null,
    password: string | null,
    steps: PipelineStepSpec[],
  ) => call<string[]>('pdf_batch_pipeline', { srcPaths, destDir, password, steps }),

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
  const sel = await open({
    multiple,
    ...(extensions.length ? { filters: [{ name: 'Files', extensions }] } : {}),
  })
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

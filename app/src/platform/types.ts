/**
 * Platform backend abstraction.
 *
 *   ┌─────────────┐     invoke/ipc      ┌──────────────┐
 *   │ TauriBackend│ ──────────────────▶ │ Rust commands │  (production)
 *   └─────────────┘                     └──────────────┘
 *   ┌─────────────┐   fetch + Range     ┌──────────────┐
 *   │  WebBackend │ ──────────────────▶ │ vite dev API  │  (browser E2E / dev)
 *   └─────────────┘                     └──────────────┘
 *
 * Everything above this layer (viewer, annotations, shell) is backend-agnostic,
 * which is what lets Unzoo drive the real UI in a plain browser.
 */

export interface FileMeta {
  path: string
  name: string
  size: number
}

export interface PlatformBackend {
  readonly kind: 'tauri' | 'web'
  /** file metadata (size for range transport) */
  fileMeta(path: string): Promise<FileMeta>
  /** read a byte range of the PDF */
  readChunk(path: string, offset: number, length: number): Promise<Uint8Array>
  /** read sidecar text; '' when absent */
  readSidecar(pdfPath: string): Promise<{ text: string; location: string }>
  /** write sidecar text; returns actual location (may be appData fallback) */
  writeSidecar(pdfPath: string, text: string): Promise<string>
  /** open-file dialog; returns paths or null */
  pickFiles(): Promise<string[] | null>
  /** persisted app state (settings, recents, positions) */
  loadState(): Promise<Record<string, unknown>>
  saveState(state: Record<string, unknown>): Promise<void>
  /** background content hash (hex) — resolves lazily, never on render path */
  fileHash(path: string): Promise<string>
  /** reveal file in OS file manager (no-op on web) */
  revealFile(path: string): Promise<void>
}

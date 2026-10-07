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
  /** save filled-form PDF bytes; user picks destination (Tauri save dialog).
   *  Returns saved path, or null if the user cancelled. */
  savePdf(suggestedName: string, bytes: Uint8Array): Promise<string | null>
  /** save a text file (Markdown export); returns path or null if cancelled */
  saveText(suggestedName: string, text: string): Promise<string | null>
  /** write a binary asset (region screenshot) next to the sidecar, inside
   *  `<stem>.annotations.assets/`; returns the written path */
  writeSidecarAsset(pdfPath: string, name: string, bytes: Uint8Array): Promise<string>
  /** read one back; null when missing */
  readSidecarAsset(pdfPath: string, name: string): Promise<Uint8Array | null>
  /**
   * Mobile only: copy a document into the app's own Library folder and return
   * the stable path. On desktop this is the identity function — a path there
   * already survives a relaunch.
   */
  importDocument(path: string): Promise<string>
  /** documents already imported (mobile shelf recovery) */
  listImported(): Promise<string[]>
  /**
   * Put bytes extracted from a document (an embedded attachment) where the
   * rest of the app can open them by path: an app-cache folder keyed by
   * content hash, so reopening the same attachment lands on the same path
   * (and keeps its reading position). `name` must be a safe bare file name.
   */
  stageFile(name: string, bytes: Uint8Array): Promise<string>
  /** hand a STAGED file to the OS default application (desktop only) */
  openStagedExternally(path: string): Promise<void>
  /**
   * "Save as…" for arbitrary bytes. Desktop: save dialog; phones: the app
   * Documents folder; web: a browser download. Returns where it went (a
   * file name for web downloads), or null when the user cancelled.
   */
  saveBytes(suggestedName: string, bytes: Uint8Array): Promise<string | null>
}

/**
 * Chunked PDF loading without HTTP.
 *
 *   pdf.js ──requestDataRange(begin,end)──▶ PlatformRangeTransport
 *                                             │ platform().readChunk()
 *                                             ▼
 *                                  Tauri invoke (ipc::Response binary)
 *                                  or vite dev server (HTTP Range)
 *
 * Why not a custom asset protocol: Tauri drops `content-range` from fetch
 * responses (tauri-apps/tauri#11371), which silently kills pdf.js streaming.
 * PDFDataRangeTransport bypasses wry's HTTP layer entirely.
 */
import { PDFDataRangeTransport } from 'pdfjs-dist'
import { platform } from '../platform'

/** pdf.js asks in ~64KB units; we serve bigger chunks to cut IPC round-trips. */
const CHUNK = 1 << 20 // 1 MiB

export class PlatformRangeTransport extends PDFDataRangeTransport {
  private aborted = false

  constructor(
    private path: string,
    length: number,
    initialData: Uint8Array,
  ) {
    super(length, initialData)
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.aborted) return
    const length = Math.max(end - begin, Math.min(CHUNK, (this as any).length - begin))
    platform()
      .readChunk(this.path, begin, length)
      .then((data) => {
        if (!this.aborted) this.onDataRange(begin, data)
      })
      .catch((err) => {
        console.error('readChunk failed', begin, end, err)
      })
  }

  override abort(): void {
    this.aborted = true
  }
}

/** Initial head read: enough for header + first page in most files. */
export const INITIAL_READ = 1 << 16 // 64 KiB

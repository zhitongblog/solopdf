// WebKit (WKWebView/Safari) still lacks ReadableStream async iteration,
// which pdf.js 5.x uses inside getTextContent() — without this polyfill the
// text layer and form layer silently die IN THE NATIVE APP ONLY (Chromium
// has the API, so browser E2E passes). Must run before any pdf.js import.
if (!(Symbol.asyncIterator in ReadableStream.prototype)) {
  ;(ReadableStream.prototype as any)[Symbol.asyncIterator] = function (this: ReadableStream) {
    const reader = this.getReader()
    return {
      next: () => reader.read(),
      return: (value?: unknown) => {
        reader.releaseLock()
        return Promise.resolve({ done: true as const, value })
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }
}

// last-resort visible error banner — mobile has no devtools console
window.addEventListener('error', (e) => showFatal(String(e.message)))
window.addEventListener('unhandledrejection', (e) => showFatal(String(e.reason)))
function showFatal(msg: string): void {
  if (document.getElementById('fatal-banner')) return
  const div = document.createElement('div')
  div.id = 'fatal-banner'
  div.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:9999;background:#c0392b;color:#fff;' +
    'font:12px/1.5 -apple-system,sans-serif;padding:8px 12px;word-break:break-all'
  div.textContent = 'Error: ' + msg
  document.body.appendChild(div)
}

import { createApp } from 'vue'
import App from './App.vue'
// official pdf.js styles — AnnotationLayer form widgets need these
import 'pdfjs-dist/web/pdf_viewer.css'
import './styles.css'

createApp(App).mount('#app')

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

import { createApp } from 'vue'
import App from './App.vue'
// official pdf.js styles — AnnotationLayer form widgets need these
import 'pdfjs-dist/web/pdf_viewer.css'
import './styles.css'

createApp(App).mount('#app')

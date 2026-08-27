// Shims first: pdf.js and everything downstream assume a recent browser.
// See src/shims.js — vite.config.ts injects the same file into the pdf.js
// worker bundle, which is a separate realm these would not otherwise reach.
import './shims.js'

// Last-resort visible error banner. A phone has no devtools console, so
// without this a fatal error is indistinguishable from a slow load — which is
// exactly how the Android WebView shim hunt started.
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

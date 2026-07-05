/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module 'pdfjs-dist/build/pdf.worker.mjs?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}

declare module 'pdfjs-dist/web/pdf_viewer.mjs' {
  export class SimpleLinkService {
    constructor()
  }
}

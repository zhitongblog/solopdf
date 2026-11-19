# SoloPDF v1.1.2 — macOS 原生 PDFKit 矢量打印、原生菜单栏与打印排版修复

SoloPDF **v1.1.2** 重构了 Apple 平台的 PDF 打印管线，并补齐 macOS 原生顶部菜单栏。

---

### 更新内容

- **macOS / iOS 原生矢量 PDF 打印**：
  - macOS 改为调用系统 `PDFKit`（`kPDFPrintPageScaleToFit` + `autoRotate`），输出与系统「预览」一致的矢量清晰度，彻底解决旧版 WKWebView 截图打印因非阻塞弹窗提前移除 `.print-overlay` 导致的错位与模糊问题。
  - 同步支持已编辑表单的实时字节流打印，并在 iOS 端接入 `UIPrintInteractionController`（AirPrint）。
- **macOS 原生顶部菜单栏**：
  - 新增标准 macOS 菜单项：**File**（Open… `⌘O`、Close Tab `⌘W`、Print… `⌘P`）、**Edit**（含 Find… `⌘F`）、**View**（Zoom In `⌘+`、Zoom Out `⌘-`、Fit Width `⌘0`、全屏）与 **SoloPDF → Settings…** (`⌘,`)。
- **WebView 打印兜底路径修复（Windows / Linux / 加密 PDF）**：
  - 修复 `@media print` 未隐藏 `#app` 及 `body` 高度锁死导致的整页下移问题，单页图片按 `max-height: 99.5vh` 等比居中缩放并去除末尾空白页。
  - 修复 `printViaOverlay` 在非阻塞打印时提前销毁 DOM 的竞态，改为在 `afterprint` 后清理。

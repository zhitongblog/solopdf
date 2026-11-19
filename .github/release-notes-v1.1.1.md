# SoloPDF v1.1.1 — 修复移动端/单页模式翻页、页码同步与布局切换

SoloPDF **v1.1.1** 是一个针对移动端（Android / iOS）与单页模式阅读体验的重点修复版本。

---

### 修复与改进

- **修复单页模式（`paged`）无法翻页与页码不同步**：
  - 修复 `PdfViewerController.scrollToPage()` 在单页模式下因 `scrollTop` 保持 `0` 不触发 `scroll` 事件导致新页面不渲染、页码停留在旧页的问题（涵盖工具栏 `‹`/`›`、恢复上次阅读进度、加载后跳转、`Home`/`End`、退出图书模式回到 PDF 等全部入口）。
  - 工具栏 `‹`/`›` 按钮改走 `turnPage()`，一并修复双页对开（`spread = 2`）模式下点 `›` 卡在当前跨页的问题。
- **补齐 PDF 单页模式触摸左右滑动翻页**：
  - 在 PDF 单页模式下支持单指左滑下一页、右滑上一页，自动避让多指缩放、文本选择、表单控件以及放大后的水平平移（仅在已到达左/右边缘时继续滑动才触发翻页）。
  - 移动端普通 PDF 页码输入框默认弹出数字键盘（`inputmode="numeric"` + `enterkeyhint="go"`）。
- **修复设置面板切换布局/双页对开不即时生效**：
  - 在设置面板中修改「连续滚动 / 单页翻页」、「单页 / 双页对开」、「封面独立」现在会立即同步到所有已打开标签页和分屏视口。
- **Android 与生态更新**：
  - 升级 Google Play Billing Client 至 `8.0.0`。
  - 补齐 MIT License、中/英/日 README、Glama Dockerfile、MCP Registry `server.json` 与 WinGet 清单。

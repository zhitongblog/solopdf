# SoloPDF

免费 · 无广告 · 本地化的跨平台 PDF 阅读器。**高亮即笔记**：你在 PDF 里划的每一条高亮，
自动保存为 Markdown 伴生文件——[SoloMD](https://solomd.app) 能打开、RAG 能搜索、git 能做版本管理。

solo 套件成员：SoloMD（Markdown）· SoloPDF（PDF）——两个独立应用，通过 Markdown 文件互操作。

## 为什么

Windows 上的 PDF 阅读器要么弹广告（Adobe/福昕/WPS），要么只能用 Edge 凑合。
SoloPDF：秒开、零广告、零遥测（更新检查可完全关闭）、永远免费。

## 核心功能

- **高亮 → `.annotations.md`**：批注含页码深链（`solopdf://`），点击跳回原文精确位置；
  三重锚定（文字指纹 > 页码+坐标），PDF 更新后高亮自动重定位，失效则灰显降级、正文永不丢
- **在 SoloMD 里改批注**：伴生文件是普通 Markdown，外部编辑窗口焦点回来即生效
- 大文件流式加载：157MB / 1048 页冷启动 ~1s，虚拟滚动内存恒定
- 全文搜索（CJK 友好，NFKC 归一化——连 Skia 导出 PDF 的康熙部首码位坑都处理了）
- 目录树 / 缩略图 / 多标签 / 阅读位置记忆（文件移动后靠内容哈希找回）
- 暗色模式智能反色（纯文字页反色，含图片页保持原样）
- 加密 PDF：会话内记住密码；批注可选"仅存批注不存原文摘录"隐私模式
- 扫描版无文字层自动提示并禁用高亮
- 打印（分批渲染，500 页不爆内存）

## 结构

```
app/       Tauri 2 + Vue 3 桌面应用
core/      共享逻辑：伴生文件格式 + 锚定算法（app 与 CLI 同一实现）
cli/       solopdf 命令行（与应用同一 pdf.js 引擎）
dev-mcp/   MCP server（AI/自动化驱动接口）
test-fixtures/  标准测试集（7 个真实样本，见其 README）
```

## CLI

```bash
node cli/src/index.mjs info <file.pdf> [--password pw]      # 页数/书签/元数据
node cli/src/index.mjs extract-text <file.pdf> [--pages A-B]
node cli/src/index.mjs export-annotations <file.pdf>        # 伴生批注 → JSON
node cli/src/index.mjs selftest test-fixtures               # 标准测试集验收
```

## MCP

```bash
claude mcp add solopdf -- node /path/to/pdf/dev-mcp/src/index.mjs
# 写操作（追加批注）需显式开启：
claude mcp add solopdf -- node /path/to/pdf/dev-mcp/src/index.mjs --allow-write
```

工具：`solopdf_info` / `solopdf_extract_text` / `solopdf_search` /
`solopdf_read_annotations` / `solopdf_add_annotation`（写门控）。

## 开发

```bash
pnpm install
pnpm --filter @solopdf/core build   # CLI/MCP 依赖的共享模块
pnpm --filter @solopdf/core test    # 21 项单元测试
pnpm dev                            # 浏览器模式（vite + fixtures API，供 E2E）
pnpm tauri dev                      # 桌面应用
pnpm tauri build                    # 打包
```

## 伴生文件格式

```markdown
# 《文档名》批注
<!-- solopdf:meta v1 name=... -->

## p.23 — 高亮 <!-- solopdf:id a1b2c3 -->
> 被高亮的原文
你的批注（可在任何编辑器里改，SoloPDF 不会覆盖）
[跳回原文](solopdf://open?file=...&page=23&annot=a1b2c3)
<!-- solopdf:anchor a1b2c3 {"page":23,...} -->
```

规则：SoloPDF 只按 anchor id 定位替换/追加，从不整文件重写；
删掉 anchor 注释行 = 该条降级为纯笔记；正文随便改。

## License

MIT

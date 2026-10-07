# SoloPDF 0.8.0 — 导入别人的批注、比较两版文档、FB2 / TIFF、问 AI

又对照 Zotero、PDF Expert、Acrobat、Okular、Skim、SumatraPDF 比了一轮，把剩下的差距补上。

## 该下载哪个

| 系统 | 文件 |
| --- | --- |
| macOS（Apple Silicon 与 Intel 通用） | `SoloPDF_0.8.0_universal.dmg` — 已公证，下载后直接打开 |
| Windows x64 | `SoloPDF_0.8.0_x64-setup.exe`（或 `_x64_en-US.msi`） |
| Windows ARM64 | `SoloPDF_0.8.0_arm64-setup.exe`（或 `_arm64_en-US.msi`） |
| Linux x64 | `SoloPDF_0.8.0_amd64.deb` / `SoloPDF_0.8.0_amd64.AppImage` |
| Linux ARM64 | `SoloPDF_0.8.0_arm64.deb` / `SoloPDF_0.8.0_aarch64.AppImage` |
| Android | `app-universal-release.apk`（已签名） |

## 批注

- **导入其他应用留下的注释**：在 Acrobat、预览、PDF Expert、Zotero、福昕里做的高亮、下划线、删除线、波浪线、便签（含回复）、文本框、手绘、矩形、椭圆、直线 / 箭头，打开时提示「导入到笔记」，一键转成 SoloPDF 批注写进 `.annotations.md`。作者、日期、原文摘录都保留，PDF 本身不改；整次导入一步 ⌘Z 撤销，重复导入不会重复。

## 文档

- **附件**：PDF 里嵌的文件和页面上的回形针都列在「附件」侧栏。PDF / EPUB / 图片直接在新标签打开，其他类型交给系统；可执行文件只能另存，不会打开。
- **图层**：工程图、地图类 PDF 的「图层」侧栏，按文档规则处理单选组和锁定图层；分屏、缩略图、打印都跟随当前开关，每个文档单独记住。
- **两个文档并排**：分屏右边可以放另一份已打开的文档（视图菜单、标签右键，或把标签拖到右半边），可同步滚动。
- **比较两版**：按页对齐（中间插了一页也不会让后面全部错位），逐词（中文逐字）标出新增、删除、修改，侧栏列出全部差异可逐条跳转。没有文字层的扫描页会单独提示先 OCR。

## 阅读

- **阅读标尺**（L）：只亮当前 1 / 3 / 5 行，其余调暗；↑↓ 或 j/k 按分栏顺序逐行走，双栏论文先读完左栏。PDF 和图书模式都能用，手机上拖动把手。
- **放大镜**（桌面）：按住 Z 悬停在页面上，2–4 倍高清重新渲染。
- **复制引用**：识别标题、作者、年份、DOI、arXiv 号，复制 BibTeX / APA / GB/T 7714，字段可以先改再复制。只有点「获取精确元数据」才会联网查 doi.org。

## 格式

- **FB2**（.fb2 / .fbz / .fb2.zip）：走 EPUB 同一个图书视图，自动识别 windows-1251、KOI8-R 等编码，目录、插图、高亮、朗读都能用。
- **多页 TIFF**：传真（CCITT G3/G4）、LZW、Deflate、JPEG 等压缩方式，可翻页、旋转、缩放，桌面版可对当前页 OCR。
- 漫画 / DjVu / TIFF 的图片页视图可以缩放了；EPUB / MOBI / FB2 加了书内搜索（⌘F）。

## 问 AI（默认关闭）

- 右侧面板（⌘J，手机为底部抽屉）：总结全文、总结本页 / 本章、自由提问，选中文字可以让 AI 解释。
- 只把和问题最相关的几段原文连同页码发给模型，不发整本书；回答里的 [p.N] 点了跳回原文，可以存成笔记。
- **需要你在设置里自己配服务**：本机的 Ollama / LM Studio 不用密钥、文字不离开电脑；也可以填任意 OpenAI 兼容的在线服务。第一次用某个服务前会明确提示文字会发到哪里。

## CLI / MCP

新命令：`import-annotations`、`attachments`、`layers`、`compare`、`cite`、`ask`、`summarize`、`retrieve`；`info` / `extract-text` 支持 FB2 和 TIFF。
MCP 新增 `solopdf_pdf_annotations`、`solopdf_attachments`、`solopdf_layers`、`solopdf_compare`、`solopdf_cite`、`solopdf_retrieve`（只读），以及 `solopdf_import_annotations`、`solopdf_extract_attachment`（需 `--allow-write`）。

## 已知限制

- 触控屏上拖动阅读标尺、捏合缩放图片页还没在真机上手动回归
- AI 只用模拟服务做过端到端测试，接真实模型时回答质量取决于你选的模型
- 打开附件里的「其他类型」文件在手机上改为保存到「文稿」（系统不支持直接交给别的 app 打开）

完整改动见 [CHANGELOG](https://github.com/zhitongblog/solopdf/blob/v0.8.0/CHANGELOG.md)。

# SoloPDF

官网：https://solopdf.doaipm.com · GitHub：https://github.com/zhitongblog/solopdf

免费 · 无广告 · 本地化的跨平台 PDF 阅读器。**高亮即笔记**：你在 PDF 里划的每一条高亮，
自动保存为 Markdown 伴生文件——[SoloMD](https://solomd.app) 能打开、RAG 能搜索、git 能做版本管理。

solo 套件成员：SoloMD（Markdown）· SoloPDF（PDF）——两个独立应用，通过 Markdown 文件互操作。

## 为什么

Windows 上的 PDF 阅读器要么弹广告（Adobe/福昕/WPS），要么只能用 Edge 凑合。
SoloPDF：秒开、零广告、零遥测（更新检查可完全关闭）、永远免费。

## 核心功能（v0.6）

- **高亮 → `.annotations.md`**：批注含页码深链（`solopdf://`），点击跳回原文精确位置；
  三重锚定（文字指纹 > 页码+坐标），PDF 更新后高亮自动重定位，失效则灰显降级、正文永不丢
- **在 SoloMD 里改批注**：伴生文件是普通 Markdown，外部编辑窗口焦点回来即生效
- 大文件流式加载：157MB / 1048 页冷启动 ~1s，虚拟滚动内存恒定
- 全文搜索（CJK 友好，NFKC 归一化——连 Skia 导出 PDF 的康熙部首码位坑都处理了）
- 目录树 / 缩略图 / 书签 / 多标签 / 阅读位置记忆（文件移动后靠内容哈希找回）
- **标注不只有高亮**：下划线 / 删除线 / 波浪线 / 便签图钉 /
  **框选截图**（截图存进 `<文档名>.annotations.assets/`，伴生 MD 里以
  `![](…)` 引用——SoloMD、GitHub、任何 Markdown 阅读器都直接显示图）
- **导出带标准 PDF 注释的副本**：把伴生文件里的标注写成真正的 PDF 注释，
  Preview / Acrobat / 福昕都能看到（原文件永不修改）
- **视图**：整档或单页旋转（工具栏一键）、单页 / 双页对开、连续滚动 / 单屏翻页、
  自动裁白边（移动端读双栏论文的关键）、纸张颜色、分屏（同一文档两个视口）、
  全屏阅读与演示模式、自动滚动、阅读时屏幕常亮
- **导航**：PDF 超链接可点（精确落点）、前进/后退、链接与 Figure/Table/[12]
  智能引用的悬停预览（没有链接的论文也行）、印刷页码（xii、A-3）
- **手绘与图形**：画笔 / 橡皮 / 文本框 / 矩形 / 椭圆 / 直线 / 箭头，支持触控笔压感；
  **撤销 / 重做**覆盖所有批注操作
- **选区翻译**：Apple 平台用系统本机翻译（不联网），其他平台可自配服务
- **朗读**：调用系统语音，句子级跟随高亮并自动翻页，零体积零联网
- **离线词典**：内置 CC-CEDICT（12 万词条，4MB），中文按最长前缀匹配；
  macOS/iOS 另可直接唤起系统词典
- **书架**：封面网格、阅读进度、收藏、标签、跨文档全文搜索（批注即时、
  正文按需建索引）
- **阅读统计**：时长、连续天数、每本书进度——只存本机，可一键清空/导出
- **文档工具**：页面管理（旋转/删除/提取/重排）、合并、拆分、
  PDF ↔ 图片、压缩、手写签名与日期戳、设置/移除打开密码
- 暗色模式智能反色（纯文字页反色，含图片页保持原样）
- 加密 PDF：会话内记住密码；批注可选"仅存批注不存原文摘录"隐私模式
- 扫描版无文字层自动提示并禁用高亮
- **OCR 文字识别（全本地，不联网）**：扫描件/图片型 PDF 一键识别 →
  **可搜索 PDF**（隐形文字层，可选中/复制/搜索/高亮批注）或 **Markdown**；
  也支持直接打开图片转文字（iOS 上可拍照识别）。
  引擎:macOS/iOS 用系统 Vision(零体积),Windows/Linux 内置 PP-OCRv4 ONNX(离线模型)
- **表单填写**：AcroForm 文本框/勾选/下拉直接填写，"保存已填表单"导出副本（原文件永不改动）
- 打印（分批渲染，500 页不爆内存）
- **格式**：PDF · EPUB · TXT · MOBI/AZW3 · CBZ/CBR 漫画 · DjVu

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
node cli/src/index.mjs links <file.pdf> [--pages A-B]       # 超链接 → JSON
node cli/src/index.mjs translate "text" [--to zh-Hans]      # 本机翻译（macOS）
node cli/src/index.mjs export-annotations <file.pdf>        # 伴生批注 → JSON
node cli/src/index.mjs annotate <file.pdf> --out x.pdf      # 伴生批注 → 标准 PDF 注释
node cli/src/index.mjs to-images <file.pdf> --out-dir d     # 页面 → PNG/JPEG
node cli/src/index.mjs search <dir> <query>                 # 跨文件搜索
node cli/src/index.mjs dict 汉字                             # 内置离线词典
node cli/src/index.mjs ocr scan.pdf --out scan-ocr.pdf      # 本地 OCR → 可搜索 PDF
node cli/src/index.mjs ocr scan.pdf --out scan.md           # 本地 OCR → Markdown
node cli/src/index.mjs ocr photo.jpg                        # 图片 → 文字（stdout）
node cli/src/index.mjs selftest test-fixtures               # 标准测试集验收

# 文档操作（转发给原生驱动 solopdf-doc，全部写新文件）
node cli/src/index.mjs doc pages a.pdf out.pdf --keep 1,3-5 --rotate 90
node cli/src/index.mjs doc merge out.pdf a.pdf b.pdf
node cli/src/index.mjs doc split a.pdf outdir --ranges 1-3,4-10
node cli/src/index.mjs doc compress a.pdf out.pdf --max-dim 1600 --quality 72
node cli/src/index.mjs doc protect a.pdf out.pdf --password pw
node cli/src/index.mjs doc unprotect a.pdf out.pdf --password pw
node cli/src/index.mjs doc djvu-page a.djvu p1.png --page 1
```

原生驱动有两个：`solopdf-doc`（页面/合并/拆分/标注/压缩/加密/DjVu）和
`solopdf-ocr`（`cargo build --bin solopdf-ocr`，位于
`app/src-tauri`）：`image` 子命令输出识别行（`--json` 带坐标），`overlay`
把结果注入为隐形文字层（tesseract 同款 GlyphLessFont 方案，CJK 复制/搜索
无需内嵌大字体）。macOS/iOS 走系统 Vision；Windows/Linux 走内置
PP-OCRv4 ONNX（`assets/ppocr/`，可用 `SOLOPDF_PPOCR_DIR` 覆盖）。

## MCP

```bash
claude mcp add solopdf -- node /path/to/pdf/dev-mcp/src/index.mjs
# 写操作（追加批注）需显式开启：
claude mcp add solopdf -- node /path/to/pdf/dev-mcp/src/index.mjs --allow-write
```

只读工具：`solopdf_info` / `solopdf_extract_text` / `solopdf_search` /
`solopdf_search_library`（跨文件夹）/ `solopdf_read_annotations` /
`solopdf_page_image` / `solopdf_define`（离线词典）/ `solopdf_links` /
`solopdf_translate`。

写门控（`--allow-write`）：`solopdf_add_annotation` /
`solopdf_export_annotated_pdf` / `solopdf_pages` / `solopdf_merge`。

## 开发

```bash
pnpm install
pnpm --filter @solopdf/core build   # CLI/MCP 依赖的共享模块
pnpm --filter @solopdf/core test    # core 单元测试
cargo test --lib --manifest-path app/src-tauri/Cargo.toml   # pdfops / djvu 测试
node scripts/check-i18n.mjs         # 四语言文案完整性
pnpm dev                            # 浏览器模式（vite + fixtures API，供 E2E）
pnpm tauri dev                      # 桌面应用
pnpm tauri build                    # 打包
scripts/build-dmg.sh                # macOS universal dmg（有签名凭据时顺带公证）
scripts/build-android.sh            # Android debug APK（release 需自备 keystore）
scripts/build-ios.sh                # iOS ipa
scripts/build-mas.sh                # Mac App Store pkg
```

发布产物覆盖的架构：macOS 单个 universal dmg（Apple Silicon + Intel）、
Windows ARM64 与 x64（NSIS + MSI）、Linux ARM64 与 x64（deb + AppImage）、
Android 四 ABI。CI（`.github/workflows/build.yml`）在推 `v*` tag 时全部构建。

内置词典由 CC-CEDICT 生成，需要重建时：

```bash
node scripts/build-dict.mjs path/to/cedict_ts.u8   # → app/public/dict/*.dic
```

第三方组件与许可证见 [NOTICE.md](NOTICE.md)。

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

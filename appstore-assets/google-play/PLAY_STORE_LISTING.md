# SoloPDF v1.1.0 — Google Play Console 提审清单与商店文案

## 1. 上传软件包（App Bundle）
- **Application ID**: `app.solopdf`
- **AAB 路径**: `dist-android/SoloPDF_1.1.0.aab`（满足 Android 15+ 要求的 16 KB ELF 页面对齐 `-Wl,-z,max-page-size=16384`，并已升级 Google Play Billing Client `8.0.0`）
- **通用 APK 路径**: `dist-android/SoloPDF_1.1.0_universal.apk`

## 2. 版本更新说明（What's New in v1.1.0，≤500 字符）

### 简体中文 (`zh-CN`)
```text
SoloPDF v1.1.0 更新：
• 扫描件精修闭环：新增扫描自动纠偏去黑边（Auto-Deskew）与 Sauvola 自适应黑白二值化，一键消除手机拍照阴影
• 视觉级闪烁对比：新增红/青像素叠印差分、变动热点框选与 A↔B 闪烁对比，扫描合同与图纸微调一目了然
• 学术公式与综述：支持框选区域识别数学公式转 LaTeX，支持跨文档聚合 #标签 批注导出 Markdown 文献综述
• 批量自动化流水线：扩展至 17 步内存流水线（5 大场景预设），支持多文件批量处理与智能重命名
```

### English (`en-US`)
```text
What's New in SoloPDF v1.1.0:
• Scan Mastery: Auto-Deskew & border cleanup + Sauvola adaptive B&W binarization to remove camera shadows in one tap
• Visual Blink Diff: Red/Cyan pixel overlay, change hotspots & A/B Blink Compare for scanned contracts and drawings
• Math Snip & Literature Digest: Snip formulas to LaTeX ($...$) and aggregate #tag notes across PDFs into a Markdown review
• 17-Step Batch Pipeline: Multi-file batch queue, 5 presets, smart auto-rename & embedded attachment manager
```

## 3. 图形素材（位于 `appstore-assets/google-play/`）
- **应用图标（512 × 512 PNG）**: `appstore-assets/google-play/icon-512.png`
- **置顶大图 Feature Graphic（1024 × 500 PNG）**:
  - 中文：`appstore-assets/google-play/feature-graphic-zh.png`
  - 英文：`appstore-assets/google-play/feature-graphic.png`
- **手机与平板截图**: `appstore-assets/google-play/screenshots/`

---

## 4. 应用内商品（Monetize -> Products -> In-app products）

在 Google Play Console 创建以下 **3 个一次性商品（One-time products）**：

| Product ID | 默认价格 | 中文名称 (`zh-CN`) | 中文描述 (`zh-CN`) | 英文名称 (`en-US`) | 英文描述 (`en-US`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `app.solopdf.tip.coffee` | `$0.99` / `¥8` | 请喝杯咖啡 | 为深夜写代码的开发者添一杯热咖啡，永久点亮「支持者」徽章。 | Buy a Coffee | Fuel a late-night coding session and unlock the Supporter badge. |
| `app.solopdf.tip.meal` | `$2.99` / `¥28` | 请吃顿工作餐 | 支持 SoloPDF 持续打磨全平台体验，永久点亮「支持者」徽章。 | Buy a Lunch | Support cross-platform polish and unlock the Supporter badge. |
| `app.solopdf.tip.feast` | `$9.99` / `¥68` | 强力支持 | 支持 SoloPDF 保持免费无广告与独立开发，永久点亮「支持者」徽章。 | Generous Support | Champion free, ad-free independent development and unlock the Supporter badge. |

---

## 5. 多语言商店资料（Main Store Listing）

### 简体中文 (`zh-CN`)
- **应用名称（≤30 字符）**：`SoloPDF - 本地 PDF 阅读与批注`
- **简短描述（≤80 字符）**：
  `免费无广告的本地 PDF 阅读器与全离线工具箱——你在 PDF 里划的高亮自动保存为 Markdown 笔记。`
- **完整描述（≤4000 字符）**：
```text
SoloPDF 是一款干净、快速、完全本地运行的跨平台 PDF 阅读器与全离线文档工具箱 —— 零广告、无需注册账号、不上传任何文档数据。

【高亮即 Markdown 笔记】
• 在 PDF 里划的每一条高亮、下划线、便签、框选截图与手绘，自动保存为同目录下的伴生 Markdown 文件（.annotations.md）。
• 用 SoloMD、Obsidian、VS Code 或任何编辑器都能直接打开、编辑、做 Git 版本管理；点击笔记里的 solopdf:// 链接即可跳回原文精确位置。
• 支持导入 Acrobat、预览、PDF Expert、Zotero 等其他应用留在 PDF 里的注释，也支持把伴生批注导出为标准 PDF 注释副本。

【学术阅读与知识管理】
• 公式与表格框选识别：在页面上框选任意区域，一键还原为 LaTeX 数学公式或 Markdown / CSV 表格。
• 跨文档综述与闪卡导出：支持按颜色、类型、#标签筛选批注，支持聚合多篇论文批注生成 Markdown 文献综述，或一键导出为 Anki (.tsv) / Obsidian 复习闪卡。
• 阅读辅助：自动裁切双栏论文白边、阅读标尺（行聚焦，按分栏顺序逐行移动）、引用导出（BibTeX / APA / GB/T 7714）、内置离线中英词典（CC-CEDICT）。
• 多格式支持：PDF、EPUB、MOBI/AZW3、FB2、TXT、CBZ/CBR 漫画、DjVu、多页 TIFF。

【全离线文档工具箱（严格遵循 Copy-out 原则，原文件永不修改）】
• 17 步批量流水线与扫描精修：扫描件自动纠偏去黑边（Auto-Deskew）、Sauvola 局部自适应黑白二值化（彻底消除拍照阴影）、双页扫描中缝切分、空白页检测清理、多文件批量处理与智能重命名。
• 合同与图纸对比：支持词级文字差异对比，以及像素级红/青叠印与 A↔B 闪烁切换对比（Blink Diff）。
• 目录书签与拼版印前：目录智能生成与编辑、N-up 多页合一拼版（2/4/6/9/16 页）、小册子骑马钉对折拼版（Booklet）、PDF 转灰度与底色漂白、统一页面尺寸（A4/A3/Letter）。
• 水印、图章与比例尺测量：中英文平铺水印、透明 PNG 水印、Bates 编号；内置 8 款多语言矢量印章与动态日期署名公章；支持标定比例尺测量距离、周长与面积。
• 安全、脱敏与数字签名：AES-256 密码保护、密文涂黑真脱敏（Redact，底层剔除文字流）、元数据清理（Sanitize）、表单填写与扁平化（Flatten）、X.509 / PKCS#7 数字证书验签与签名。

【支持独立开发（可选）】
SoloPDF 的所有功能 100% 永久免费、无广告。应用内提供三档一次性自愿打赏（请喝杯咖啡 / 请吃顿工作餐 / 强力支持，非自动续费订阅），支持任意一档即可永久点亮专属「✨ 支持者」徽章。
```

### English (`en-US`)
- **App Name (≤30 chars)**: `SoloPDF - PDF Reader & Notes`
- **Short Description (≤80 chars)**:
  `Ad-free local PDF reader & offline toolkit — highlights become Markdown notes.`
- **Full Description (≤4000 chars)**:
```text
SoloPDF is a fast, clean, local-first PDF reader and offline document toolkit — zero ads, no account required, and your files never leave your device.

[Highlights Become Markdown Notes]
• Every highlight, underline, sticky note, region snip, and freehand drawing is saved in a plain-text companion Markdown file (.annotations.md) right next to your PDF.
• Open, edit, search, and version-control your notes with SoloMD, Obsidian, VS Code, or Git. Tap any solopdf:// deep link in your notes to jump straight back to the exact passage.
• One-click import of existing PDF annotations from Acrobat, Preview, PDF Expert, or Zotero, and copy-out export back to standard PDF annotations.

[Academic & Study Superpowers]
• Math & Table Snip: drag a box around any equation or table to copy clean LaTeX ($...$ / $$...$$), Markdown tables, or CSV.
• Topic Digest & Flashcards: filter annotations by #tag, color, or type; synthesize notes across multiple papers into a Cross-PDF Topic Digest; export study cards to Anki (.tsv) or Obsidian Spaced Repetition (.md).
• Reading Aids: auto-crop two-column paper margins, column-aware Reading Ruler, citation generator (BibTeX / APA / GB/T 7714), built-in offline Chinese-English dictionary.
• Multi-Format: PDF, EPUB, MOBI/AZW3, FB2, TXT, CBZ/CBR comics, DjVu, and multi-page TIFF.

[Complete Offline Document Toolkit (Copy-out — Original Files Never Modified)]
• Scan Mastery & 17-Step Batch Pipeline: Auto-Deskew & border cleanup, Sauvola adaptive B&W binarization (eliminates camera shadows), 2-up scan split, blank page removal, multi-file batch queue, and smart auto-rename.
• Text & Visual Blink Compare: side-by-side text diff plus pixel Red/Cyan overlay and A/B Blink Compare for scanned contracts and CAD drawings.
• Outlines & Print Imposition: smart outline generator & visual editor, N-up multi-page layout (2/4/6/9/16), saddle-stitch Booklet maker, Grayscale whitening, and Page Size Normalization (A4/A3/Letter).
• Watermarks, Stamps & Scale Measurement: CJK text/PNG watermarks, Bates numbering, 8 localized vector stamps + dynamic author/date stamps, and calibrated scale ruler for distance, perimeter, and polygon area.
• Security, Redaction & Digital Signatures: AES-256 encryption, true content-stream Redaction, metadata Sanitization, AcroForm filling & Flattening, and X.509 / PKCS#7 digital signature verification & signing.

[Optional Supporter Tip Jar]
100% of SoloPDF features are free forever with no ads. Three optional one-time tip tiers (Buy a Coffee / Buy a Lunch / Generous Support, non-renewing) unlock the "✨ Supporter" badge.
```

---

## 6. Google Play 数据安全（Data Safety）与审核说明
- **是否收集或分享任何用户数据？**：**否（No）**。SoloPDF 所有文档解析、批注、OCR 与工具处理均在设备本地离线完成，不包含任何第三方统计或广告 SDK。
- **应用访问权限（App Access）**：无需登录账号，所有功能直接可用。

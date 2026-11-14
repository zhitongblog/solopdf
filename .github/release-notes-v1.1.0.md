# SoloPDF v1.1.0 — 扫描件精修闭环、视觉叠印/闪烁对比、公式转 LaTeX、跨文档专题综述与批量流水线

SoloPDF **v1.1.0** 正式发布！本版本在 v1.0.0 基础上一次性完成 **Stirling-PDF 核心套件** 与 **四大深度演进方向（扫描件精修闭环 / 视觉级页面对比 / 学术公式与跨文档综述 / 多文件批量流水线）**，全部基于纯 Rust（`lopdf` + `image`）与 `@solopdf/core` 零外部依赖本地实现，严格恪守 **Copy-out 源文件只读铁律**，桌面端、移动端、CLI 与 MCP Server 四端同步贯通。

---

### 1. 扫描件精修闭环（Scan Mastery Phase 2）
- **扫描件自动纠偏与黑边清理（`deskew` / Auto-Deskew）**：通过 `[-max_angle, +max_angle]` 水平投影轮廓方差最大化（`0.5°` 粗搜 + `0.1°` 精搜）自动检测扫描倾斜角，双线性插值旋转扶正，并自动裁除四周扫描仪阴影黑框（`clean_borders`）
- **自适应黑白二值化（`binarize` / Sauvola Adaptive Thresholding）**：使用二维积分图（`sum` 与 `sq_sum`）加速的 $O(1)$ 局部均值与标准差阈值算法，彻底消除手机拍照阴影与底色不均，输出高对比度锐利黑白 PDF（`DeviceGray`）
- **双页扫描中缝切分（`split-2up` / De-nup）**：将双页连扫的教材/古籍跨页一键无损切分为独立单页，支持自动跳过单页封面（`onlyWide`）、古籍/日漫从右到左页序（`rtl`）与中缝重叠保留（`overlap`）
- **多页拼接为单张连续长页（`single-page`）**：将所有页面垂直无缝拼接为 1 页超长连续矢量 PDF（`/Form XObject`）
- **空白页智能检测与清理（`detect-blank` / `remove-blank`）**：同时检测空内容流与纯白扫描页墨迹占比
- **PDF 矢量叠印 / 套红头信纸（`overlay`）**：将另一份 PDF 作为背景信纸或前景印章层矢量循环叠加

### 2. 视觉级页面对比（Visual Overlay & Blink Compare）
- **像素级红/青叠印差分（Red/Cyan Anaglyph Overlay）**：针对无文字层的扫描件、CAD 工程图纸、公章与排版微调，逐像素比对两页渲染图像（红色 = 旧版独有墨迹，青色 = 新版新增墨迹，中性灰 = 未变区域，或切换为 `tint` 差异高亮着色）
- **16×16 连通域变动热点框选与像素差异率（`Δ X.XX%`）**：自动聚类标出所有视觉变动区域
- **闪烁切换对比（Blink Compare A ↔ B）**：支持在对比面板一键开启视觉对比弹窗，交替闪烁旧版/新版页面，肉眼瞬间捕捉细微位移

### 3. 学术阅读与 SoloMD 深度互操作（Math LaTeX & Topic Digest）
- **框选公式转 LaTeX（`extract-math` / `$LaTeX$`）**：在区域框选工具栏新增 `∑ 复制公式 ($LaTeX$)` 与 `$$ 复制行间公式 ($$)`，基于基线偏移与字号几何关系自动还原上下标（`x^{2n}`、`a_{ij}`）、双行分式（`\frac{num}{den}`）、根号与全套希腊字母/微积分符号
- **跨文档 `#标签` 专题综述导出（`export-digest` → SoloMD）**：聚合多篇已打开 PDF 或整个文件夹的 `.annotations.md` 伴生批注，按 `#标签` 或按文档分组，自动生成含目录（TOC）、原文摘录、笔记、截图与 `solopdf://` 页码深链的 Markdown 文献综述

### 4. 自动化多步流水线与多文件批量处理（Pipeline & Batch Queue）
- **17 步内存流水线（`pipeline`）**：在内存中串联执行去空白页、自动纠偏、Sauvola 二值化、双页切分、灰度漂白、统一尺寸、水印、页码、扁平化、清理隐私、图像压缩等操作，内置「扫描件整理」「高清黑白扫描」「保密外发」「打印讲义」「归档瘦身」5 大预设
- **多文件批量流水线（`batch-pipeline`）**：一次选择多个 PDF 批量执行流水线并输出到指定目录
- **智能自动重命名（`auto-rename`）**与**文档级内嵌附件读写管理（`attachments-list/add/remove`）**

---

### CLI & MCP 新增接口
- **CLI**:
  - `solopdf extract-math <file.pdf> [--page 1] [--rect x,y,w,h] [--block] [--json]`
  - `solopdf export-digest <dir-or-files...> [--group-by tag|document] [--tag t1,t2] [--out digest.md]`
  - `solopdf visual-diff <old.pdf> <new.pdf> [--page 1] [--mode anaglyph|tint|diff-only] [--out diff.png]`
  - `solopdf doc deskew | binarize | batch-pipeline | split-2up | single-page | detect-blank | remove-blank | overlay | attachments-list | attachments-add | attachments-remove | pipeline`
- **MCP**:
  - 只读：`solopdf_extract_math`、`solopdf_export_digest`、`solopdf_visual_diff`、`solopdf_auto_rename`、`solopdf_detect_blank_pages`
  - 写门控（`--allow-write`）：`solopdf_deskew`、`solopdf_binarize`、`solopdf_batch_pipeline`、`solopdf_pipeline`、`solopdf_split_2up`、`solopdf_single_page`、`solopdf_remove_blank_pages`、`solopdf_overlay`、`solopdf_add_attachments`、`solopdf_remove_attachments`

# SoloPDF 0.9.0 — 水印、页码与 Bates、永久裁切、书签拆分、无损原图提取、结构化 Markdown、真脱敏与扁平化

对照 iLovePDF 等高频本地文档处理需求，补齐 10 项全离线文档工具。所有写操作均严格遵循 SoloPDF 的 **Copy-out 铁律**（读取源文件并输出新文件，源文件永不修改），且全部在桌面/移动 UI、CLI、MCP 四端同步贯通。

## 该下载哪个

| 系统 | 文件 |
| --- | --- |
| macOS（Apple Silicon 与 Intel 通用） | `SoloPDF_0.9.0_universal.dmg` — 已公证，下载后直接打开 |
| Windows x64 | `SoloPDF_0.9.0_x64-setup.exe`（或 `_x64_en-US.msi`） |
| Windows ARM64 | `SoloPDF_0.9.0_arm64-setup.exe`（或 `_arm64_en-US.msi`） |
| Linux x64 | `SoloPDF_0.9.0_amd64.deb` / `SoloPDF_0.9.0_amd64.AppImage` |
| Linux ARM64 | `SoloPDF_0.9.0_arm64.deb` / `SoloPDF_0.9.0_aarch64.AppImage` |
| Android | `app-universal-release.apk`（已签名） |

## 编辑与烙印

- **添加水印（Watermark PDF）**：支持文字水印（原生支持中文/CJK、字号、颜色、不透明度、旋转角度、九宫格位置、满页平铺 `tile`、置于正文下方 `under`）与 PNG 图片水印（含 Alpha 透明通道 SMask、缩放比例），可指定页码范围。
- **页码与 Bates 编号（Page Numbers）**：支持 `{n}`、`{n} / {total}`、`第 {n} 页` 及 Bates 编号格式（如 `DOC-{n:06}`）；支持 6 个标准位置及书籍装订奇偶页外侧对齐（`bottom-outside` / `top-outside`）。

## 页面与拆分增强

- **永久裁切页面（Crop PDF）**：同时更新 `/CropBox` 与 `/MediaBox`；支持**一键自动检测全书白边**（文字层边界 + 扫描件画布像素墨迹边界兜底）并自动填入安全裁切边距，支持奇偶页独立边距（对称装订线）。
- **插入空白页 & 复制页面**：在页面管理网格中一键在当前选中页后插入同尺寸空白页或复制选中页。
- **按书签章节拆分 & 按份数均分（Split+）**：自动解析一级 / 二级 PDF 目录书签，按章节页码区间批量拆分为独立 PDF（可选包含首页至第一章前的前言）；新增按固定份数均匀拆分。

## 转换与提取

- **无损提取内嵌原图（Extract Embedded Images）**：从 PDF `/XObject` 直接无损提取原始图片（JPEG 直出、Flate RGB/Gray + `/SMask` 合成 PNG），支持最小边长像素过滤排除小图标。
- **原生 PDF 转结构化 Markdown（PDF → MD）**：结合目录书签与字号梯度识别多级标题（`#`–`######`），保留项目符号/编号列表，自动检测对齐的多列单元格并还原为标准 Markdown 表格（`| A | B |`）。

## 安全与隐私

- **密文涂黑真脱敏（Redact PDF）**：内置手机号、邮箱、二代身份证号、银行卡号、IPv4 正则预设及自定义敏感词/正则扫描；从 PDF 底层内容流中**彻底剔除命中的文字指令**并绘制不透明黑框 + 抹除文档元数据，不可逆、不可复制。
- **隐私与元数据清理（Sanitize PDF）**：一键抹除 `/Info`、`/Metadata`（XMP）、`/PieceInfo`、JavaScript 脚本与自动动作（`/OpenAction` / `/AA` / `/JS`），可选同时移除所有注释、内嵌附件与交互式表单。
- **扁平化 PDF（Flatten PDF）**：将批注、签名与表单外观流（`/AP /N`）烘焙固化到页面正文内容流中并移除可编辑控件，防止二次修改。

## CLI / MCP

- `solopdf` 新增 `auto-crop`、`split-bookmarks`、`redact-text`，并升级 `export-md`（结构化表格/列表/标题还原）；`solopdf doc` 新增 `watermark`、`page-numbers`、`crop`、`extract-images`、`sanitize`、`flatten`、`redact` 子命令。
- MCP 新增 `solopdf_export_markdown`（只读），以及 `solopdf_watermark`、`solopdf_page_numbers`、`solopdf_crop`、`solopdf_split_by_bookmarks`、`solopdf_extract_images`、`solopdf_sanitize`、`solopdf_flatten`、`solopdf_redact`、`solopdf_redact_by_text`（需 `--allow-write`）。

完整改动见 [CHANGELOG](https://github.com/zhitongblog/solopdf/blob/v0.9.0/CHANGELOG.md)。

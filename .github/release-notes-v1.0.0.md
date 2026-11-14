# SoloPDF 1.0.0 — 目录智能生成、拼版印前套件、框选提表与闪卡、图章与比例尺测量、数字证书验签、支持者徽章

SoloPDF 正式迈入 **v1.0.0 里程碑版本**。本版本补齐了目录书签（Outlines）可视化编辑与智能生成、N-up / 小册子骑马钉拼版与灰度化、框选提取表格（MD/CSV）、Anki / Obsidian 复习闪卡导出、标准矢量图章与比例尺距离/面积测量、X.509 / PKCS#7 数字证书验签与签名，以及对标 SoloMD 的三档自愿内购赞助与「✨ 支持者」徽章。所有文档写操作严格遵循 **Copy-out 铁律**（原文件永不修改），桌面/移动 UI、CLI、MCP 四端同步贯通。

## 该下载哪个

| 系统 | 文件 |
| --- | --- |
| macOS（Apple Silicon 与 Intel 通用） | `SoloPDF_1.0.0_universal.dmg` — 已公证，下载后直接打开 |
| Windows x64 | `SoloPDF_1.0.0_x64-setup.exe`（或 `_x64_en-US.msi`） |
| Windows ARM64 | `SoloPDF_1.0.0_arm64-setup.exe`（或 `_arm64_en-US.msi`） |
| Linux x64 | `SoloPDF_1.0.0_amd64.deb` / `SoloPDF_1.0.0_amd64.AppImage` |
| Linux ARM64 | `SoloPDF_1.0.0_arm64.deb` / `SoloPDF_1.0.0_aarch64.AppImage` |
| Android | `app-universal-release.apk`（已签名，支持 16 KB 页面对齐） |

## 目录书签（Outlines）编辑与智能生成

- **目录树可视化编辑**：在文档工具「目录」面板中增删改目录项、调整目标页码、上下移动及调整父子缩进层级，导出带标准 `/Outlines` 的新 PDF。
- **一键智能生成目录**：自动统计正文字号梯度或按中英文章节正则（`第X章/节`、`Chapter N`、`1.1`）提取多级标题生成目录树。

## 拼版印刷与页面标准化（Print & Layout Suite）

- **N-up 多页合一拼版**：支持每张纸排 `2`、`4`（2×2）、`6`、`9`（3×3）、`16`（4×4）页（将源页面封装为矢量 Form XObject，可选方向、边距、间距与细边框）。
- **小册子骑马钉拼版（Booklet）**：自动将总页数补齐为 4 的倍数并按首尾配对折页顺序重排为双联横向拼版。
- **PDF 转灰度与扫描底色漂白（Grayscale）**：将内容流 RGB/CMYK 指令与内嵌图片转为 `DeviceGray`，可选开启「扫描件底色漂白」消除手机拍照灰底阴影。
- **统一页面尺寸（Normalize Page Size）**：将尺寸不一的合并 PDF 页面统一等比缩放居中至标准 `A4`、`A3`、`Letter` 或 `Legal`，自动同步注释坐标。

## 学术阅读与闪卡增强

- **框选提取表格（Table Snip → Markdown / CSV）**：在区域框选模式下一键将框选区域内的表格还原为对齐的 Markdown 表格复制到剪贴板，或直接导出为 RFC 4180 标准 CSV。
- **导出复习闪卡（Anki / Obsidian SR）**：支持将伴生批注（含筛选结果、挖空 `{{c1::...}}`、框选截图与 `solopdf://` 跳回链接）一键导出为 Anki `.tsv` 制卡文件或 Obsidian Spaced Repetition `.md`。

## 图章与比例尺测量

- **标准矢量图章与动态署名章（Stamps）**：内置 8 款多语言矢量印章（`已批准`、`机密`、`草稿`、`最终版`、`已审阅`、`作废`、`紧急`、`仅供参考`），支持附加审阅人署名与日期生成高清印章。
- **比例尺测量（Measure）**：选中直线、箭头或矩形标注时实时显示物理长度、周长与面积（支持 `mm`/`cm`/`m`/`in`/`pt` 单位切换及自定义比例尺标定）。

## 数字证书验签与签名（X.509 / PKCS#7）

- **数字签名验签（Verify Signatures）**：解析 PDF 中的 `/FT /Sig` 签名域与 ASN.1 DER CMS `SignedData`，提取签名人证书信息并校验 `/ByteRange` 与 SHA-256 消息摘要完整性，明确识别签名后是否被篡改。
- **证书签署（Cert Sign）**：支持填写签名人、原因、位置及可选 `.p12`/`.pfx` 证书生成带可视化印章外观与标准 CMS 签名的新 PDF。

## 支持者徽章与内购打赏（Tip Jar）

- **三档自愿一次性支持**：新增 `☕ 请喝杯咖啡`、`🍜 请吃顿工作餐`、`🚀 强力支持` 三档自愿打赏（macOS MAS / iOS 走原生 StoreKit + iCloud KV 同步，Android Google Play 走 Play Billing，桌面开源版跳转赞助页），支持任意一档即可永久点亮专属 **「✨ 支持者」** 徽章。SoloPDF 所有功能 100% 永久免费。

完整改动见 [CHANGELOG](https://github.com/zhitongblog/solopdf/blob/v1.0.0/CHANGELOG.md)。

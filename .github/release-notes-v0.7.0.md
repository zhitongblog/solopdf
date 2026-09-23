# SoloPDF 0.7.0 — 链接能点了，还有手绘、撤销、分屏、翻译

对照 Acrobat、PDF Expert、Zotero、Sioyek、Okular、福昕逐项比过之后补上的一批。第一条其实是个老问题：之前 PDF 里的超链接一个都点不动。

## 该下载哪个

| 系统 | 文件 |
| --- | --- |
| macOS（Apple Silicon 与 Intel 通用） | `SoloPDF_0.7.0_universal.dmg` — 已公证，下载后直接打开 |
| Windows x64 | `SoloPDF_0.7.0_x64-setup.exe`（或 `_x64_en-US.msi`） |
| Windows ARM64 | `SoloPDF_0.7.0_arm64-setup.exe`（或 `_arm64_en-US.msi`） |
| Linux x64 | `SoloPDF_0.7.0_amd64.deb` / `SoloPDF_0.7.0_amd64.AppImage` |
| Linux ARM64 | `SoloPDF_0.7.0_arm64.deb` / `SoloPDF_0.7.0_aarch64.AppImage` |
| Android | `app-universal-release.apk`（已签名） |

## 导航

- **PDF 里的链接能点了**。内部链接落到目标的精确位置（不只是页顶），外链用系统浏览器打开。以前链接层只在带表单的页面渲染，而且接的是空实现。
- **前进 / 后退**：⌥← / ⌥→，Mac 上也可以 ⌘[ / ⌘]，鼠标侧键也行。链接、目录、搜索结果、输入页码、书签都会记下原位置。
- **悬停预览**：鼠标停在链接上（触屏长按）弹出目标区域。没有链接的论文也能认出 Figure 3、Table 2、Eq. (4)、[12]、图 3、表 2，预览对应的图、表、公式和参考文献。
- **印刷页码**：页码框显示书上印的页码（xii、A-3），输入标签或页序号都能跳，`#35` 强制按第 35 页跳。

## 阅读

- **一键旋转**：PDF 工具栏和漫画 / DjVu 底栏各加了一个旋转按钮。
- **全屏阅读**（F11 或 ⌃⌘F）和**演示模式**（F5 或 ⌘⇧P）。
- **纸张颜色**：米黄、护眼绿、浅灰。
- **分屏**（⌘\）：同一份文档两个视口，各自滚动缩放，批注两边同步。

## 标注

- **画笔、橡皮、文本框、矩形、椭圆、直线、箭头**，支持触控笔压感。导出带标注 PDF 时写成标准注释，Preview / Acrobat 都能看到。
- **撤销 / 重做**：⌘Z / ⇧⌘Z（其他系统 Ctrl+Z / Ctrl+Y），所有批注操作都能撤销。
- **选区翻译**：macOS 15+ / iOS 18+ 用系统本机翻译，不联网；其他平台可以在设置里自己配 DeepL 或 OpenAI 兼容接口（默认关闭）。译文可以存成高亮笔记。

## CLI / MCP

`solopdf links`、`solopdf translate`；`info` 输出印刷页码。MCP 新增 `solopdf_links`、`solopdf_translate`。

## 已知限制

- 触控笔、窗口级全屏、Windows / Linux 上的翻译只在代码和浏览器里验证过，没在对应真机上手动回归
- macOS 15–25 上翻译时会短暂弹出一个小窗（系统接口限制，macOS 26 起没有）
- 演示模式不显示批注

完整改动见 [CHANGELOG](https://github.com/zhitongblog/solopdf/blob/v0.7.0/CHANGELOG.md)。

免费、无广告、本地优先的 PDF 阅读器。这一版把 SoloPDF 和主流阅读器逐项对比后缺的东西补齐了，同时没有动"高亮即笔记"这条主线——所有新标注一样落进 `.annotations.md`。

## 该下载哪个

| 系统 | 文件 |
| --- | --- |
| macOS（Apple Silicon 与 Intel 通用） | `SoloPDF_0.6.0_universal.dmg` — 已公证，下载后直接打开 |
| Windows x64 | `SoloPDF_0.6.0_x64-setup.exe`（或 `_x64_en-US.msi`） |
| Windows ARM64 | `SoloPDF_0.6.0_arm64-setup.exe`（或 `_arm64_en-US.msi`） |
| Linux x64 | `SoloPDF_0.6.0_amd64.deb` / `SoloPDF_0.6.0_amd64.AppImage` |
| Linux ARM64 | `SoloPDF_0.6.0_arm64.deb` / `SoloPDF_0.6.0_aarch64.AppImage` |
| Android | `SoloPDF.apk`（未签名 release，需允许安装未知来源） |

**x64 和 Intel Mac 是这一版新增的**。此前发布矩阵只有三条 ARM 腿，x64 Windows、x64 Linux 和 Intel Mac 用户没有可下载的包；现在 macOS 出一个 universal dmg，Windows 和 Linux 各出 x64 与 ARM64 两套。

## 阅读

- **旋转**：整档或单页，随文档记住
- **版式**：单页 / 双页对开（可让封面单独成页）× 连续滚动 / 单屏翻页
- **裁边**：自动检测白边 + 四边手动微调；只影响显示，不改文件。移动端读双栏论文的关键
- **自动滚动**与**阅读时屏幕常亮**
- **朗读**：系统语音，按句朗读、跟随高亮、自动翻页
- **书签**：⌘D 或工具栏 ☆，侧栏成组管理

## 标注

- 新类型：**下划线 / 删除线 / 波浪线 / 便签图钉 / 框选截图**
- 截图存进 `<文档名>.annotations.assets/`，伴生 MD 里用 `![](…)` 引用
- **导出带标准 PDF 注释的副本**：Preview / Acrobat / 福昕也能看到你的高亮（原文件永不修改）
- 侧栏按类型 / 颜色 / `#标签` / 关键词筛选，按页码或时间排序

## 文档工具（全部写新文件，源文件只读）

页面旋转 / 删除 / 提取 / 重排、合并、拆分、PDF ↔ 图片、压缩、手写签名与日期戳、设置或移除打开密码（AES-256）。

## 找东西

- **书架**取代欢迎页：封面网格、阅读进度、收藏、标签、排序
- **全库搜索**：先搜伴生批注（即时），再搜正文（按需建索引，可中断）
- 内置 CC-CEDICT 离线词典（12 万词条）；阅读统计只存本机

## 新格式

MOBI / AZW3（KF8，自研解析器）、CBZ / CBR 漫画（日漫右起翻页）、DjVu（pure-Rust，djvu-rs）。

## 平台

- **Android**：新增工程、构建脚本与 CI；`content://` URI 走 JNI 读进应用目录，open-with 与 `solopdf://` 深链可用
- **iOS 修复**：文件选择器与"用 SoloPDF 打开"给的是临时路径，重启即失效——现在一律导入应用自己的 Library 目录，按内容哈希去重
- 移动端与桌面端分别设计：手机走底部 sheet、44pt 触控目标；桌面保留键盘优先与多选拖拽

## 工程

- `solopdf-doc` 原生驱动 + CLI 新子命令（annotate / to-images / search / dict / doc …），MCP 新增 6 个工具（4 个写门控）
- 修掉一个隐蔽坑：pdf.js 会用它自己解析到的 `@napi-rs/canvas` 打 Path2D 补丁，pnpm 下与本包依赖不是同一份原生模块，任何带字体的页面都会在 `paintChar` 崩掉
- `scripts/check-i18n.mjs` 四语言键完整性进 CI；13 项 pdfops + 3 项 DjVu + core 单测全部进 CI

## 已知限制

- CBR 只在真实 RAR 归档上做了 API 级验证
- MOBI 的 HUFF/CDIC 压缩与 DRM 文件不支持，会明确提示而不是显示乱码
- Windows / Linux 的 x64 产物由 CI 构建，未在物理 x64 机器上做过手动回归（ARM64 有 UTM 虚拟机覆盖）
- Android release 包未签名，需自备 keystore

完整清单见 [CHANGELOG.md](https://github.com/zhitongblog/solopdf/blob/v0.6.0/CHANGELOG.md)。

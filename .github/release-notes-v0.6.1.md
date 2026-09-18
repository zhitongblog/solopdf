# SoloPDF 0.6.1 — 补上标题栏那块空，Android 回来了

v0.6.0 的功能清单不变，这一版修三件事，其中一件每个 Windows 用户都看得到。

## 该下载哪个

| 系统 | 文件 |
| --- | --- |
| macOS（Apple Silicon 与 Intel 通用） | `SoloPDF_0.6.1_universal.dmg` — 已公证，下载后直接打开 |
| Windows x64 | `SoloPDF_0.6.1_x64-setup.exe`（或 `_x64_en-US.msi`） |
| Windows ARM64 | `SoloPDF_0.6.1_arm64-setup.exe`（或 `_arm64_en-US.msi`） |
| Linux x64 | `SoloPDF_0.6.1_amd64.deb` / `SoloPDF_0.6.1_amd64.AppImage` |
| Linux ARM64 | `SoloPDF_0.6.1_arm64.deb` / `SoloPDF_0.6.1_aarch64.AppImage` |
| Android | `app-universal-release.apk`（已签名） |

## 修复

- **标题栏左边那块 70px 的空没有了（Windows / Linux）**。那是给 macOS 红绿灯让位的占位块——macOS 把窗口按钮画在内容上面，不留位置会压住第一个标签页。但它一直是无条件渲染的，Windows 和 Linux 那里什么都没有，就成了一块白留的空，看起来像个没画出来的菜单。现在只在 macOS 渲染。

- **Android 包回到发布里，并且是签名的**。v0.6.0 缺 Android，因为 CI 拿不到签名密钥时会静默退回 debug 构建，产出一个 998 MB、带完整调试信息的包——当 CI 产物没问题，当下载就不行。现在签名链路接通了，拿不到密钥就让构建失败而不是偷偷降级。

- **iOS 最低系统版本提到 15.0**。Xcode 27 已经拒绝构建 14.0 目标（硬失败，不是警告），所以这是被工具链推着走的，不是主动砍用户。

## 发布流程

发布前会逐个断言产物架构再上传：NSIS 解包验内部可执行文件，MSI 读 Template 字段，deb 读 control 的 Architecture，AppImage 直接验 ELF。任一不符就不发——文件名写着 x64、内容却是 ARM 的包，比没有包更糟。

## 已知限制

- Windows / Linux 的 x64 产物由 CI 构建，未在物理 x64 机器上做过手动回归（ARM64 有虚拟机覆盖）
- CBR 只在真实 RAR 归档上做了 API 级验证
- MOBI 的 HUFF/CDIC 压缩与 DRM 文件不支持，会明确提示而不是显示乱码

完整功能清单见 [v0.6.0 release notes](https://github.com/zhitongblog/solopdf/releases/tag/v0.6.0) 与 [CHANGELOG](https://github.com/zhitongblog/solopdf/blob/v0.6.1/CHANGELOG.md)。

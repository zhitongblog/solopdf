# SoloPDF 标准测试集（test-fixtures）

全项目唯一的验收基准，自测（CLI / dev-mcp）和人工验收都用这一套。
设计蓝图见 `~/.gstack/projects/pdf/alexlee-main-design-20260704-225509.md`。

| 文件 | 角色 | 规格 | 来源 |
|---|---|---|---|
| `large-britannica-v1.pdf` | 大文件性能（冷启动 <2s 需 Range 流式） | 157MB / 1048 页 | archive.org《大英百科全书》11 版第 1 卷扫描（公有领域） |
| `toc-pdf-spec-iso32000.pdf` | 复杂目录树 | 22MB / 756 页 / 书签 823 条深 6 层 | Adobe 官方免费 PDF 1.7 规范（ISO 32000-1）——用 PDF 规范测 PDF 阅读器 |
| `scanned-sherlock-1892.pdf` | 扫描版（带 OCR 文字层） | 18MB / 376 页 | archive.org《福尔摩斯冒险史》1892 初版扫描（公有领域） |
| `scanned-no-textlayer.pdf` | 真·无文字层（测"禁用高亮"降级） | 10 页 | 由上书前 10 页栅格化重封装（150dpi JPEG） |
| `form-irs-w9.pdf` | 表单（AcroForm，v1 只读渲染） | 6 页 | IRS W-9 官方可填写表单 |
| `chinese-wikipedia-hanzi.pdf` | 中文排版（数字文字层，文字提取已验证） | 28 页 | 中文维基百科「汉字」条目官方 PDF 导出（CC BY-SA） |
| `smart-refs-paper.pdf` | 智能引用（无链接注释的论文：图/表/公式/参考文献 + 中文“图 3/表 1/公式 (2)”） | 4 页 / 6KB | 由 `scripts/gen-smartref-fixture.mjs` 手写生成（可复现），中文用非嵌入 STSong-Light |
| `citation-paper.pdf` | 引用识别 + 阅读标尺（双栏正文）：Info 标题是 Word 占位名、作者是 admin，必须从首页排版取标题/8 位作者；arXiv 号在页眉；第 2 页参考文献里的 DOI 不能当成本文 DOI | 2 页 / 10KB | `node scripts/gen-citation-fixture.mjs` 生成；标题/作者为 arXiv:1706.03762 的书目信息（供 doi.org 联网补全对照），正文为自写占位文字 |
| `citation-cn-paper.pdf` | 中文期刊首页：UTF-16 Info 标题/作者、页脚 DOI、收稿日期 → GB/T 7714 | 1 页 / 4KB | 同上脚本生成（非嵌入 STSong-Light） |
| `encrypted-password-solopdf.pdf` | 加密 PDF（密码输入框 + 明文批注提示） | 28 页 / AES-256 | 由中文样本加密生成，**密码：`solopdf`** |
| `page-labels-roman.pdf` | 页码标签（/PageLabels：封面 Cover、罗马数字前言 i–iv、正文从 1 重新起、附录 A-1–A-3） | 24 页 / 4KB | `node scripts/gen-page-labels-fixture.mjs` 手写 PDF 对象生成，可复现；每页印着“Physical page N - printed label X”，另有灰/蓝色块用于纸张颜色/反色检查 |
| `annotated-by-other-apps.pdf` | 导入其他应用的注释（Highlight×3 含跨行与中文、Underline、StrikeOut、Squiggly、Text 便签+回复、FreeText、Ink、Square、Circle、带箭头的“\”斜线 Line、Line、Polygon；另有 Stamp（不支持→跳过）与 Hidden 高亮（不导入）） | 3 页 / 8KB | `node scripts/gen-annotated-fixture.mjs` 手写 PDF 对象生成，可复现；Courier/STSong 等宽排版，quadpoints 精确落在已知词上 |
| `attachments-sample.pdf` | 嵌入附件：4 个文档级附件（inner-report.pdf / data.csv / install.bat / photo.png）+ 第 1 页一个无外观流的回形针注释（annexe.pdf） | 2 页 / 11KB | `node scripts/gen-attach-layers-fixtures.mjs` 手写生成，可复现；/PageMode /UseAttachments |
| `layers-sample.pdf` | 图层（OCG）：Base map（锁定）/ Labels / Theme 组下 Day·Night 单选组（Night 默认关） | 2 页 / 2KB | 同上脚本；/PageMode /UseOC |
| `compare-contract-v1.pdf` / `compare-contract-v2.pdf` | 文档比较（合同两版：改一句、删一段、插入整页、中文逐字插入、改一个词；页脚页码在插页后整体错位） | 4 页 / 5 页，各 ~6KB | `node scripts/gen-compare-fixture.mjs` 手写 PDF 对象生成，可复现；中文用非嵌入 STSong-Light |

| `fb2-cyrillic-1251.fb2` | FB2 图书（windows-1251 编码、嵌套章节→目录、封面与内嵌图片、诗歌/题记/表格/脚注） | 29KB / 8 章 | `python3 scripts/gen-format-fixtures.py` 生成；正文为普希金诗句（公有领域）+ 自写测试句 |
| `fb2-chinese.fbz` | 压缩 FB2（zip 内一个 UTF-8 .fb2，中文、全角缩进） | 11KB / 2 章 | 同上脚本生成 |
| `tiff-mixed-3p.tiff` | 多页 TIFF，三种压缩混排：CCITT G4 1-bit 传真页 / LZW RGB / Deflate 灰度横版页 | 66KB / 3 页 | 同上脚本（Pillow 逐页生成 + libtiff `tiffcp` 拼接） |

## 验收要点对照（来自设计蓝图 Success Criteria）

- `large-britannica-v1.pdf`：冷启动到首页渲染 <2s（M 系列）；滚动全程内存不爆（虚拟滚动 ±2 页）
- `toc-pdf-spec-iso32000.pdf`：目录侧栏 6 层树全展开不卡；点击跳转准确
- `scanned-sherlock-1892.pdf`：OCR 文字层可选择/高亮；渲染无花屏
- `scanned-no-textlayer.pdf`：工具栏提示"该页无文字层"，文字高亮禁用
- `form-irs-w9.pdf`：表单域只读渲染正常（v1 不支持填写）
- `chinese-wikipedia-hanzi.pdf`：中文选择/搜索/高亮→伴生文件全链路；`汉字`「漢字」引号标点提取正确
- `toc-pdf-spec-iso32000.pdf`（链接）：前 60 页 277 个内部链接 + 18 个外链（`solopdf links … --pages 1-60`）；点击内部链接落到 /XYZ 精确位置，外链走系统浏览器；⌥← 返回
- `smart-refs-paper.pdf`：p1 悬停 Figure 1 / Table 1 / Eq. (2) / (1) / [2] / [1, 3] / Fig. 2 / 图 3 / 表 1 / 公式 (2) / [4] 均弹出目标区域预览；Figure 9、[0, 1]、“(7) alone” 不弹
- `page-labels-roman.pdf`：工具栏页码框显示印刷页码（ii (3 / 24)），输入 `iii` / `3` / `#3` 分别跳物理第 4 / 8 / 3 页；伴生文件锚点仍写物理页；`solopdf info` 输出 `1: Cover; 2-5: i–iv; 6-21: 1–16; 22-24: A-1–A-3`
- `annotated-by-other-apps.pdf`：打开即提示“此 PDF 含 14 条其他应用留下的注释”；导入后侧栏 14 条（作者/日期/原文摘录齐全，回复并入便签），页面上原注释不再由 pdf.js 重复绘制；⌘Z 一步撤销整次导入；再次导入为 0；`solopdf import-annotations … --dry-run` 输出 found 14 / replies 1 / unsupported Stamp@p.2
- `attachments-sample.pdf`：侧栏出现「附件 5」（打开即切到该页签）；inner-report.pdf / annexe.pdf 在新标签打开，photo.png 以图片视图打开，data.csv 交给系统，install.bat 只有「另存为」；点页面上的回形针打开 annexe.pdf；`solopdf attachments … --extract d` 写出 5 个文件
- `layers-sample.pdf`：侧栏出现「图层」；Base map 锁定不可切换；打开 Night 自动关闭 Day（单选组）；关 Labels 后 LABEL TEXT 消失；分屏两侧、缩略图、打印同步；重开文档保持上次的选择，「恢复默认」清除；`solopdf layers` 输出 4 个图层、1 个单选组、Base map locked
- 其他无附件/无图层的样本：两个页签都不出现
- `compare-contract-v1.pdf` → `compare-contract-v2.pdf`：`solopdf compare` 恰好报 6 处——p.2 修改「thirty (30」→「fifteen (15」、p.2 删除 2.3 整段、新增第 3 页（Schedule C）、p.3→p.4 新增「严格」「任何」、p.4→p.5「Zurich」→「Geneva」；页对齐 1-1 / 2-2 / —-3 / 3-4 / 4-5；页脚页码不算差异。应用里两版并排、两边高亮、同步滚动按对齐跳页
- `encrypted-password-solopdf.pdf`：密码框（记住本次会话）；高亮时弹一次明文保存提示
- `fb2-cyrillic-1251.fb2`：西里尔文正常显示（非乱码）；目录 7 条（两级）；第 3 章有柱状图；搜索「журавль」命中第 7 章；
  高亮写入 `fb2-cyrillic-1251.annotations.md`；`solopdf info` 报 `encoding: windows-1251`
- `fb2-chinese.fbz`：直接打开 zip 包；段首全角缩进保留；`solopdf extract-text` 输出「床前明月光」
- `tiff-mixed-3p.tiff`：3 页全部解码（第 3 页 Deflate 依赖 pako）；`solopdf info` 列出 G4/LZW/Deflate；旋转、缩放、翻页；
  桌面版底栏「识别文字」对当前页 OCR

注：`*.pdf` 均来自公有领域/官方公开渠道，可安全入库；如嫌 157MB 太大可 git-lfs 或 .gitignore。

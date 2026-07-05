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
| `encrypted-password-solopdf.pdf` | 加密 PDF（密码输入框 + 明文批注提示） | 28 页 / AES-256 | 由中文样本加密生成，**密码：`solopdf`** |

## 验收要点对照（来自设计蓝图 Success Criteria）

- `large-britannica-v1.pdf`：冷启动到首页渲染 <2s（M 系列）；滚动全程内存不爆（虚拟滚动 ±2 页）
- `toc-pdf-spec-iso32000.pdf`：目录侧栏 6 层树全展开不卡；点击跳转准确
- `scanned-sherlock-1892.pdf`：OCR 文字层可选择/高亮；渲染无花屏
- `scanned-no-textlayer.pdf`：工具栏提示"该页无文字层"，文字高亮禁用
- `form-irs-w9.pdf`：表单域只读渲染正常（v1 不支持填写）
- `chinese-wikipedia-hanzi.pdf`：中文选择/搜索/高亮→伴生文件全链路；`汉字`「漢字」引号标点提取正确
- `encrypted-password-solopdf.pdf`：密码框（记住本次会话）；高亮时弹一次明文保存提示

注：`*.pdf` 均来自公有领域/官方公开渠道，可安全入库；如嫌 157MB 太大可 git-lfs 或 .gitignore。

// All App Store metadata for SoloPDF, in one editable place.
// release.mjs applies this every run (both platforms), so new versions inherit it.
// Subtitle ≤ 30 chars; keywords ≤ 100 chars; no price references outside the description
// (guideline 2.3.7).

export const appInfoLocalizations = {
  'zh-Hans': { name: 'SoloPDF', subtitle: '无广告的本地 PDF 阅读器', privacyPolicyUrl: 'https://solopdf.doaipm.com/privacy/' },
  'zh-Hant': { name: 'SoloPDF', subtitle: '無廣告的本地 PDF 閱讀器', privacyPolicyUrl: 'https://solopdf.doaipm.com/privacy/' },
  'en-US':   { name: 'SoloPDF', subtitle: 'Clean local-first PDF reader', privacyPolicyUrl: 'https://solopdf.doaipm.com/privacy/' },
  'ja':      { name: 'SoloPDF', subtitle: '広告なしのローカルPDFリーダー', privacyPolicyUrl: 'https://solopdf.doaipm.com/privacy/' },
};

const zhHans = {
  description: `SoloPDF 是一款干净、快速、完全本地运行的 PDF 阅读器与全离线文档工具箱 —— 没有广告、没有账号、不上传任何数据。

• 阅读与对比:多标签、目录大纲、页面缩略图、全文搜索、单页/双页对开/分屏并排;支持两版合同词级差异对比,以及针对扫描件/图纸的红青像素叠印与 A↔B 闪烁切换对比(Blink Diff),超大文件秒开。
• 高亮即笔记:选中文字高亮后,批注自动保存为 PDF 旁边的 Markdown 笔记文件(.annotations.md),可以用任何编辑器(包括我们的 SoloMD 与 Obsidian)直接打开、编辑、进版本管理;笔记里的 solopdf:// 链接可一键跳回原文位置。
• 学术与知识管理:框选页面区域一键将数学公式转为 LaTeX 或将表格提取为 Markdown / CSV;聚合多篇论文的 #标签 批注自动导出跨文档专题文献综述;一键导出 Anki / Obsidian 复习闪卡。
• 扫描件精修与全离线文档工具(严格遵循 Copy-out 原则,原文件永不修改):内置 17 步内存流水线与多文件批量处理、扫描件自动纠偏去黑边(Auto-Deskew)、Sauvola 自适应黑白二值化(彻底消除拍照阴影)、双页扫描中缝切分、空白页智能剔除、目录大纲智能生成、N-up 与小册子骑马钉拼版、水印与 Bates 编号、自动裁白边、真涂黑脱敏(Redact)、元数据清理、表单填写与扁平化、X.509/PKCS#7 数字证书验签与签名。
• 审阅与测量:内置 8 款多语言矢量标准图章与动态署名公章;支持标定比例尺测量图纸距离、周长与多边形面积。
• 支持独立开发(可选内购):所有功能 100% 永久免费;提供三档一次性自愿打赏内购(请喝杯咖啡 / 请吃顿工作餐 / 强力支持,非自动续费订阅),支持任意一档即可永久点亮专属「支持者」徽章。

所有处理都在你的设备上完成,不收集任何数据。`,
  keywords: 'pdf,阅读器,无广告,批注,笔记,markdown,扫描去阴影,文档对比,公式latex,脱敏,拼版,闪卡',
  promotionalText: '干净、快速、全本地的 PDF 阅读器与全离线工具箱 —— 高亮自动变成 Markdown 笔记。',
  supportUrl: 'https://solopdf.doaipm.com', marketingUrl: 'https://solopdf.doaipm.com',
  whatsNew: `SoloPDF 1.1 更新内容:
• 扫描件精修闭环:新增扫描件自动纠偏与黑边切除(Auto-Deskew),以及 Sauvola 自适应黑白二值化(一键消除手机拍照阴影与光照不均)
• 视觉级页面对比:新增像素红青叠印差分、变动区域热点框选与 A/B 闪烁切换对比(Blink Compare),扫描合同、印章与工程图纸微调一目了然
• 学术增强与 SoloMD 互操作:框选区域一键识别数学公式转 LaTeX;新增跨文档 #标签 专题综述导出,一键汇总多篇论文批注生成带深链的文献综述
• 批量自动化流水线:内存流水线扩展至 17 种原子操作(含高清黑白扫描等 5 大预设),并支持多文件批量队列一键输出`,
};

const zhHant = {
  description: `SoloPDF 是一款乾淨、快速、完全本地執行的 PDF 閱讀器與全離線文件工具箱 —— 沒有廣告、沒有帳號、不上傳任何資料。

• 閱讀與對比:多分頁、目錄大綱、頁面縮圖、全文搜尋、單頁/雙頁對開/分割畫面並排;支援兩版合約字詞差異對比,以及針對掃描檔/圖紙的紅青像素疊印與 A↔B 閃爍切換對比(Blink Diff),超大檔案秒開。
• 螢光筆即筆記:選取文字加上螢光標記後,批註會自動儲存為 PDF 旁邊的 Markdown 筆記檔(.annotations.md),可以用任何編輯器(包括我們的 SoloMD 與 Obsidian)直接開啟、編輯、納入版本管理;筆記中的 solopdf:// 連結可一鍵跳回原文位置。
• 學術與知識管理:框選頁面區域一鍵將數學公式轉為 LaTeX 或將表格提取為 Markdown / CSV;聚合多篇論文的 #標籤 批註自動匯出跨文件專題文獻綜述;一鍵匯出 Anki / Obsidian 複習閃卡。
• 掃描精修與全離線文件工具(嚴格遵循 Copy-out 原則,原檔案永不修改):內建 17 步記憶體流水線與多檔案批次處理、掃描自動糾偏去黑邊(Auto-Deskew)、Sauvola 自適應黑白二值化(徹底消除拍照陰影)、雙頁掃描中縫切分、空白頁智慧剔除、目錄大綱智慧生成、N-up 與小冊子騎馬釘拼版、浮水印與 Bates 編號、自動裁白邊、真塗黑脫敏(Redact)、中繼資料清理、表單填寫與平面化、X.509/PKCS#7 數位憑證驗簽與簽章。
• 審閱與測量:內建 8 款多語言向量標準圖章與動態署名公章;支援標定比例尺測量圖紙距離、周長與多邊形面積。
• 支持獨立開發(可選內購):所有功能 100% 永久免費;提供三檔一次性自願打賞內購(請喝杯咖啡 / 請吃頓工作餐 / 強力支持,非自動續費訂閱),支持任意一檔即可永久點亮專屬「支持者」徽章。

所有處理都在你的裝置上完成,不收集任何資料。`,
  keywords: 'pdf,閱讀器,無廣告,批註,筆記,markdown,掃描去陰影,文件對比,公式latex,脫敏,拼版,閃卡',
  promotionalText: '乾淨、快速、全本地的 PDF 閱讀器與全離線工具箱 —— 螢光標記自動變成 Markdown 筆記。',
  supportUrl: 'https://solopdf.doaipm.com', marketingUrl: 'https://solopdf.doaipm.com',
  whatsNew: `SoloPDF 1.1 更新內容:
• 掃描檔精修閉環:新增掃描自動糾偏與黑邊切除(Auto-Deskew),以及 Sauvola 自適應黑白二值化(一鍵消除手機拍照陰影與光照不均)
• 視覺級頁面對比:新增像素紅青疊印差分、變動區域熱點框選與 A/B 閃爍切換對比(Blink Compare),掃描合約、印章與工程圖紙微調一目了然
• 學術增強與 SoloMD 互操作:框選區域一鍵識別數學公式轉 LaTeX;新增跨文件 #標籤 專題綜述匯出,一鍵彙總多篇論文批註生成帶深鏈的文獻綜述
• 批次自動化流水線:記憶體流水線擴展至 17 種原子操作(含高清黑白掃描等 5 大預設),並支援多檔案批次佇列一鍵輸出`,
};

const enUS = {
  description: `SoloPDF is a clean, fast, fully local PDF reader and offline document toolkit — no ads, no account, nothing ever uploaded.

• Reading & Visual Diff: multiple tabs, outline, page thumbnails, full-text search, two-page spread, split view, word-level text comparison, plus pixel Red/Cyan overlay and A/B Blink Compare for scanned contracts and CAD drawings. Huge files open instantly.
• Highlights become notes: highlight any text and the annotation is saved as a companion Markdown file (.annotations.md) right next to the PDF — open, edit, and version it with SoloMD, Obsidian, VS Code, or Git. solopdf:// deep links jump straight back to the exact passage.
• Academic & Study Superpowers: box-select formulas into LaTeX or tables into Markdown / CSV; aggregate #tags across multiple papers into a Cross-PDF Topic Digest; export flashcards to Anki (.tsv) or Obsidian Spaced Repetition.
• Scan Mastery & Offline Toolkit (strictly copy-out, original files are never modified): 17-step in-memory batch pipeline, scan Auto-Deskew & border cleanup, Sauvola adaptive B&W binarization (removes camera shadows), 2-up scan split, blank page removal, smart outline generator, N-up & saddle-stitch booklet imposition, watermarks & Bates numbering, auto-crop margins, lossless image extraction, true content-stream redaction, metadata sanitization, form filling & flattening, and X.509 / PKCS#7 digital signature verification & signing.
• Review & Measurement: 8 localized vector stamps + dynamic author/date stamps; calibrated scale ruler for measuring distance, perimeter, and polygon area.
• Optional Tip Jar: 100% of SoloPDF features are free forever. Three optional one-time tip tiers (Buy a Coffee / Buy a Lunch / Generous Support, non-renewing) unlock the "Supporter" badge.

Everything runs on your device. No data collection.`,
  keywords: 'pdf,reader,markdown,annotate,ocr,deskew,redact,compare,latex,booklet,flashcards,obsidian',
  promotionalText: 'A clean, fast, local-first PDF reader & toolkit — highlights become Markdown notes.',
  supportUrl: 'https://solopdf.doaipm.com', marketingUrl: 'https://solopdf.doaipm.com',
  whatsNew: `What's New in SoloPDF 1.1:
• Scan Mastery Suite: added Auto-Deskew & dark border cleanup plus Sauvola local adaptive B&W binarization to eliminate phone-camera shadows in one click
• Visual Page Diff & Blink Compare: added pixel-level Red/Cyan overlay diff, change hotspot clustering, and A/B Blink Compare for scanned contracts, stamps, and CAD drawings
• Math to LaTeX & Cross-PDF Topic Digest: snip any equation region directly to inline or display LaTeX; aggregate #tag annotations across multiple PDFs into a structured Markdown literature review for SoloMD or Obsidian
• 17-Step Batch Pipeline: expanded the in-memory pipeline to 17 operations with 5 presets and multi-file batch queue processing`,
};

const ja = {
  description: `SoloPDF は、広告なし・アカウント不要・完全ローカル動作の高速な PDF リーダー＆オフライン文書ツールキットです。データが外部へ送信されることは一切ありません。

• 閲覧＆高精度な差分比較:マルチタブ、目次アウトライン、ページサムネイル、全文検索、見開き・分割表示に対応。テキスト比較に加え、スキャン契約書や図面の微細な変更を見抜く赤青ピクセル重ね合わせ＆ A/B 点滅比較(Blink Diff)を搭載。
• ハイライトがそのままノートに:テキストをハイライトすると、注釈が PDF と同じ場所に Markdown ノートファイル(.annotations.md)として保存されます。SoloMD や Obsidian などのエディタで編集でき、solopdf:// リンクから元の箇所へワンタップで戻れます。
• 学術研究・学習支援:範囲選択で数式を LaTeX に変換、表を Markdown / CSV として抽出。複数論文の #タグ 注釈をまとめるトピック総説出力や、Anki (.tsv)・Obsidian 暗記カード書き出しに対応。
• スキャン補正＆完全オフライン文書ツール(元ファイルを変更しない Copy-out 方式):17ステップの一括バッチパイプライン、スキャン傾き自動補正(Auto-Deskew)、Sauvola 適応二値化(スマホ撮影の影除去)、見開きスキャン分割、空白ページ削除、目次の自動生成、N-up・小冊子(中綴じ)面付け、透かし・ベイツ番号、余白自動トリミング、完全墨消し(Redact)、メタデータ消去、フォーム入力・フラット化、X.509/PKCS#7 電子署名の検証・署名。
• スタンプと計測:8種類の多言語ベクタースタンプと日付・署名入り動的スタンプ、縮尺校正対応の距離・周囲長・面積計測ツールを搭載。
• 開発者へのサポート(任意):すべての機能は永久に 100% 無料です。3段階の買い切り型チップ(自動更新なし)で「サポーター」バッジを点灯できます。`,
  keywords: 'pdf,リーダー,注釈,markdown,ノート,スキャン補正,影除去,差分比較,数式latex,墨消し,面付け,暗記',
  promotionalText: '広告なし・完全ローカルの PDF リーダー＆ツール。ハイライトが Markdown ノートになります。',
  supportUrl: 'https://solopdf.doaipm.com', marketingUrl: 'https://solopdf.doaipm.com',
  whatsNew: `SoloPDF 1.1 アップデート:
• スキャン高度補正:スキャン傾き自動補正＆黒枠除去(Auto-Deskew)と、スマホ撮影の影や照明ムラを除去する Sauvola 適応白黒二値化を追加
• ビジュアル差分＆点滅比較:赤青ピクセルオーバーレイ、変更箇所ホットスポット枠表示、A/B 点滅比較(Blink Compare)を追加し、スキャン契約書や図面の微細な変更を瞬時に検出
• 数式 LaTeX 抽出＆論文横断ダイジェスト:範囲選択した数式を LaTeX としてコピー可能に。複数 PDF の #タグ 注釈を集約して Markdown 総説ノートを出力する機能を追加
• 17ステップ一括バッチパイプライン:メモリ内パイプラインを17操作・5プリセットに拡張し、複数PDFの一括バッチ処理に対応`,
};

export const versionLocalizations = { 'zh-Hans': zhHans, 'zh-Hant': zhHant, 'en-US': enUS, 'ja': ja };

export const appFields = {
  primaryCategory: 'PRODUCTIVITY',
  contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT',
  copyright: '2026 doaipm',
  releaseType: 'AFTER_APPROVAL',
};

export const reviewContact = {
  contactFirstName: 'Xiangdong',
  contactLastName:  'Li',
  contactPhone:     process.env.ASC_CONTACT_PHONE || '+86 17326068045',
  contactEmail:     process.env.ASC_CONTACT_EMAIL || 'lixd220@gmail.com',
  demoAccountRequired: false,
  notes: `SoloPDF is a fully local PDF reader and offline document toolkit. No account needed, no server component.

IN-APP PURCHASES (VOLUNTARY TIP JAR): This version includes three optional one-time tip tiers (app.solopdf.tip.coffee, app.solopdf.tip.meal, app.solopdf.tip.feast) via StoreKit. 100% of SoloPDF's PDF reading, annotation, and document processing features are completely free without any purchase. Tipping any tier simply unlocks a cosmetic "Supporter" badge in Settings/Library.

OPTIONAL "ASK AI" FEATURE: it is OFF by default and SoloPDF ships no AI service of its own. A user can turn it on in Settings and enter their own OpenAI-compatible endpoint (for example a local Ollama / LM Studio server on their own computer). Before any text is sent, the app shows a consent sheet naming the exact endpoint and stating whether it is on the local machine or online. All other features work 100% offline.

SAMPLE PDF: https://solopdf.doaipm.com/sample.pdf — download in Safari, then in SoloPDF tap "Open PDF" and pick it from Files > Downloads (or use any of your own PDFs).

Support page: https://solopdf.doaipm.com/#support (email lixd220@gmail.com).`,
};

// Age rating → 4+ (everything none/false). Apple's schema requires ALL these keys.
export const ageRating = {
  alcoholTobaccoOrDrugUseOrReferences: 'NONE', contests: 'NONE', gamblingSimulated: 'NONE',
  horrorOrFearThemes: 'NONE', matureOrSuggestiveThemes: 'NONE', medicalOrTreatmentInformation: 'NONE',
  profanityOrCrudeHumor: 'NONE', sexualContentGraphicAndNudity: 'NONE', sexualContentOrNudity: 'NONE',
  violenceCartoonOrFantasy: 'NONE', violenceRealistic: 'NONE', violenceRealisticProlongedGraphicOrSadistic: 'NONE',
  gunsOrOtherWeapons: 'NONE',
  gambling: false, unrestrictedWebAccess: false, advertising: false, lootBox: false,
  userGeneratedContent: false, ageAssurance: false, healthOrWellnessTopics: false,
  messagingAndChat: false, parentalControls: false,
};

const dir = new URL('../../appstore-assets/', import.meta.url).pathname;
export const screenshots = {
  IOS: { dir, sets: [
    { displayType: 'APP_IPHONE_67',        files: ['ios-1.png', 'ios-2.png', 'ios-3.png', 'ios-4.png'] },
    { displayType: 'APP_IPAD_PRO_3GEN_129', files: ['ipad-1.png', 'ipad-2.png', 'ipad-3.png'] },
  ] },
  MAC_OS: { dir, sets: [
    { displayType: 'APP_DESKTOP', files: ['mac-1.png', 'mac-2.png', 'mac-3.png'] },
  ] },
};

// Per-platform release plan: store version string must match the attached build's train.
export const platforms = {
  IOS:    { versionString: '1.1.0', buildVersion: '1.1.0' },
  MAC_OS: { versionString: '1.10.0', buildVersion: '1.10.0' },
};

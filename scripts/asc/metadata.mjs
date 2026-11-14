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
  description: `SoloPDF 是一款干净、快速、完全本地运行的 PDF 阅读器与全离线文档工具 —— 没有广告、没有账号、不上传任何数据。

• 阅读体验:多标签、目录大纲、页面缩略图、全文搜索、单页/双页对开/分屏并排、比较文档差异,超大文件秒开(按需加载,不吃内存)。
• 高亮即笔记:选中文字高亮后,批注自动保存为 PDF 旁边的 Markdown 笔记文件(.annotations.md),可以用任何编辑器(包括我们的 SoloMD)直接打开、编辑、进版本管理;笔记里的 solopdf:// 链接可一键跳回原文位置。
• 学术与知识管理:框选页面区域一键提取表格为 Markdown 或 CSV;批注支持 #标签 与颜色筛选,并可一键导出为 Anki / Obsidian 复习闪卡。
• 全离线文档工具(严格遵循 Copy-out 原则,原文件永不修改):目录大纲智能生成与编辑、N-up 多页合一拼版、小册子骑马钉拼版、PDF 转灰度与扫描底色漂白、统一页面尺寸、水印与 Bates 编号、自动裁白边、无损提取原图、真涂黑脱敏(Redact)、元数据清理、表单填写与扁平化、X.509/PKCS#7 数字证书验签与签名。
• 审阅与测量:内置 8 款多语言矢量标准图章与动态署名公章;支持标定比例尺测量图纸距离、周长与多边形面积。
• 支持独立开发(可选内购):所有功能 100% 永久免费;提供三档一次性自愿打赏内购(请喝杯咖啡 / 请吃顿工作餐 / 强力支持,非自动续费订阅),支持任意一档即可永久点亮专属「✨ 支持者」徽章。

所有处理都在你的设备上完成,不收集任何数据。`,
  keywords: 'pdf,阅读器,无广告,批注,高亮,笔记,markdown,拼版,闪卡,数字签名',
  promotionalText: '干净、快速、全本地的 PDF 阅读器与文档工具 —— 高亮自动变成 Markdown 笔记。',
  supportUrl: 'https://solopdf.doaipm.com', marketingUrl: 'https://solopdf.doaipm.com',
  whatsNew: `SoloPDF 1.0 正式版里程碑更新:
• 目录书签编辑与智能生成:支持可视化增删改目录层级,或一键按正文字号梯度/章节正则自动生成 PDF 目录树
• 拼版印刷与页面标准化:新增 N-up 多页合一拼版(2/4/6/9/16 页)、小册子骑马钉对折拼版、PDF 转灰度与扫描底色漂白、统一页面尺寸(A4/A3/Letter)
• 学术与闪卡增强:框选任意区域一键提取表格为 Markdown 或 CSV;批注支持多维筛选并可一键导出为 Anki (.tsv) 与 Obsidian 复习闪卡
• 图章与比例尺测量:内置 8 款多语言矢量印章与动态日期署名印章;支持标定比例尺测量图纸距离、周长与多边形面积
• 数字证书验签与签名:支持校验 PDF 内的 X.509 / PKCS#7 数字签名与篡改状态,支持本地证书签署
• 支持者徽章:新增三档自愿一次性打赏内购,点亮专属「✨ 支持者」徽章(所有功能 100% 保持免费)`,
};

const zhHant = {
  description: `SoloPDF 是一款乾淨、快速、完全本地執行的 PDF 閱讀器與全離線文件工具 —— 沒有廣告、沒有帳號、不上傳任何資料。

• 閱讀體驗:多分頁、目錄大綱、頁面縮圖、全文搜尋、單頁/雙頁對開/分割畫面並排、比較文件差異,超大檔案秒開(按需載入,不佔記憶體)。
• 螢光筆即筆記:選取文字加上螢光標記後,批註會自動儲存為 PDF 旁邊的 Markdown 筆記檔(.annotations.md),可以用任何編輯器(包括我們的 SoloMD)直接開啟、編輯、納入版本管理;筆記中的 solopdf:// 連結可一鍵跳回原文位置。
• 學術與知識管理:框選頁面區域一鍵提取表格為 Markdown 或 CSV;批註支援 #標籤 與顏色篩選,並可一鍵匯出為 Anki / Obsidian 複習閃卡。
• 全離線文件工具(嚴格遵循 Copy-out 原則,原檔案永不修改):目錄大綱智慧生成與編輯、N-up 多頁合一拼版、小冊子騎馬釘拼版、PDF 轉灰階與掃描底色漂白、統一頁面尺寸、浮水印與 Bates 編號、自動裁白邊、無損提取原圖、真塗黑脫敏(Redact)、中繼資料清理、表單填寫與平面化、X.509/PKCS#7 數位憑證驗簽與簽章。
• 審閱與測量:內建 8 款多語言向量標準圖章與動態署名公章;支援標定比例尺測量圖紙距離、周長與多邊形面積。
• 支持獨立開發(可選內購):所有功能 100% 永久免費;提供三檔一次性自願打賞內購(請喝杯咖啡 / 請吃頓工作餐 / 強力支持,非自動續費訂閱),支持任意一檔即可永久點亮專屬「✨ 支持者」徽章。

所有處理都在你的裝置上完成,不收集任何資料。`,
  keywords: 'pdf,閱讀器,無廣告,批註,螢光筆,筆記,markdown,拼版,閃卡,數位簽章',
  promotionalText: '乾淨、快速、全本地的 PDF 閱讀器與文件工具 —— 螢光標記自動變成 Markdown 筆記。',
  supportUrl: 'https://solopdf.doaipm.com', marketingUrl: 'https://solopdf.doaipm.com',
  whatsNew: `SoloPDF 1.0 正式版里程碑更新:
• 目錄書籤編輯與智慧生成:支援視覺化增刪改目錄層級,或一鍵依正文字級梯度/章節正規表示式自動生成 PDF 目錄樹
• 拼版印刷與頁面標準化:新增 N-up 多頁合一拼版(2/4/6/9/16 頁)、小冊子騎馬釘對折拼版、PDF 轉灰階與掃描底色漂白、統一頁面尺寸(A4/A3/Letter)
• 學術與閃卡增強:框選任意區域一鍵提取表格為 Markdown 或 CSV;批註支援多維篩選並可一鍵匯出為 Anki (.tsv) 與 Obsidian 複習閃卡
• 圖章與比例尺測量:內建 8 款多語言向量印章與動態日期署名印章;支援標定比例尺測量圖紙距離、周長與多邊形面積
• 數位憑證驗簽與簽章:支援校驗 PDF 內的 X.509 / PKCS#7 數位簽章與竄改狀態,支援本地憑證簽署
• 支持者徽章:新增三檔自願一次性打賞內購,點亮專屬「✨ 支持者」徽章(所有功能 100% 保持免費)`,
};

const enUS = {
  description: `SoloPDF is a clean, fast, fully local PDF reader and offline document toolkit — no ads, no account, nothing ever uploaded.

• Reading: multiple tabs, outline, page thumbnails, full-text search, two-page spread, split view, and side-by-side document comparison. Huge files open instantly.
• Highlights become notes: highlight any text and the annotation is saved as a companion Markdown file (.annotations.md) right next to the PDF — open, edit, and version it with any editor (including SoloMD). solopdf:// deep links jump straight back to the exact passage.
• Academic & Study Tools: snip any table region on a page into Markdown or CSV; filter annotations by #tag, color, or kind, and export flashcards to Anki (.tsv) or Obsidian Spaced Repetition.
• Offline Document Toolkit (strictly copy-out, original files are never modified): smart outline/bookmark generator & editor, N-up multi-page imposition, saddle-stitch booklet maker, grayscale & scan background whitening, page size normalization, watermarks & Bates numbering, auto-crop margins, lossless image extraction, true content-stream redaction, metadata sanitization, form filling & flattening, and X.509 / PKCS#7 digital signature verification & signing.
• Review & Measurement: 8 localized vector stamps + dynamic author/date stamps; calibrated scale ruler for measuring distance, perimeter, and polygon area.
• Optional Tip Jar: 100% of SoloPDF features are free forever. Three optional one-time tip tiers (Buy a Coffee / Buy a Lunch / Generous Support, non-renewing) unlock the "✨ Supporter" badge.

Everything runs on your device. No data collection.`,
  keywords: 'pdf,reader,annotate,highlight,markdown,notes,booklet,flashcards,signature,offline',
  promotionalText: 'A clean, fast, local-first PDF reader & toolkit — highlights become Markdown notes.',
  supportUrl: 'https://solopdf.doaipm.com', marketingUrl: 'https://solopdf.doaipm.com',
  whatsNew: `SoloPDF 1.0 Milestone Release:
• Outline / Bookmark Editor & Smart Generator: edit PDF outline trees visually or auto-generate bookmarks from heading font-size gradients and chapter patterns
• Print & Layout Suite: N-up multi-page imposition (2/4/6/9/16 pages per sheet), saddle-stitch Booklet maker, Grayscale & scan background whitening, and Page Size Normalization (A4/A3/Letter)
• Table Snip & Flashcards: extract tables from any selected region directly to Markdown or CSV; export annotations and Cloze cards to Anki (.tsv) and Obsidian Spaced Repetition
• Vector Stamps & Scale Measurement: 8 localized vector review stamps + dynamic author/date stamps; calibrated scale measurement for distance, perimeter, and polygon area
• Digital Signatures (X.509 / PKCS#7): verify cryptographic PDF signatures and tamper status, and sign PDFs with certificates
• Supporter Tip Jar: optional one-time tip tiers that unlock the "✨ Supporter" badge (100% of app features remain free)`,
};

const ja = {
  description: `SoloPDF は、広告なし・アカウント不要・完全ローカル動作の高速な PDF リーダー＆オフライン文書ツールキットです。データが外部へ送信されることは一切ありません。

• 快適な閲覧:マルチタブ、目次アウトライン、ページサムネイル、全文検索、見開き表示、分割表示、2つのPDFの差分比較に対応。巨大なファイルも一瞬で開きます。
• ハイライトがそのままノートに:テキストをハイライトすると、注釈が PDF と同じ場所に Markdown ノートファイル(.annotations.md)として保存されます。任意のエディタ(SoloMD を含む)で編集でき、ノート内の solopdf:// リンクから元の箇所へワンタップで戻れます。
• 学習・研究支援:ページ内の表を範囲選択して Markdown や CSV として抽出。注釈の #タグ・色フィルタリングや、Anki (.tsv)・Obsidian 暗記カードへの一括書き出しに対応。
• 完全オフライン文書ツール(元ファイルを変更しない 안전한 Copy-out 方式):目次の自動生成・編集、N-up 集約印刷、小冊子(中綴じ)面付け、グレースケール変換・スキャン背景の漂白、ページサイズ統一(A4/A3/Letter)、透かし・ベイツ番号、余白自動トリミング、埋め込み画像の無劣化抽出、完全墨消し(Redact)、メタデータ消去、フォーム入力・フラット化、X.509/PKCS#7 電子署名の検証・署名。
• スタンプと計測:8種類の多言語ベクタースタンプと日付・署名入り動的スタンプ、縮尺校正対応の距離・周囲長・面積計測ツールを搭載。
• 開発者へのサポート(任意):すべての機能は永久に 100% 無料です。3段階の買い切り型チップ(自動更新なし)で「✨ サポーター」バッジを点灯できます。`,
  keywords: 'pdf,リーダー,注釈,ハイライト,ノート,markdown,面付け,暗記カード,電子署名,オフライン',
  promotionalText: '広告なし・完全ローカルの PDF リーダー＆ツール。ハイライトが Markdown ノートになります。',
  supportUrl: 'https://solopdf.doaipm.com', marketingUrl: 'https://solopdf.doaipm.com',
  whatsNew: `SoloPDF 1.0 正式版リリース:
• 目次(アウトライン)編集＆自動生成:目次ツリーの編集や、見出しフォントサイズ・章番号パターンからの目次自動生成に対応
• 面付け・レイアウト機能:N-up 集約配置(2/4/6/9/16分割)、小冊子(中綴じ)作成、グレースケール変換＆スキャン背景漂白、ページサイズ統一(A4/A3/Letter)を追加
• 表抽出＆暗記カード出力:選択範囲の表を Markdown / CSV へ即座に抽出。注釈を Anki (.tsv) や Obsidian 暗記カードとして書き出し可能に
• ベクタースタンプ＆縮尺計測:8種類の標準スタンプと日付入りスタンプ、距離・面積の縮尺計測に対応
• 電子署名の検証・署名:PDF 内の X.509 / PKCS#7 電子署名と改ざん状態の検証、証明書による署名に対応
• サポーターバッジ:任意の1回限りチップ(アプリ内課金)で「✨ サポーター」バッジを解除(全機能は100%無料)`,
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

IN-APP PURCHASES (VOLUNTARY TIP JAR): This version includes three optional one-time tip tiers (app.solopdf.tip.coffee, app.solopdf.tip.meal, app.solopdf.tip.feast) via StoreKit. 100% of SoloPDF's PDF reading, annotation, and document processing features are completely free without any purchase. Tipping any tier simply unlocks a cosmetic "✨ Supporter" badge in Settings/Library.

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
  IOS:    { versionString: '1.0.0', buildVersion: '1.0.0' },
  MAC_OS: { versionString: '1.9.0', buildVersion: '1.9.0' },
};

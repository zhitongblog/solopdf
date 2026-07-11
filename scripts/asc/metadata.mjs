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
  description: `SoloPDF 是一款干净、快速、完全本地运行的 PDF 阅读器 —— 没有广告、没有账号、不上传任何数据。

• 阅读体验:多标签、目录大纲、页面缩略图、全文搜索、单页/适宽缩放,超大文件秒开(按需加载,不吃内存)。
• 高亮即笔记:选中文字高亮后,批注自动保存为 PDF 旁边的 Markdown 笔记文件(.annotations.md),可以用任何编辑器(包括我们的 SoloMD)直接打开、编辑、进版本管理;笔记里的 solopdf:// 链接可一键跳回原文位置。
• 表单填写:支持 AcroForm 可填写表单(文本框、勾选框、下拉框),填完直接另存。
• 导出 Markdown:一键把整份 PDF 的文字连同大纲结构导出为 Markdown。
• 深色模式:智能反色,夜间阅读不刺眼。
• 多语言界面:简体中文、繁體中文、English、日本語。

所有处理都在你的设备上完成,不联网、不收集任何数据。`,
  keywords: 'pdf,阅读器,无广告,批注,高亮,笔记,markdown,表单填写,pdf阅读,本地',
  promotionalText: '干净、快速、本地运行的 PDF 阅读器 —— 高亮自动变成 Markdown 笔记。',
  supportUrl: 'https://solopdf.doaipm.com', marketingUrl: 'https://solopdf.doaipm.com',
};

const zhHant = {
  description: `SoloPDF 是一款乾淨、快速、完全本地執行的 PDF 閱讀器 —— 沒有廣告、沒有帳號、不上傳任何資料。

• 閱讀體驗:多分頁、目錄大綱、頁面縮圖、全文搜尋、單頁/適寬縮放,超大檔案秒開(按需載入,不佔記憶體)。
• 螢光筆即筆記:選取文字加上螢光標記後,批註會自動儲存為 PDF 旁邊的 Markdown 筆記檔(.annotations.md),可以用任何編輯器(包括我們的 SoloMD)直接開啟、編輯、納入版本管理;筆記中的 solopdf:// 連結可一鍵跳回原文位置。
• 表單填寫:支援 AcroForm 可填寫表單(文字欄、核取方塊、下拉選單),填完直接另存。
• 匯出 Markdown:一鍵把整份 PDF 的文字連同大綱結構匯出為 Markdown。
• 深色模式:智慧反色,夜間閱讀不刺眼。
• 多語言介面:繁體中文、简体中文、English、日本語。

所有處理都在你的裝置上完成,不連網、不收集任何資料。`,
  keywords: 'pdf,閱讀器,無廣告,批註,螢光筆,筆記,markdown,表單填寫,pdf閱讀,本地',
  promotionalText: '乾淨、快速、本地執行的 PDF 閱讀器 —— 螢光標記自動變成 Markdown 筆記。',
  supportUrl: 'https://solopdf.doaipm.com', marketingUrl: 'https://solopdf.doaipm.com',
};

const enUS = {
  description: `SoloPDF is a clean, fast, fully local PDF reader — no ads, no account, nothing ever uploaded.

• Reading: multiple tabs, outline, page thumbnails, full-text search, fit-width/fit-page zoom. Huge files open instantly thanks to on-demand loading.
• Highlights become notes: highlight any text and the annotation is saved as a Markdown notes file (.annotations.md) right next to the PDF — open, edit, and version it with any editor (including our SoloMD). solopdf:// links inside the notes jump straight back to the highlighted passage.
• Forms: fill AcroForm PDFs (text fields, checkboxes, dropdowns) and save the result.
• Export to Markdown: turn a whole PDF into a Markdown document, outline headings included.
• Dark mode with smart page inversion for comfortable night reading.
• Interface in English, 简体中文, 繁體中文, and 日本語.

Everything runs on your device. No network calls, no data collection.`,
  keywords: 'pdf,reader,annotate,highlight,markdown,notes,forms,viewer,offline,documents',
  promotionalText: 'A clean, fast, local-first PDF reader — highlights become Markdown notes.',
  supportUrl: 'https://solopdf.doaipm.com', marketingUrl: 'https://solopdf.doaipm.com',
};

const ja = {
  description: `SoloPDF は、広告なし・アカウント不要・完全ローカル動作のクリーンで高速な PDF リーダーです。データが送信されることは一切ありません。

• 快適な閲覧:マルチタブ、目次アウトライン、ページサムネイル、全文検索、幅合わせ/ページ全体表示。オンデマンド読み込みで巨大なファイルも一瞬で開きます。
• ハイライトがそのままノートに:テキストをハイライトすると、注釈が PDF と同じ場所に Markdown ノートファイル(.annotations.md)として保存されます。任意のエディタ(SoloMD を含む)で開いて編集でき、ノート内の solopdf:// リンクから元の箇所へワンタップで戻れます。
• フォーム入力:AcroForm 対応(テキスト欄・チェックボックス・ドロップダウン)。入力後はそのまま保存できます。
• Markdown 書き出し:PDF 全体をアウトライン見出し付きの Markdown に変換。
• ダークモード:スマート反転で夜間も目に優しい表示。
• インターフェイスは日本語・English・简体中文・繁體中文に対応。

すべての処理は端末内で完結します。通信もデータ収集も行いません。`,
  keywords: 'pdf,リーダー,注釈,ハイライト,ノート,markdown,フォーム,閲覧,オフライン',
  promotionalText: '広告なし・完全ローカルの PDF リーダー。ハイライトが Markdown ノートになります。',
  supportUrl: 'https://solopdf.doaipm.com', marketingUrl: 'https://solopdf.doaipm.com',
};

// whatsNew is intentionally absent — Apple rejects it on an app's first version.
// Add it here (per locale) from the second release onward.
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
  notes: `SoloPDF is a fully local PDF reader. No account needed, no server component.

FIX FOR THE PREVIOUS REJECTION (2.1a "error when open a PDF document"): the iOS file picker returned file:// URLs which our file layer treated as raw paths, so opening any picked document failed. We reproduced your exact flow (Open PDF > Files picker > select a PDF) on an iPad simulator, fixed the path normalization, and verified end-to-end that picked PDFs now open correctly (build 0.4.2).

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

// Screenshots per platform. Same images for every locale (UI language shown: en for iOS,
// zh for mac scene 1; Apple allows any localization to share screenshots).
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
  IOS:    { versionString: '0.4.2', buildVersion: '0.4.2' },
  MAC_OS: { versionString: '1.3.1', buildVersion: '1.3.1' },
};

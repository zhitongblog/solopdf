// SoloPDF Rust backend: boundary ops only (file IO, hashing, OS glue).
// The hot path is pdf.js in the WebView; nothing here is a tight loop
// except read_chunk, which stays allocation-lean via ipc::Response.

use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

pub mod ocr;
pub mod pdfops;

#[derive(Serialize)]
struct FileMeta {
    path: String,
    name: String,
    size: u64,
}

#[derive(Serialize)]
struct SidecarRead {
    text: String,
    location: String,
}

#[tauri::command]
fn file_meta(path: String) -> Result<FileMeta, String> {
    let md = fs::metadata(&path).map_err(|e| format!("无法读取文件: {e}"))?;
    if !md.is_file() {
        return Err("不是一个文件".into());
    }
    let name = Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    Ok(FileMeta { path, name, size: md.len() })
}

/// Binary chunk read via ipc::Response — ArrayBuffer on the JS side, no base64.
#[tauri::command]
fn read_chunk(path: String, offset: u64, length: u64) -> Result<tauri::ipc::Response, String> {
    let mut f = fs::File::open(&path).map_err(|e| format!("打开失败: {e}"))?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    if offset >= size {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    }
    let len = length.min(size - offset).min(64 * 1024 * 1024) as usize;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
    Ok(tauri::ipc::Response::new(buf))
}

fn sidecar_sibling(pdf_path: &str) -> PathBuf {
    let p = Path::new(pdf_path);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    p.with_file_name(format!("{stem}.annotations.md"))
}

/// Fallback sidecar path keyed by ABSOLUTE-PATH hash (never content hash —
/// content changes would orphan the whole sidecar before anchor relocation
/// even runs; see design doc).
fn sidecar_fallback(app: &tauri::AppHandle, pdf_path: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("annotations");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let h = twox_hash::XxHash3_64::oneshot(pdf_path.as_bytes());
    // keep a path→sidecar index for debuggability / future migration
    let index = dir.join("index.json");
    let mut map: serde_json::Map<String, serde_json::Value> = fs::read_to_string(&index)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let file = format!("{h:016x}.md");
    if map.get(pdf_path).is_none() {
        map.insert(pdf_path.to_string(), serde_json::Value::String(file.clone()));
        let _ = fs::write(&index, serde_json::to_string_pretty(&map).unwrap_or_default());
    }
    Ok(dir.join(file))
}

#[tauri::command]
fn read_sidecar(app: tauri::AppHandle, pdf_path: String) -> Result<SidecarRead, String> {
    let sib = sidecar_sibling(&pdf_path);
    if sib.exists() {
        return Ok(SidecarRead {
            text: fs::read_to_string(&sib).map_err(|e| e.to_string())?,
            location: sib.to_string_lossy().into_owned(),
        });
    }
    let fb = sidecar_fallback(&app, &pdf_path)?;
    if fb.exists() {
        return Ok(SidecarRead {
            text: fs::read_to_string(&fb).map_err(|e| e.to_string())?,
            location: fb.to_string_lossy().into_owned(),
        });
    }
    // nothing yet: report the sibling as the intended location
    Ok(SidecarRead { text: String::new(), location: sib.to_string_lossy().into_owned() })
}

#[tauri::command]
fn write_sidecar(app: tauri::AppHandle, pdf_path: String, text: String) -> Result<String, String> {
    let sib = sidecar_sibling(&pdf_path);
    match fs::write(&sib, &text) {
        Ok(()) => Ok(sib.to_string_lossy().into_owned()),
        Err(_) => {
            // read-only volume / sandbox denial → appData fallback
            let fb = sidecar_fallback(&app, &pdf_path)?;
            fs::write(&fb, &text).map_err(|e| format!("伴生文件写入失败: {e}"))?;
            Ok(fb.to_string_lossy().into_owned())
        }
    }
}

/// `<stem>.annotations.assets/` beside the sidecar — region screenshots.
/// Mirrors the sidecar's sibling-first / appData-fallback rule so a
/// read-only volume degrades the same way the notes file does.
fn assets_dir(app: &tauri::AppHandle, pdf_path: &str, create: bool) -> Result<PathBuf, String> {
    let p = Path::new(pdf_path);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let sibling = p.with_file_name(format!("{stem}.annotations.assets"));
    if !create {
        // reads must never create anything: a reader that litters empty
        // folders beside every PDF it opens is a bug report waiting to happen
        if sibling.is_dir() {
            return Ok(sibling);
        }
        return Ok(sidecar_fallback(app, pdf_path)?.with_extension("assets"));
    }
    if fs::create_dir_all(&sibling).is_ok() {
        return Ok(sibling);
    }
    let fb = sidecar_fallback(app, pdf_path)?;
    let dir = fb.with_extension("assets");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Reject anything that could escape the assets folder: this name reaches
/// the filesystem and originates in a Markdown file the user can edit.
fn safe_asset_name(name: &str) -> Result<String, String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.starts_with('.')
    {
        return Err("非法的资源名".into());
    }
    Ok(name.to_string())
}

#[tauri::command]
fn write_sidecar_asset(app: tauri::AppHandle, request: tauri::ipc::Request) -> Result<String, String> {
    let header = |k: &str| -> Result<String, String> {
        request
            .headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| format!("缺少 {k}"))
            .and_then(urlencoding_decode)
    };
    let pdf_path = header("x-pdf")?;
    let name = safe_asset_name(&header("x-name")?)?;
    let dir = assets_dir(&app, &pdf_path, true)?;
    let dest = dir.join(&name);
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            fs::write(&dest, bytes).map_err(|e| format!("资源写入失败: {e}"))?;
            Ok(dest.to_string_lossy().into_owned())
        }
        _ => Err("expected raw body".into()),
    }
}

#[tauri::command]
fn read_sidecar_asset(
    app: tauri::AppHandle,
    pdf_path: String,
    name: String,
) -> Result<tauri::ipc::Response, String> {
    let name = safe_asset_name(&name)?;
    let dir = assets_dir(&app, &pdf_path, false)?;
    // empty response = "not there"; the frontend treats it as a missing image
    Ok(tauri::ipc::Response::new(
        fs::read(dir.join(name)).unwrap_or_default(),
    ))
}

fn state_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.json"))
}

#[tauri::command]
fn load_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let f = state_file(&app)?;
    if !f.exists() {
        return Ok(serde_json::json!({}));
    }
    let text = fs::read_to_string(&f).map_err(|e| e.to_string())?;
    // strip UTF-8 BOM: an external editor (or PowerShell) saving state.json
    // with a BOM would otherwise silently reset ALL settings to defaults
    let text = text.trim_start_matches('\u{feff}');
    Ok(serde_json::from_str(text).unwrap_or_else(|_| serde_json::json!({})))
}

#[tauri::command]
fn save_state(app: tauri::AppHandle, state: serde_json::Value) -> Result<(), String> {
    let f = state_file(&app)?;
    fs::write(&f, serde_json::to_string(&state).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// Full-content xxhash — called AFTER first render, from an async task,
/// never on the open path (design doc: lazy hashing rule).
#[tauri::command]
async fn file_hash(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut f = fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut hasher = twox_hash::XxHash3_64::new();
        let mut buf = vec![0u8; 4 * 1024 * 1024];
        loop {
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.write(&buf[..n]);
        }
        Ok(format!("{:016x}", hasher.finish()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(desktop)]
#[tauri::command]
fn reveal_file(_app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[cfg(mobile)]
#[tauri::command]
fn reveal_file(_app: tauri::AppHandle, _path: String) -> Result<(), String> {
    Ok(())
}

/// Mobile export target: app Documents dir (visible in the iOS Files app
/// thanks to UIFileSharingEnabled). Save dialogs don't exist on iOS.
#[tauri::command]
fn save_to_documents(app: tauri::AppHandle, name: String, text: String) -> Result<String, String> {
    let dir = app.path().document_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(name);
    fs::write(&dest, text).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Mobile export of binary data (page images): raw body, name in a header.
#[tauri::command]
fn save_bytes_to_documents(app: tauri::AppHandle, request: tauri::ipc::Request) -> Result<String, String> {
    let raw = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "缺少名称".to_string())?;
    let name = safe_asset_name(&urlencoding_decode(raw)?)?;
    let dir = app.path().document_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(name);
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            fs::write(&dest, bytes).map_err(|e| format!("保存失败: {e}"))?;
            Ok(dest.to_string_lossy().into_owned())
        }
        _ => Err("expected raw body".into()),
    }
}

/// Filled-form PDF save: raw binary body (no JSON copy), dest in header.
#[tauri::command]
fn save_pdf_bytes(request: tauri::ipc::Request) -> Result<(), String> {
    let dest = request
        .headers()
        .get("x-dest")
        .and_then(|v| v.to_str().ok())
        .ok_or("缺少目标路径")?;
    let dest = urlencoding_decode(dest)?;
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            fs::write(&dest, bytes).map_err(|e| format!("保存失败: {e}"))
        }
        _ => Err("expected raw body".into()),
    }
}

/// minimal percent-decoding (avoid a full urlencoding crate for one call)
fn urlencoding_decode(s: &str) -> Result<String, String> {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
                out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

/// OCR one image (PNG/JPEG raw body). Returns the recognized lines as a
/// JSON string; language hints via x-langs (CSV); x-photo: 1 marks camera
/// shots (document detection + perspective correction on Apple platforms).
#[tauri::command]
async fn ocr_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let langs: Vec<String> = request
        .headers()
        .get("x-langs")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
        .unwrap_or_default();
    let photo = request
        .headers()
        .get("x-photo")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == "1")
        .unwrap_or(false);
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("expected raw image body".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let lines = ocr::recognize(&bytes, &langs, photo)?;
        serde_json::to_string(&lines).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Which OCR engine this build carries ("vision" / "ppocr").
#[tauri::command]
fn ocr_engine() -> &'static str {
    ocr::engine_name()
}

/// Write a searchable copy of `src_path` with the given per-page OCR lines
/// (already in PDF user-space points). `dest_path: None` → app Documents
/// dir (iOS, where save dialogs don't exist). Returns the written path.
#[tauri::command]
async fn ocr_make_searchable(
    app: tauri::AppHandle,
    src_path: String,
    dest_path: Option<String>,
    pages: Vec<ocr::textlayer::PageOcr>,
) -> Result<String, String> {
    let dest = match dest_path {
        Some(d) => PathBuf::from(d),
        None => {
            let dir = app.path().document_dir().map_err(|e| e.to_string())?;
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let stem = Path::new(&src_path)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "document".into());
            dir.join(format!("{stem}-ocr.pdf"))
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        let pdf = fs::read(&src_path).map_err(|e| format!("读取原 PDF 失败: {e}"))?;
        let out = ocr::textlayer::add_text_layer(&pdf, &pages)?;
        fs::write(&dest, out).map_err(|e| format!("写入失败: {e}"))?;
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── document operations (pdfops) ─────────────────────────────────────────
// Every one of these READS a source file and WRITES a new one. `dest` is
// optional: on iOS there are no save dialogs, so None means "app Documents
// dir", the same rule ocr_make_searchable already follows.

fn resolve_dest(app: &tauri::AppHandle, src: &str, dest: Option<String>, suffix: &str, ext: &str) -> Result<PathBuf, String> {
    if let Some(d) = dest {
        return Ok(PathBuf::from(d));
    }
    let dir = app.path().document_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = Path::new(src)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".into());
    Ok(dir.join(format!("{stem}{suffix}.{ext}")))
}

fn write_out(dest: PathBuf, bytes: Vec<u8>) -> Result<String, String> {
    fs::write(&dest, bytes).map_err(|e| format!("写入失败: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
async fn pdf_write_annotations(
    app: tauri::AppHandle,
    src_path: String,
    dest_path: Option<String>,
    password: Option<String>,
    annots: Vec<pdfops::AnnotSpec>,
) -> Result<String, String> {
    let dest = resolve_dest(&app, &src_path, dest_path, "-annotated", "pdf")?;
    tauri::async_runtime::spawn_blocking(move || {
        let pdf = fs::read(&src_path).map_err(|e| format!("读取失败: {e}"))?;
        write_out(dest, pdfops::write_annotations(&pdf, password.as_deref(), &annots)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pdf_rotate_pages(
    app: tauri::AppHandle,
    src_path: String,
    dest_path: Option<String>,
    password: Option<String>,
    pages: Vec<u32>,
    degrees: i64,
) -> Result<String, String> {
    let dest = resolve_dest(&app, &src_path, dest_path, "-rotated", "pdf")?;
    tauri::async_runtime::spawn_blocking(move || {
        let pdf = fs::read(&src_path).map_err(|e| format!("读取失败: {e}"))?;
        write_out(dest, pdfops::rotate_pages(&pdf, password.as_deref(), &pages, degrees)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pdf_arrange_pages(
    app: tauri::AppHandle,
    src_path: String,
    dest_path: Option<String>,
    password: Option<String>,
    order: Vec<u32>,
) -> Result<String, String> {
    let dest = resolve_dest(&app, &src_path, dest_path, "-pages", "pdf")?;
    tauri::async_runtime::spawn_blocking(move || {
        let pdf = fs::read(&src_path).map_err(|e| format!("读取失败: {e}"))?;
        write_out(dest, pdfops::arrange_pages(&pdf, password.as_deref(), &order)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pdf_merge(
    app: tauri::AppHandle,
    src_paths: Vec<String>,
    dest_path: Option<String>,
) -> Result<String, String> {
    let first = src_paths.first().cloned().unwrap_or_default();
    let dest = resolve_dest(&app, &first, dest_path, "-merged", "pdf")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut inputs = Vec::new();
        for p in &src_paths {
            inputs.push((fs::read(p).map_err(|e| format!("读取 {p} 失败: {e}"))?, None));
        }
        write_out(dest, pdfops::merge(&inputs)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pdf_split(
    app: tauri::AppHandle,
    src_path: String,
    dest_dir: Option<String>,
    password: Option<String>,
    ranges: Vec<(u32, u32)>,
) -> Result<Vec<String>, String> {
    let dir = match dest_dir {
        Some(d) => PathBuf::from(d),
        None => app.path().document_dir().map_err(|e| e.to_string())?,
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = Path::new(&src_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".into());
    tauri::async_runtime::spawn_blocking(move || {
        let pdf = fs::read(&src_path).map_err(|e| format!("读取失败: {e}"))?;
        let parts = pdfops::split(&pdf, password.as_deref(), &ranges)?;
        let mut out = Vec::new();
        for (i, bytes) in parts.into_iter().enumerate() {
            let (from, to) = ranges[i];
            out.push(write_out(dir.join(format!("{stem}-{from}-{to}.pdf")), bytes)?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pdf_from_images(
    app: tauri::AppHandle,
    image_paths: Vec<String>,
    dest_path: Option<String>,
    dpi: f32,
) -> Result<String, String> {
    let first = image_paths.first().cloned().unwrap_or_default();
    let dest = resolve_dest(&app, &first, dest_path, "", "pdf")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut images = Vec::new();
        for p in &image_paths {
            images.push(fs::read(p).map_err(|e| format!("读取 {p} 失败: {e}"))?);
        }
        write_out(dest, pdfops::images_to_pdf(&images, dpi)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct CompressResult {
    path: String,
    before: u64,
    after: u64,
}

#[tauri::command]
async fn pdf_compress(
    app: tauri::AppHandle,
    src_path: String,
    dest_path: Option<String>,
    password: Option<String>,
    max_dim: u32,
    quality: u8,
) -> Result<CompressResult, String> {
    let dest = resolve_dest(&app, &src_path, dest_path, "-compressed", "pdf")?;
    tauri::async_runtime::spawn_blocking(move || {
        let pdf = fs::read(&src_path).map_err(|e| format!("读取失败: {e}"))?;
        let before = pdf.len() as u64;
        let out = pdfops::compress_pdf(&pdf, password.as_deref(), max_dim, quality)?;
        let after = out.len() as u64;
        Ok(CompressResult { path: write_out(dest, out)?, before, after })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Deserialize)]
struct StampInput {
    page: u32,
    rect: [f32; 4],
    /// path of a PNG saved by save_signature (or a temp text stamp)
    image_path: String,
}

#[tauri::command]
async fn pdf_stamp(
    app: tauri::AppHandle,
    src_path: String,
    dest_path: Option<String>,
    password: Option<String>,
    stamps: Vec<StampInput>,
) -> Result<String, String> {
    let dest = resolve_dest(&app, &src_path, dest_path, "-signed", "pdf")?;
    tauri::async_runtime::spawn_blocking(move || {
        let pdf = fs::read(&src_path).map_err(|e| format!("读取失败: {e}"))?;
        let mut specs = Vec::new();
        for s in &stamps {
            specs.push(pdfops::StampSpec {
                page: s.page,
                rect: s.rect,
                png: fs::read(&s.image_path).map_err(|e| format!("读取签名失败: {e}"))?,
            });
        }
        write_out(dest, pdfops::stamp_images(&pdf, password.as_deref(), &specs)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pdf_set_password(
    app: tauri::AppHandle,
    src_path: String,
    dest_path: Option<String>,
    current: Option<String>,
    user: String,
    owner: String,
) -> Result<String, String> {
    let dest = resolve_dest(&app, &src_path, dest_path, "-protected", "pdf")?;
    tauri::async_runtime::spawn_blocking(move || {
        let pdf = fs::read(&src_path).map_err(|e| format!("读取失败: {e}"))?;
        write_out(dest, pdfops::set_password(&pdf, current.as_deref(), &user, &owner)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pdf_remove_password(
    app: tauri::AppHandle,
    src_path: String,
    dest_path: Option<String>,
    password: String,
) -> Result<String, String> {
    let dest = resolve_dest(&app, &src_path, dest_path, "-unlocked", "pdf")?;
    tauri::async_runtime::spawn_blocking(move || {
        let pdf = fs::read(&src_path).map_err(|e| format!("读取失败: {e}"))?;
        write_out(dest, pdfops::remove_password(&pdf, &password)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct UserDict {
    name: String,
    text: String,
}

/// Plain-text dictionaries the user dropped into <appData>/dictionaries.
/// One `word<TAB>definition` per line; capped so a stray 100MB file can't
/// wedge the lookup popover.
#[tauri::command]
fn read_user_dicts(app: tauri::AppHandle) -> Result<Vec<UserDict>, String> {
    const MAX: u64 = 8 * 1024 * 1024;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("dictionaries");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        if p.extension().map(|x| x != "txt" && x != "tsv").unwrap_or(true) {
            continue;
        }
        if fs::metadata(&p).map(|m| m.len() > MAX).unwrap_or(true) {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&p) {
            out.push(UserDict {
                name: p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                text,
            });
        }
    }
    Ok(out)
}

/// Show the system dictionary for a word (Dictionary.app on macOS, the
/// system look-up panel on iOS). Returns "shown" | "none" | "unsupported";
/// the frontend falls back to the bundled CC-CEDICT shards on anything but
/// "shown".
#[cfg(any(target_os = "macos", target_os = "ios"))]
#[tauri::command]
fn define_word(word: String) -> &'static str {
    extern "C" {
        fn solopdf_define_word(word: *const std::os::raw::c_char) -> std::os::raw::c_int;
    }
    let Ok(c) = std::ffi::CString::new(word) else { return "unsupported" };
    match unsafe { solopdf_define_word(c.as_ptr()) } {
        0 => "shown",
        1 => "none",
        _ => "unsupported",
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
#[tauri::command]
fn define_word(_word: String) -> &'static str {
    "unsupported"
}

// ── library ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct ScannedFile {
    path: String,
    name: String,
    size: u64,
    modified: u64,
}

/// Find readable documents under a folder. Depth-limited and count-capped:
/// someone will point this at their home directory, and a shelf that hangs
/// for a minute is worse than one that says "too many files".
#[tauri::command]
async fn scan_folder(path: String, max_depth: u32) -> Result<Vec<ScannedFile>, String> {
    const EXTS: [&str; 7] = ["pdf", "epub", "txt", "cbz", "cbr", "mobi", "azw3"];
    const MAX_FILES: usize = 5000;
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        let mut stack = vec![(PathBuf::from(&path), 0u32)];
        while let Some((dir, depth)) = stack.pop() {
            if out.len() >= MAX_FILES {
                break;
            }
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let p = entry.path();
                let Ok(md) = entry.metadata() else { continue };
                if md.is_dir() {
                    // hidden folders are caches and version-control noise
                    let hidden = p
                        .file_name()
                        .map(|n| n.to_string_lossy().starts_with('.'))
                        .unwrap_or(false);
                    if !hidden && depth < max_depth {
                        stack.push((p, depth + 1));
                    }
                    continue;
                }
                let ext = p
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if !EXTS.contains(&ext.as_str()) {
                    continue;
                }
                out.push(ScannedFile {
                    name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    path: p.to_string_lossy().into_owned(),
                    size: md.len(),
                    modified: md
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                });
                if out.len() >= MAX_FILES {
                    break;
                }
            }
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn covers_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("covers");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Cover thumbnails live in appData keyed by a hash of the path — never
/// beside the document, which may sit in a folder the user shares.
#[tauri::command]
fn write_cover(app: tauri::AppHandle, request: tauri::ipc::Request) -> Result<String, String> {
    let raw = request
        .headers()
        .get("x-key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "缺少 key".to_string())?;
    let key = safe_asset_name(&urlencoding_decode(raw)?)?;
    let dest = covers_dir(&app)?.join(format!("{key}.jpg"));
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            fs::write(&dest, bytes).map_err(|e| format!("封面写入失败: {e}"))?;
            Ok(dest.to_string_lossy().into_owned())
        }
        _ => Err("expected raw body".into()),
    }
}

#[tauri::command]
fn read_cover(app: tauri::AppHandle, key: String) -> Result<tauri::ipc::Response, String> {
    let key = safe_asset_name(&key)?;
    let p = covers_dir(&app)?.join(format!("{key}.jpg"));
    Ok(tauri::ipc::Response::new(fs::read(p).unwrap_or_default()))
}

fn cache_dir(app: &tauri::AppHandle, kind: &str) -> Result<PathBuf, String> {
    let kind = safe_asset_name(kind)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("cache").join(kind);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Generic app-data cache (search indexes today). Keyed, never beside the
/// user's documents, and wholly disposable — clear_cache is a supported
/// operation, not a repair.
#[tauri::command]
fn write_cache(app: tauri::AppHandle, request: tauri::ipc::Request) -> Result<(), String> {
    let header = |k: &str| -> Result<String, String> {
        let raw = request
            .headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| format!("缺少 {k}"))?;
        urlencoding_decode(raw)
    };
    let kind = header("x-kind")?;
    let key = safe_asset_name(&header("x-key")?)?;
    let dest = cache_dir(&app, &kind)?.join(key);
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            fs::write(&dest, bytes).map_err(|e| format!("缓存写入失败: {e}"))
        }
        _ => Err("expected raw body".into()),
    }
}

#[tauri::command]
fn read_cache(app: tauri::AppHandle, kind: String, key: String) -> Result<tauri::ipc::Response, String> {
    let key = safe_asset_name(&key)?;
    let p = cache_dir(&app, &kind)?.join(key);
    Ok(tauri::ipc::Response::new(fs::read(p).unwrap_or_default()))
}

#[tauri::command]
fn list_cache(app: tauri::AppHandle, kind: String) -> Result<Vec<String>, String> {
    let dir = cache_dir(&app, &kind)?;
    Ok(fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
        .collect())
}

#[tauri::command]
fn clear_cache(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    let dir = cache_dir(&app, &kind)?;
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

// ── signature library ────────────────────────────────────────────────────
// Signatures live in appData, not beside any document: they are a property
// of the person, and they must never leak into a folder that gets shared.

fn signatures_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("signatures");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
fn save_signature(app: tauri::AppHandle, request: tauri::ipc::Request) -> Result<String, String> {
    let raw = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "缺少名称".to_string())?;
    let name = safe_asset_name(&urlencoding_decode(raw)?)?;
    let dest = signatures_dir(&app)?.join(name);
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            fs::write(&dest, bytes).map_err(|e| format!("保存签名失败: {e}"))?;
            Ok(dest.to_string_lossy().into_owned())
        }
        _ => Err("expected raw body".into()),
    }
}

#[tauri::command]
fn list_signatures(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = signatures_dir(&app)?;
    let mut out: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "png").unwrap_or(false))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    out.sort();
    Ok(out)
}

#[tauri::command]
fn delete_signature(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = signatures_dir(&app)?;
    let p = PathBuf::from(&path);
    // only ever delete inside our own folder
    if !p.starts_with(&dir) {
        return Err("路径不在签名目录内".into());
    }
    fs::remove_file(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(fs::read(&path).unwrap_or_default()))
}

/// Files/deep-links this process was launched with (file association),
/// plus any RunEvent::Opened files that arrived before the frontend was
/// ready(iOS 冷启动"用 SoloPDF 打开":Opened 事件先于前端监听器注册,
/// 直接 emit 会丢——先缓冲,前端起来后由这里一次性取走)。
#[tauri::command]
fn startup_files(state: tauri::State<StartupArgs>) -> Vec<String> {
    state.frontend_ready.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut out = state.argv.clone();
    out.append(&mut state.pending.lock().unwrap());
    out
}

struct StartupArgs {
    argv: Vec<String>,
    /// Opened 事件在前端就绪前收到的文件
    pending: std::sync::Mutex<Vec<String>>,
    frontend_ready: std::sync::atomic::AtomicBool,
}

// ── debug bridge (SOLOPDF_DEBUG=1 only) ────────────────────────────────────
// curl -X POST 127.0.0.1:14310/eval --data 'return 1+1'  → JS eval in webview.
// Flow: HTTP thread enqueues (id, js); the frontend polls debug_poll every
// 200ms, evals, calls debug_report; HTTP thread blocks on the result channel.
struct DebugBridge {
    cmds: std::sync::Mutex<Vec<(u64, String)>>,
    waiters: std::sync::Mutex<std::collections::HashMap<u64, std::sync::mpsc::Sender<String>>>,
    next_id: std::sync::atomic::AtomicU64,
}

impl DebugBridge {
    fn new() -> Self {
        Self {
            cmds: Default::default(),
            waiters: Default::default(),
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }
}

fn debug_enabled_env() -> bool {
    std::env::var("SOLOPDF_DEBUG").map(|v| v == "1").unwrap_or(false)
}

#[tauri::command]
fn debug_enabled() -> bool {
    debug_enabled_env()
}

#[tauri::command]
fn debug_poll(bridge: tauri::State<std::sync::Arc<DebugBridge>>) -> Vec<(u64, String)> {
    std::mem::take(&mut *bridge.cmds.lock().unwrap())
}

#[tauri::command]
fn debug_report(bridge: tauri::State<std::sync::Arc<DebugBridge>>, id: u64, result: String) {
    if let Some(tx) = bridge.waiters.lock().unwrap().remove(&id) {
        let _ = tx.send(result);
    }
}

#[cfg(not(target_os = "android"))]
fn start_debug_server(bridge: std::sync::Arc<DebugBridge>) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http("127.0.0.1:14310") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("debug bridge: bind failed: {e}");
                return;
            }
        };
        eprintln!("debug bridge listening on 127.0.0.1:14310");
        for mut req in server.incoming_requests() {
            let mut body = String::new();
            use std::io::Read as _;
            let _ = req.as_reader().read_to_string(&mut body);
            let id = bridge.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let (tx, rx) = std::sync::mpsc::channel();
            bridge.waiters.lock().unwrap().insert(id, tx);
            bridge.cmds.lock().unwrap().push((id, body));
            let resp = rx
                .recv_timeout(std::time::Duration::from_secs(20))
                .unwrap_or_else(|_| "ERR: eval timeout (is the app frontend running?)".into());
            let _ = req.respond(tiny_http::Response::from_string(resp));
        }
    });
}

/// Native print of the current webview (macOS WKWebView: JS window.print()
/// is a NO-OP — this is why打印 needed a Rust round-trip). Desktop only.
#[cfg(desktop)]
#[tauri::command]
fn print_webview(webview_window: tauri::WebviewWindow) -> Result<(), String> {
    webview_window.print().map_err(|e| e.to_string())
}

#[cfg(mobile)]
#[tauri::command]
fn print_webview() -> Result<(), String> {
    Err("printing is not supported on mobile yet".into())
}

fn collect_open_args(args: impl Iterator<Item = String>) -> Vec<String> {
    args.skip(1)
        .filter(|a| a.ends_with(".pdf") || a.ends_with(".epub") || a.ends_with(".txt") || a.starts_with("solopdf://"))
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        // second launch: forward its files/links to the running window
        let files = collect_open_args(argv.into_iter());
        if !files.is_empty() {
            let _ = app.emit("solopdf://open-files", files);
        }
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_focus();
        }
    }));
    builder
        .manage(StartupArgs {
            argv: collect_open_args(std::env::args()),
            pending: std::sync::Mutex::new(Vec::new()),
            frontend_ready: std::sync::atomic::AtomicBool::new(false),
        })
        .manage(std::sync::Arc::new(DebugBridge::new()))
        .invoke_handler(tauri::generate_handler![
            file_meta,
            read_chunk,
            read_sidecar,
            write_sidecar,
            write_sidecar_asset,
            read_sidecar_asset,
            pdf_write_annotations,
            pdf_rotate_pages,
            pdf_arrange_pages,
            pdf_merge,
            pdf_split,
            pdf_from_images,
            pdf_compress,
            pdf_stamp,
            pdf_set_password,
            pdf_remove_password,
            define_word,
            read_user_dicts,
            scan_folder,
            write_cover,
            read_cover,
            file_exists,
            write_cache,
            read_cache,
            list_cache,
            clear_cache,
            save_signature,
            list_signatures,
            delete_signature,
            read_file_bytes,
            load_state,
            save_state,
            file_hash,
            reveal_file,
            save_pdf_bytes,
            save_to_documents,
            save_bytes_to_documents,
            startup_files,
            ocr_image,
            ocr_engine,
            ocr_make_searchable,
            debug_enabled,
            debug_poll,
            debug_report,
            print_webview,
        ])
        .setup(|app| {
            #[cfg(not(target_os = "android"))]
            if debug_enabled_env() {
                let bridge = app.state::<std::sync::Arc<DebugBridge>>();
                start_debug_server(bridge.inner().clone());
            }
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register("solopdf");
                // PP-OCR models ship as bundled resources on these platforms
                if let Ok(dir) = app.path().resource_dir() {
                    crate::ocr::ppocr::set_model_dir(dir.join("assets/ppocr"));
                }
            }
            let _ = app;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building SoloPDF")
        .run(|app, event| {
            // Finder double-click / iOS Files "open with" arrive as Opened
            // events (NOT argv) — forward them to the frontend just like
            // second-instance launches. The variant only exists on macOS/iOS.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &event {
                let files: Vec<String> = urls.iter().map(|u| u.to_string()).collect();
                if !files.is_empty() {
                    let args = app.state::<StartupArgs>();
                    if args.frontend_ready.load(std::sync::atomic::Ordering::SeqCst) {
                        let _ = app.emit("solopdf://open-files", files);
                    } else {
                        args.pending.lock().unwrap().extend(files);
                    }
                }
            }
            let _ = (&app, &event);
        });
}

use std::hash::Hasher as _;

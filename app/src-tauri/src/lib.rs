// SoloPDF Rust backend: boundary ops only (file IO, hashing, OS glue).
// The hot path is pdf.js in the WebView; nothing here is a tight loop
// except read_chunk, which stays allocation-lean via ipc::Response.

use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

pub mod ocr;

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

/// Files/deep-links this process was launched with (file association).
#[tauri::command]
fn startup_files(state: tauri::State<StartupArgs>) -> Vec<String> {
    state.0.clone()
}

struct StartupArgs(Vec<String>);

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
        .filter(|a| a.ends_with(".pdf") || a.starts_with("solopdf://"))
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
        .manage(StartupArgs(collect_open_args(std::env::args())))
        .manage(std::sync::Arc::new(DebugBridge::new()))
        .invoke_handler(tauri::generate_handler![
            file_meta,
            read_chunk,
            read_sidecar,
            write_sidecar,
            load_state,
            save_state,
            file_hash,
            reveal_file,
            save_pdf_bytes,
            save_to_documents,
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
                    let _ = app.emit("solopdf://open-files", files);
                }
            }
            let _ = (&app, &event);
        });
}

use std::hash::Hasher as _;

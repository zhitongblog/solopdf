// SoloPDF Rust backend: boundary ops only (file IO, hashing, OS glue).
// The hot path is pdf.js in the WebView; nothing here is a tight loop
// except read_chunk, which stays allocation-lean via ipc::Response.

use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

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
    Ok(serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({})))
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

#[tauri::command]
fn reveal_file(_app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
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

/// Files/deep-links this process was launched with (file association).
#[tauri::command]
fn startup_files(state: tauri::State<StartupArgs>) -> Vec<String> {
    state.0.clone()
}

struct StartupArgs(Vec<String>);

fn collect_open_args(args: impl Iterator<Item = String>) -> Vec<String> {
    args.skip(1)
        .filter(|a| a.ends_with(".pdf") || a.starts_with("solopdf://"))
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // second launch: forward its files/links to the running window
            let files = collect_open_args(argv.into_iter());
            if !files.is_empty() {
                let _ = app.emit("solopdf://open-files", files);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .manage(StartupArgs(collect_open_args(std::env::args())))
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
            startup_files,
        ])
        .setup(|app| {
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register("solopdf");
            }
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running SoloPDF");
}

use std::hash::Hasher as _;

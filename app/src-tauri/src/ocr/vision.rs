// Apple Vision engine — FFI into vision_shim/ocr_shim.m.

use super::OcrLine;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

extern "C" {
    fn solopdf_vision_ocr(bytes: *const u8, len: usize, langs_csv: *const c_char) -> *mut c_char;
    fn solopdf_ocr_free(p: *mut c_char);
}

pub fn recognize(bytes: &[u8], langs: &[String]) -> Result<Vec<OcrLine>, String> {
    let csv = CString::new(langs.join(",")).map_err(|e| e.to_string())?;
    let raw = unsafe { solopdf_vision_ocr(bytes.as_ptr(), bytes.len(), csv.as_ptr()) };
    if raw.is_null() {
        return Err("vision shim returned null".into());
    }
    let json = unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned();
    unsafe { solopdf_ocr_free(raw) };

    if let Ok(err) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json) {
        if let Some(msg) = err.get("error").and_then(|v| v.as_str()) {
            return Err(format!("Vision OCR: {msg}"));
        }
    }
    serde_json::from_str::<Vec<OcrLine>>(&json).map_err(|e| format!("vision json: {e}"))
}

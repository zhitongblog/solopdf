// Translation: the on-device Apple engine (vision_shim/translate_shim.swift)
// plus a minimal HTTPS POST for the optional user-configured provider.
//
// The engine answers with the shim's JSON verbatim so the app, the CLI and
// the MCP server all see the same shape:
//   {"text","source","target"}  or  {"error","code","source"?,"target"?}
// code: notInstalled | unsupported | unavailable | same | empty | cancelled | failed
//
// The provider request itself is built in @solopdf/core (shared with the CLI);
// Rust only carries it, because a WebView fetch to DeepL is blocked by CORS.
// Nothing here runs unless the reader turned the provider on in Settings.

use serde_json::{json, Value};

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple {
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int};

    extern "C" {
        fn solopdf_translate(text: *const c_char, target: *const c_char, fallback: *const c_char) -> *mut c_char;
        fn solopdf_translate_prepare(source: *const c_char, target: *const c_char) -> *mut c_char;
        fn solopdf_translate_available() -> c_int;
        fn solopdf_translate_free(p: *mut c_char);
        fn solopdf_translate_open_settings() -> c_int;
    }

    pub fn open_settings() -> bool {
        unsafe { solopdf_translate_open_settings() == 1 }
    }

    fn take(raw: *mut c_char) -> String {
        if raw.is_null() {
            return r#"{"error":"translation shim returned null","code":"failed"}"#.into();
        }
        let s = unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned();
        unsafe { solopdf_translate_free(raw) };
        s
    }

    fn c(s: &str) -> CString {
        // an interior NUL would make CString fail; it can only be noise here
        CString::new(s.replace('\0', " ")).unwrap_or_default()
    }

    pub fn translate(text: &str, target: &str, fallback: &str) -> String {
        let (t, g, f) = (c(text), c(target), c(fallback));
        take(unsafe { solopdf_translate(t.as_ptr(), g.as_ptr(), f.as_ptr()) })
    }

    pub fn prepare(source: &str, target: &str) -> String {
        let (s, t) = (c(source), c(target));
        take(unsafe { solopdf_translate_prepare(s.as_ptr(), t.as_ptr()) })
    }

    pub fn available() -> i32 {
        unsafe { solopdf_translate_available() }
    }
}

/// "apple" (headless, macOS 26+/iOS 26+), "apple-hosted" (macOS 15+/iOS 18+,
/// briefly shows a small panel) or "none".
pub fn engine_name() -> &'static str {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        match apple::available() {
            2 => "apple",
            1 => "apple-hosted",
            _ => "none",
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        "none"
    }
}

fn parse(raw: String) -> Value {
    serde_json::from_str(&raw).unwrap_or_else(|e| json!({ "error": format!("bad shim json: {e}"), "code": "failed" }))
}

/// Translate on device. `target` empty = `fallback`; when the text is already
/// in `target`, `fallback` is used instead (see the shim).
pub fn translate(text: &str, target: &str, fallback: &str) -> Value {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        parse(apple::translate(text, target, fallback))
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (text, target, fallback, parse as fn(String) -> Value);
        json!({ "error": "no on-device translation on this platform", "code": "unavailable" })
    }
}

/// Ask the system to download the language pair (its own consent sheet).
pub fn prepare(source: &str, target: &str) -> Value {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        parse(apple::prepare(source, target))
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (source, target);
        json!({ "error": "no on-device translation on this platform", "code": "unavailable" })
    }
}

/// macOS: open System Settings at Language & Region → Translation Languages.
pub fn open_settings() -> bool {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        apple::open_settings()
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        false
    }
}

/// POST a JSON body for the translation provider. https only, except a
/// loopback http endpoint (a local model server such as Ollama / LM Studio).
/// Returns `{status, body}` — status errors are the caller's to explain.
#[cfg(not(target_os = "android"))]
pub fn http_post(url: &str, headers: &[(String, String)], body: &str) -> Result<Value, String> {
    let lower = url.to_ascii_lowercase();
    let loopback = ["http://localhost", "http://127.0.0.1", "http://[::1]"]
        .iter()
        .any(|p| lower.starts_with(p));
    if !lower.starts_with("https://") && !loopback {
        return Err("only https:// endpoints (or a local http://localhost server) are allowed".into());
    }
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        // the OS trust store, same as every other app on the machine
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(tls)
        .timeout_global(Some(std::time::Duration::from_secs(60)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut req = agent.post(url);
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let mut res = req
        .header("content-type", "application/json")
        .send(body)
        .map_err(|e| format!("network error: {e}"))?;
    let status = res.status().as_u16();
    let text = res
        .body_mut()
        .with_config()
        .limit(4 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| format!("read error: {e}"))?;
    Ok(json!({ "status": status, "body": text }))
}

#[cfg(target_os = "android")]
pub fn http_post(_url: &str, _headers: &[(String, String)], _body: &str) -> Result<Value, String> {
    // Android has no native TLS stack in this build; the WebView's own fetch
    // is used there instead (see app/src/translate.ts)
    Err("unsupported".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_plain_http() {
        let e = http_post("http://example.com/v1", &[], "{}").unwrap_err();
        assert!(e.contains("https"));
    }

    #[test]
    fn empty_text_is_reported_not_translated() {
        let v = translate("   ", "en", "");
        let code = v["code"].as_str().unwrap();
        assert!(code == "empty" || code == "unavailable", "{v}");
    }

    #[test]
    fn engine_name_is_known() {
        assert!(["apple", "apple-hosted", "none"].contains(&engine_name()));
    }
}

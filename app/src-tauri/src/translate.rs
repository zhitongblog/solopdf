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

/// https only, except a loopback http endpoint (a local model server such as
/// Ollama / LM Studio) — the same rule for translation and Ask AI.
#[cfg(not(target_os = "android"))]
fn check_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    let loopback = ["http://localhost", "http://127.0.0.1", "http://[::1]"]
        .iter()
        .any(|p| lower.starts_with(p));
    if !lower.starts_with("https://") && !loopback {
        return Err("only https:// endpoints (or a local http://localhost server) are allowed".into());
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn agent(global: Option<std::time::Duration>) -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        // the OS trust store, same as every other app on the machine
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .timeout_global(global)
        .timeout_connect(Some(std::time::Duration::from_secs(15)))
        // a local model may take a while to load before the first token
        .timeout_recv_response(Some(std::time::Duration::from_secs(180)))
        .http_status_as_error(false)
        .build()
        .into()
}

/// POST a JSON body for the translation provider.
/// Returns `{status, body}` — status errors are the caller's to explain.
#[cfg(not(target_os = "android"))]
pub fn http_post(url: &str, headers: &[(String, String)], body: &str) -> Result<Value, String> {
    check_url(url)?;
    let agent = agent(Some(std::time::Duration::from_secs(60)));
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

/// Ask-AI streams in flight that the reader cancelled (ids from the WebView).
static CANCELLED: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());

pub fn cancel_stream(id: u32) {
    if let Ok(mut c) = CANCELLED.lock() {
        if !c.contains(&id) {
            c.push(id);
        }
        // ids are never reused by the WebView; keep the list from growing
        let n = c.len();
        if n > 64 {
            c.drain(0..n - 64);
        }
    }
}

#[cfg_attr(target_os = "android", allow(dead_code))]
fn take_cancelled(id: u32) -> bool {
    match CANCELLED.lock() {
        Ok(mut c) => match c.iter().position(|x| *x == id) {
            Some(i) => {
                c.remove(i);
                true
            }
            None => false,
        },
        Err(_) => false,
    }
}

/// POST a chat request and hand the body back line by line as it arrives
/// (Server-Sent Events from an OpenAI-compatible endpoint). `emit` gets
/// `{"status":N}` once, then `{"data":"<line>\n"}` per line, then `{"end":true}`;
/// it returns false
/// when the WebView side is gone. Lines, not raw reads, so a UTF-8 sequence is
/// never split across two messages. Cancelled through `cancel_stream(id)`,
/// checked between lines.
#[cfg(not(target_os = "android"))]
pub fn http_stream(
    id: u32,
    url: &str,
    headers: &[(String, String)],
    body: &str,
    mut emit: impl FnMut(Value) -> bool,
) -> Result<(), String> {
    use std::io::BufRead;
    check_url(url)?;
    // no global timeout: a long answer streams for minutes
    let agent = agent(None);
    let mut req = agent.post(url);
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let res = req
        .header("content-type", "application/json")
        .header("accept", "text/event-stream, application/json")
        .send(body)
        .map_err(|e| format!("network error: {e}"))?;
    if take_cancelled(id) {
        return Ok(());
    }
    let status = res.status().as_u16();
    if !emit(json!({ "status": status })) {
        return Ok(());
    }
    let reader = res.into_body().into_with_config().limit(32 * 1024 * 1024).reader();
    let mut reader = std::io::BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).map_err(|e| format!("read error: {e}"))?;
        if n == 0 {
            break;
        }
        if take_cancelled(id) || !emit(json!({ "data": line })) {
            break;
        }
    }
    // channel messages and the command's own reply travel separately: the
    // WebView ends the stream on this marker, never on the reply
    emit(json!({ "end": true }));
    Ok(())
}

#[cfg(target_os = "android")]
pub fn http_stream(
    _id: u32,
    _url: &str,
    _headers: &[(String, String)],
    _body: &str,
    _emit: impl FnMut(Value) -> bool,
) -> Result<(), String> {
    // the WebView's own fetch streams on Android (see app/src/ai.ts)
    Err("unsupported".into())
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
    fn stream_rejects_plain_http() {
        let e = http_stream(1, "http://example.com/v1", &[], "{}", |_| true).unwrap_err();
        assert!(e.contains("https"));
    }

    /// a one-shot local SSE server: status line, then `n` data lines, slowly
    fn sse_server(n: usize, delay_ms: u64) -> String {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n");
            for i in 0..n {
                let line = format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"w{i} 汉\"}}}}]}}\n\n");
                if s.write_all(line.as_bytes()).is_err() {
                    return;
                }
                let _ = s.flush();
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            }
            let _ = s.write_all(b"data: [DONE]\n\n");
        });
        format!("http://127.0.0.1:{}/v1/chat/completions", addr.port())
    }

    #[test]
    fn streams_lines_then_end() {
        let url = sse_server(5, 5);
        let mut events = Vec::new();
        http_stream(7, &url, &[], "{}", |ev| {
            events.push(ev);
            true
        })
        .unwrap();
        assert_eq!(events[0]["status"], 200);
        let data: String = events.iter().filter_map(|e| e["data"].as_str()).collect();
        assert!(data.contains("w0 汉") && data.contains("w4 汉") && data.contains("[DONE]"), "{data}");
        assert_eq!(events.last().unwrap()["end"], true);
    }

    #[test]
    fn cancel_stops_a_running_stream() {
        let url = sse_server(200, 20);
        let mut lines = 0;
        let started = std::time::Instant::now();
        http_stream(8, &url, &[], "{}", |ev| {
            if ev.get("data").is_some() {
                lines += 1;
                if lines == 3 {
                    cancel_stream(8);
                }
            }
            true
        })
        .unwrap();
        assert!(lines <= 4, "kept streaming after cancel: {lines}");
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn cancel_is_consumed_once() {
        cancel_stream(42);
        assert!(take_cancelled(42));
        assert!(!take_cancelled(42));
    }

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

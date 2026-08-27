//! Android content-URI handling.
//!
//! Android hands apps `content://…` URIs, not paths. `std::fs` cannot open
//! one, the picker's own path resolution returns null for most providers on
//! scoped storage, and the URI's read permission dies with the activity. So
//! SoloPDF does on Android exactly what it does on iOS: copy once into a
//! folder we own, and work with that path forever after.
//!
//! The copy goes through the ContentResolver over JNI rather than through a
//! Kotlin plugin, because the generated Android project is gitignored — code
//! that lives there would have to be re-patched after every `android init`.
//!
//! Getting hold of the VM and Activity is the fiddly part; see
//! `android_context()` for the two approaches that do NOT work and why.

use jni::objects::{JObject, JString, JValue};
use jni::JNIEnv;

type R<T> = Result<T, String>;

/// The live JavaVM + Activity, borrowed from tao.
///
/// Two dead ends came first, both worth remembering:
///
///   - `ndk_context`: nothing in the dependency tree initialises it
///     (`cargo tree -i ndk-context` showed us as the only user), so it
///     panics with "android context was not initialized".
///   - `dlsym("JNI_GetCreatedJavaVMs")`: the symbol lives in libart, which an
///     app's dlsym scope cannot see; declaring it as a link-time `extern "C"`
///     is worse still — dlopen of our own .so then fails before any Rust runs.
///
/// tao is the window layer under Tauri and it already holds both handles.
/// Depending on the same semver makes cargo unify the crate, so these are the
/// statics Tauri itself populated at startup.
fn android_context() -> R<(jni::JavaVM, *mut std::ffi::c_void)> {
    use tao::platform::android::prelude::main_android_context;
    let ctx = main_android_context().ok_or("Android 上下文尚未就绪")?;
    let vm = unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| e.to_string())?;
    Ok((vm, ctx.context_jobject))
}

/// Read a `content://` (or `file://`) URI into memory, with its display name.
pub fn read_content_uri(uri: &str) -> R<(String, Vec<u8>)> {
    let (vm, activity) = android_context()?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    // the Activity is a Context, and an activity-scoped one keeps the URI
    // read grant the intent handed us
    let context = unsafe { JObject::from_raw(activity.cast()) };

    let parsed = parse_uri(&mut env, uri)?;
    let resolver = env
        .call_method(&context, "getContentResolver", "()Landroid/content/ContentResolver;", &[])
        .and_then(|v| v.l())
        .map_err(|e| format!("getContentResolver: {e}"))?;

    let name = display_name(&mut env, &resolver, &parsed).unwrap_or_else(|| {
        // last path segment is a decent fallback and always exists
        uri.rsplit('/').next().unwrap_or("document").to_string()
    });
    let bytes = read_stream(&mut env, &resolver, &parsed)?;
    Ok((sanitize(&name), bytes))
}

fn parse_uri<'a>(env: &mut JNIEnv<'a>, uri: &str) -> R<JObject<'a>> {
    let s: JString = env.new_string(uri).map_err(|e| e.to_string())?;
    env.call_static_method(
        "android/net/Uri",
        "parse",
        "(Ljava/lang/String;)Landroid/net/Uri;",
        &[JValue::Object(&s)],
    )
    .and_then(|v| v.l())
    .map_err(|e| format!("Uri.parse: {e}"))
}

/// OpenableColumns.DISPLAY_NAME via the resolver's cursor.
fn display_name(env: &mut JNIEnv, resolver: &JObject, uri: &JObject) -> Option<String> {
    let cursor = env
        .call_method(
            resolver,
            "query",
            "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
            &[
                JValue::Object(uri),
                JValue::Object(&JObject::null()),
                JValue::Object(&JObject::null()),
                JValue::Object(&JObject::null()),
                JValue::Object(&JObject::null()),
            ],
        )
        .ok()?
        .l()
        .ok()?;
    if cursor.is_null() {
        return None;
    }
    let moved = env.call_method(&cursor, "moveToFirst", "()Z", &[]).ok()?.z().ok()?;
    let mut out = None;
    if moved {
        let col = env.new_string("_display_name").ok()?;
        let idx = env
            .call_method(
                &cursor,
                "getColumnIndex",
                "(Ljava/lang/String;)I",
                &[JValue::Object(&col)],
            )
            .ok()?
            .i()
            .ok()?;
        if idx >= 0 {
            if let Ok(v) = env.call_method(&cursor, "getString", "(I)Ljava/lang/String;", &[JValue::Int(idx)]) {
                if let Ok(obj) = v.l() {
                    if !obj.is_null() {
                        let s: JString = obj.into();
                        out = env.get_string(&s).ok().map(|s| s.into());
                    }
                }
            }
        }
    }
    let _ = env.call_method(&cursor, "close", "()V", &[]);
    out
}

fn read_stream(env: &mut JNIEnv, resolver: &JObject, uri: &JObject) -> R<Vec<u8>> {
    let stream = env
        .call_method(
            resolver,
            "openInputStream",
            "(Landroid/net/Uri;)Ljava/io/InputStream;",
            &[JValue::Object(uri)],
        )
        .and_then(|v| v.l())
        .map_err(|e| format!("openInputStream: {e}"))?;
    if stream.is_null() {
        return Err("无法打开该文件（权限已失效？）".into());
    }
    const CHUNK: i32 = 256 * 1024;
    let buf = env.new_byte_array(CHUNK).map_err(|e| e.to_string())?;
    let mut out: Vec<u8> = Vec::new();
    loop {
        let n = env
            .call_method(&stream, "read", "([B)I", &[JValue::Object(&buf)])
            .and_then(|v| v.i())
            .map_err(|e| format!("read: {e}"))?;
        if n <= 0 {
            break;
        }
        let mut chunk = vec![0i8; n as usize];
        env.get_byte_array_region(&buf, 0, &mut chunk).map_err(|e| e.to_string())?;
        out.extend(chunk.into_iter().map(|b| b as u8));
    }
    let _ = env.call_method(&stream, "close", "()V", &[]);
    Ok(out)
}

/// Content providers can hand back anything as a display name.
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == '\0' { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() { "document".into() } else { cleaned }
}

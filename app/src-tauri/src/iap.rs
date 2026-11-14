//! In-App Purchase (Tip Jar + Supporter Badge) bridge for macOS (MAS), iOS,
//! and Android (Google Play).
//!
//! Three one-time tip tiers:
//!   - `app.solopdf.tip.coffee`  (Tier 1 — Coffee / 请喝杯咖啡)
//!   - `app.solopdf.tip.meal`    (Tier 2 — Meal   / 请吃顿便饭)
//!   - `app.solopdf.tip.feast`   (Tier 3 — Feast  / 超级支持)
//!
//! Purchasing any tier permanently unlocks the user's Supporter Badge
//! (`✨ Supporter / 支持者`) and upgrades its icon to the highest tier
//! purchased. Purchased product IDs are persisted in `NSUserDefaults` +
//! `NSUbiquitousKeyValueStore` on Apple platforms and `SharedPreferences` on
//! Android, in addition to native StoreKit / Google Play Billing restore.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

pub const TIP_PRODUCT_IDS: &[&str] = &[
    "app.solopdf.tip.coffee",
    "app.solopdf.tip.meal",
    "app.solopdf.tip.feast",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IapProduct {
    pub product_id: String,
    pub title: String,
    pub description: String,
    pub formatted_price: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IapState {
    pub supported: bool,
    pub is_store_build: bool,
    pub purchased_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IapPurchaseResult {
    /// `"purchased"` | `"restored"` | `"cancelled"`
    pub status: String,
    pub product_id: String,
    pub purchased_ids: Vec<String>,
}

// ============================================================================
// Apple (macOS + iOS) — StoreKit (`SKProductsRequest` + `SKPaymentQueue`)
// ============================================================================
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub mod apple {
    use super::{IapProduct, IapPurchaseResult, TIP_PRODUCT_IDS};
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int};

    extern "C" {
        fn solopdf_iap_get_purchased_json() -> *mut c_char;
        fn solopdf_iap_record_purchased(product_id: *const c_char);
        #[cfg(test)]
        fn solopdf_iap_set_purchased_json(ids_json: *const c_char);
        fn solopdf_iap_is_mas_receipt_present() -> c_int;
        fn solopdf_iap_fetch_products_sync(ids_json: *const c_char) -> *mut c_char;
        fn solopdf_iap_purchase_sync(product_id: *const c_char) -> *mut c_char;
        fn solopdf_iap_restore_sync() -> *mut c_char;
        #[cfg(test)]
        fn solopdf_iap_delegate_responds_check() -> c_int;
        fn solopdf_iap_free(p: *mut c_char);
    }

    unsafe fn take_c_string(ptr: *mut c_char) -> String {
        if ptr.is_null() {
            return String::new();
        }
        let s = CStr::from_ptr(ptr).to_string_lossy().into_owned();
        solopdf_iap_free(ptr);
        s
    }

    pub fn is_mas_bundle() -> bool {
        unsafe { solopdf_iap_is_mas_receipt_present() != 0 }
    }

    pub fn load_purchased_ids() -> Vec<String> {
        let raw = unsafe { take_c_string(solopdf_iap_get_purchased_json()) };
        serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default()
    }

    pub fn record_purchased_id(product_id: &str) {
        if let Ok(c) = CString::new(product_id) {
            unsafe { solopdf_iap_record_purchased(c.as_ptr()) };
        }
    }

    pub async fn fetch_products(product_ids: Vec<String>) -> Result<Vec<IapProduct>, String> {
        let ids: Vec<String> = if product_ids.is_empty() {
            TIP_PRODUCT_IDS.iter().map(|s| (*s).to_string()).collect()
        } else {
            product_ids
        };
        let ids_json = serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string());
        tauri::async_runtime::spawn_blocking(move || {
            let c_ids = CString::new(ids_json).map_err(|e| e.to_string())?;
            let raw = unsafe { take_c_string(solopdf_iap_fetch_products_sync(c_ids.as_ptr())) };
            let val: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| format!("StoreKit JSON error: {e}"))?;
            if let Some(err) = val.get("error").and_then(|v| v.as_str()) {
                return Err(err.to_string());
            }
            serde_json::from_value::<Vec<IapProduct>>(val).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn purchase(product_id: String) -> Result<IapPurchaseResult, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let c_pid = CString::new(product_id).map_err(|e| e.to_string())?;
            let raw = unsafe { take_c_string(solopdf_iap_purchase_sync(c_pid.as_ptr())) };
            let val: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| format!("StoreKit JSON error: {e}"))?;
            if let Some(err) = val.get("error").and_then(|v| v.as_str()) {
                return Err(err.to_string());
            }
            serde_json::from_value::<IapPurchaseResult>(val).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn restore() -> Result<Vec<String>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let raw = unsafe { take_c_string(solopdf_iap_restore_sync()) };
            let val: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| format!("StoreKit JSON error: {e}"))?;
            if let Some(err) = val.get("error").and_then(|v| v.as_str()) {
                return Err(err.to_string());
            }
            if let Some(arr) = val.get("purchasedIds") {
                return serde_json::from_value::<Vec<String>>(arr.clone())
                    .map_err(|e| e.to_string());
            }
            Ok(load_purchased_ids())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn storekit_delegate_responds_to_all_selectors() {
            let ok = unsafe { solopdf_iap_delegate_responds_check() };
            assert_eq!(ok, 1, "SoloPDFIAPDelegate must respond to all 4 StoreKit selectors");
        }

        #[test]
        fn record_and_load_purchased_ids() {
            let snapshot = load_purchased_ids();
            let test_id = "app.solopdf.tip.coffee";
            record_purchased_id(test_id);
            let after = load_purchased_ids();
            assert!(
                after.iter().any(|x| x == test_id),
                "recorded product ID must be persisted and loaded back: {after:?}"
            );
            // Restore original state so unit test leaves no persistent side-effect
            if let Ok(json) = serde_json::to_string(&snapshot) {
                if let Ok(c) = CString::new(json) {
                    unsafe { solopdf_iap_set_purchased_json(c.as_ptr()) };
                }
            }
        }
    }
}

// ============================================================================
// Android — Google Play Billing via MainActivity JNI
// ============================================================================
#[cfg(target_os = "android")]
mod android {
    use super::{IapProduct, IapPurchaseResult, TIP_PRODUCT_IDS};
    use jni::objects::{JObject, JString, JValue};
    use jni::JavaVM;

    fn with_env<T>(
        f: impl FnOnce(&mut jni::JNIEnv, &JObject) -> Result<T, String>,
    ) -> Result<T, String> {
        use tao::platform::android::prelude::main_android_context;
        let ctx = main_android_context().ok_or("Android 上下文尚未就绪")?;
        let vm = unsafe { JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let act_obj = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };
        f(&mut env, &act_obj)
    }

    fn call_static_str(method: &str, arg: Option<&str>) -> Result<String, String> {
        with_env(|env, act_obj| {
            let cls = env.get_object_class(act_obj).map_err(|e| e.to_string())?;
            let val = if let Some(s) = arg {
                let jarg = env.new_string(s).map_err(|e| e.to_string())?;
                env.call_static_method(
                    cls,
                    method,
                    "(Ljava/lang/String;)Ljava/lang/String;",
                    &[JValue::Object(&jarg)],
                )
            } else {
                env.call_static_method(cls, method, "()Ljava/lang/String;", &[])
            };
            if env.exception_check().unwrap_or(false) {
                let _ = env.exception_clear();
                return Err(format!("JNI exception in MainActivity.{method}"));
            }
            let obj = val.map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;
            if obj.is_null() {
                return Ok(String::new());
            }
            let jstr = JString::from(obj);
            let rust_str: String = env.get_string(&jstr).map_err(|e| e.to_string())?.into();
            Ok(rust_str)
        })
    }

    pub fn load_purchased_ids() -> Vec<String> {
        let raw = call_static_str("iapGetPurchased", None).unwrap_or_default();
        serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default()
    }

    pub async fn fetch_products(product_ids: Vec<String>) -> Result<Vec<IapProduct>, String> {
        let ids: Vec<String> = if product_ids.is_empty() {
            TIP_PRODUCT_IDS.iter().map(|s| (*s).to_string()).collect()
        } else {
            product_ids
        };
        tauri::async_runtime::spawn_blocking(move || {
            let ids_json = serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string());
            let _ = call_static_str("iapStartFetchProducts", Some(&ids_json))?;
            for _ in 0..60 {
                let polled = call_static_str("iapPollProducts", None)?;
                if !polled.is_empty() {
                    return serde_json::from_str::<Vec<IapProduct>>(&polled)
                        .map_err(|e| e.to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
            Ok(Vec::new())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn purchase(product_id: String) -> Result<IapPurchaseResult, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = call_static_str("iapStartPurchase", Some(&product_id))?;
            for _ in 0..600 {
                let polled = call_static_str("iapPollPurchase", None)?;
                if !polled.is_empty() {
                    let val: serde_json::Value =
                        serde_json::from_str(&polled).map_err(|e| e.to_string())?;
                    if let Some(err) = val.get("error").and_then(|v| v.as_str()) {
                        return Err(err.to_string());
                    }
                    let status = val
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("cancelled")
                        .to_string();
                    return Ok(IapPurchaseResult {
                        status,
                        product_id,
                        purchased_ids: load_purchased_ids(),
                    });
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err("Google Play purchase timed out".to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn restore() -> Result<Vec<String>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = call_static_str("iapStartRestore", None)?;
            for _ in 0..50 {
                let polled = call_static_str("iapPollRestore", None)?;
                if !polled.is_empty() {
                    return serde_json::from_str::<Vec<String>>(&polled)
                        .map_err(|e| e.to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
            Ok(load_purchased_ids())
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
pub fn iap_get_state() -> Result<IapState, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let purchased_ids = apple::load_purchased_ids();
        let is_store_build = option_env!("SOLOPDF_APP_STORE_BUILD").is_some()
            || cfg!(target_os = "ios")
            || apple::is_mas_bundle();
        return Ok(IapState {
            supported: true,
            is_store_build,
            purchased_ids,
        });
    }
    #[cfg(target_os = "android")]
    {
        let purchased_ids = android::load_purchased_ids();
        return Ok(IapState {
            supported: true,
            is_store_build: true,
            purchased_ids,
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    {
        Ok(IapState {
            supported: false,
            is_store_build: false,
            purchased_ids: Vec::new(),
        })
    }
}

#[tauri::command]
pub async fn iap_fetch_products(
    _app: AppHandle,
    product_ids: Option<Vec<String>>,
) -> Result<Vec<IapProduct>, String> {
    let ids = product_ids.unwrap_or_default();
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        return apple::fetch_products(ids).await;
    }
    #[cfg(target_os = "android")]
    {
        return android::fetch_products(ids).await;
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    {
        let _ = ids;
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn iap_purchase(
    _app: AppHandle,
    product_id: String,
) -> Result<IapPurchaseResult, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        return apple::purchase(product_id).await;
    }
    #[cfg(target_os = "android")]
    {
        return android::purchase(product_id).await;
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    {
        let _ = product_id;
        Err("In-App Purchase is only available on macOS, iOS, and Android.".to_string())
    }
}

#[tauri::command]
pub async fn iap_restore(_app: AppHandle) -> Result<Vec<String>, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        return apple::restore().await;
    }
    #[cfg(target_os = "android")]
    {
        return android::restore().await;
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    {
        Ok(Vec::new())
    }
}

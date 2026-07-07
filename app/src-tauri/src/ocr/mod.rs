// OCR core: engine dispatch + shared types.
// Apple platforms → Vision (vision.rs, zero-size, best CJK quality).
// Windows/Linux  → PP-OCRv4 ONNX (ppocr.rs, bundled models, fully offline).
// The `ppocr` cargo feature also enables the ONNX path on macOS so the
// cross-platform pipeline can be tested here before UTM verification.

use serde::{Deserialize, Serialize};

pub mod textlayer;

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub mod vision;

#[cfg(any(windows, target_os = "linux", feature = "ppocr"))]
pub mod ppocr;

/// One recognized line. Coordinates are normalized [0,1] with a
/// TOP-LEFT origin, relative to the input image.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OcrLine {
    pub t: String,
    pub c: f32,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Which engine serves this build (surfaced to the UI/CLI).
pub fn engine_name() -> &'static str {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        "vision"
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        "ppocr"
    }
}

/// Recognize text in an encoded image (PNG/JPEG bytes).
/// `langs` is a priority hint, e.g. ["zh-Hans", "en-US", "ja"].
pub fn recognize(bytes: &[u8], langs: &[String]) -> Result<Vec<OcrLine>, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        vision::recognize(bytes, langs)
    }
    #[cfg(all(not(any(target_os = "macos", target_os = "ios")), any(windows, target_os = "linux")))]
    {
        ppocr::recognize(bytes, langs)
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", windows, target_os = "linux")))]
    {
        let _ = (bytes, langs);
        Err("OCR is not supported on this platform".into())
    }
}

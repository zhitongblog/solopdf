// OCR core: engine dispatch + shared types.
// Apple platforms → Vision (vision.rs, zero-size, best CJK quality).
// Windows/Linux  → PP-OCRv4 ONNX (ppocr.rs, bundled models, fully offline).
// The `ppocr` cargo feature also enables the ONNX path on macOS so the
// cross-platform pipeline can be tested here before UTM verification.

use serde::{Deserialize, Serialize};

pub mod preprocess;
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
/// `photo`: the input is a camera shot — on Apple platforms the shim finds
/// the document quad and rectifies perspective first; everywhere the deskew
/// preprocessor straightens small scan rotations before the engine runs.
pub fn recognize(bytes: &[u8], langs: &[String], photo: bool) -> Result<Vec<OcrLine>, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        if photo {
            // 透视校正在 shim 内完成,deskew 交给校正后的矩形(Vision 容忍度足够)
            return vision::recognize(bytes, langs, true);
        }
        match preprocess::deskew(bytes) {
            Some((fixed, _deg)) => vision::recognize(&fixed, langs, false),
            None => vision::recognize(bytes, langs, false),
        }
    }
    #[cfg(all(not(any(target_os = "macos", target_os = "ios")), any(windows, target_os = "linux")))]
    {
        let _ = photo; // Win/Linux 无透视校正,deskew 一律执行
        match preprocess::deskew(bytes) {
            Some((fixed, _deg)) => ppocr::recognize(&fixed, langs),
            None => ppocr::recognize(bytes, langs),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", windows, target_os = "linux")))]
    {
        let _ = (bytes, langs, photo);
        Err("OCR is not supported on this platform".into())
    }
}

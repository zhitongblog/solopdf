// OCR integration tests (macOS: Vision engine; --features ppocr adds the
// ONNX pipeline that ships on Windows/Linux). Run: cargo test --test ocr_integration
#![cfg(target_os = "macos")]

use solopdf_lib::ocr;

static SAMPLE: &[u8] = include_bytes!("fixtures/ocr-sample.png");
static PHOTO: &[u8] = include_bytes!("fixtures/photo-perspective.jpg");
static SKEWED: &[u8] = include_bytes!("fixtures/scan-skewed.png");

#[test]
fn photo_mode_rectifies_perspective_shot() {
    let langs = vec!["zh-Hans".to_string(), "en-US".to_string()];
    let lines = ocr::recognize(PHOTO, &langs, true).expect("photo ocr failed");
    let all: String = lines.iter().map(|l| l.t.as_str()).collect::<Vec<_>>().join("\n");
    assert!(all.contains("会议纪要"), "got: {all}");
    assert!(all.contains("2026-07-15"), "got: {all}");
}

#[test]
fn skewed_scan_is_deskewed_before_recognition() {
    let langs = vec!["zh-Hans".to_string(), "en-US".to_string()];
    let lines = ocr::recognize(SKEWED, &langs, false).expect("skewed ocr failed");
    let all: String = lines.iter().map(|l| l.t.as_str()).collect::<Vec<_>>().join("\n");
    assert!(all.contains("会议纪要") || all.contains("會議紀要"), "got: {all}");
    assert!(all.contains("Attendees"), "got: {all}");
    // deskew 后行应当接近水平:同一行的高度不应异常大
    let max_h = lines.iter().map(|l| l.h).fold(0.0f32, f32::max);
    assert!(max_h < 0.08, "line boxes too tall (still skewed?): {max_h}");
}

#[cfg(feature = "ppocr")]
#[test]
fn ppocr_recognizes_chinese_and_english() {
    let langs = vec!["zh-Hans".to_string(), "en-US".to_string()];
    let lines = ocr::ppocr::recognize(SAMPLE, &langs).expect("ppocr failed");
    let all: String = lines.iter().map(|l| l.t.as_str()).collect::<Vec<_>>().join("\n");
    assert!(all.contains("扫描文档"), "got: {all}");
    assert!(all.contains("12345"), "got: {all}");
    for l in &lines {
        assert!(l.x >= 0.0 && l.y >= 0.0 && l.x + l.w <= 1.001 && l.y + l.h <= 1.001, "{l:?}");
    }
}

#[cfg(feature = "ppocr")]
#[test]
fn ppocr_korean_model() {
    static KOREAN: &[u8] = include_bytes!("fixtures/ocr-korean.png");
    let langs = vec!["ko".to_string()];
    let lines = ocr::ppocr::recognize(KOREAN, &langs).expect("ppocr ko failed");
    let all: String = lines.iter().map(|l| l.t.as_str()).collect::<Vec<_>>().join("");
    assert!(all.contains("한국어") || all.contains("텍스트"), "got: {all}");
}

#[cfg(feature = "ppocr")]
#[test]
fn ppocr_japanese_model() {
    let langs = vec!["ja".to_string()];
    let lines = ocr::ppocr::recognize(SAMPLE, &langs).expect("ppocr ja failed");
    let all: String = lines.iter().map(|l| l.t.as_str()).collect::<Vec<_>>().join("");
    assert!(all.contains("日本語"), "got: {all}");
}

#[test]
fn vision_recognizes_mixed_scripts() {
    let langs = vec!["zh-Hans".to_string(), "en-US".to_string(), "ja".to_string()];
    let lines = ocr::recognize(SAMPLE, &langs, false).expect("vision ocr failed");
    let all: String = lines.iter().map(|l| l.t.as_str()).collect::<Vec<_>>().join("\n");
    assert!(all.contains("扫描文档"), "got: {all}");
    assert!(all.contains("SoloPDF OCR test 12345"), "got: {all}");
    assert!(all.contains("日本語"), "got: {all}");
    // sane geometry: normalized, top-left origin, three stacked lines
    for l in &lines {
        assert!(l.x >= 0.0 && l.y >= 0.0 && l.x + l.w <= 1.001 && l.y + l.h <= 1.001);
    }
    let ys: Vec<f32> = lines.iter().map(|l| l.y).collect();
    assert!(ys.windows(2).all(|w| w[0] <= w[1]), "lines not top-to-bottom: {ys:?}");
}

// OCR integration tests (macOS: Vision engine; --features ppocr adds the
// ONNX pipeline that ships on Windows/Linux). Run: cargo test --test ocr_integration
#![cfg(target_os = "macos")]

use solopdf_lib::ocr;

static SAMPLE: &[u8] = include_bytes!("fixtures/ocr-sample.png");

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
fn ppocr_japanese_model() {
    let langs = vec!["ja".to_string()];
    let lines = ocr::ppocr::recognize(SAMPLE, &langs).expect("ppocr ja failed");
    let all: String = lines.iter().map(|l| l.t.as_str()).collect::<Vec<_>>().join("");
    assert!(all.contains("日本語"), "got: {all}");
}

#[test]
fn vision_recognizes_mixed_scripts() {
    let langs = vec!["zh-Hans".to_string(), "en-US".to_string(), "ja".to_string()];
    let lines = ocr::recognize(SAMPLE, &langs).expect("vision ocr failed");
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

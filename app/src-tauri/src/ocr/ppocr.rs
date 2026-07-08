// PP-OCR ONNX engine (Windows/Linux; on macOS behind the `ppocr` feature
// for development/testing). Pipeline: DBNet detection → axis-aligned box
// post-processing → CRNN/SVTR recognition with greedy CTC decode.
// Models live in assets/ppocr (bundled as tauri resources on Win/Linux):
//   det.onnx + rec_ch.onnx/keys_ch.txt  — PP-OCRv6 small (zh/en, 18k classes)
//   rec_japan.onnx/keys_japan.txt       — PP-OCRv4 japan
//   rec_korean.onnx/keys_korean.txt     — PP-OCRv3 korean

use super::OcrLine;
use image::RgbImage;
use ort::session::Session;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static MODEL_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Called once from app setup (tauri resource dir) or the CLI.
pub fn set_model_dir(dir: PathBuf) {
    let _ = MODEL_DIR.set(dir);
}

fn model_dir() -> Result<PathBuf, String> {
    if let Ok(d) = std::env::var("SOLOPDF_PPOCR_DIR") {
        return Ok(PathBuf::from(d));
    }
    if let Some(d) = MODEL_DIR.get() {
        return Ok(d.clone());
    }
    // dev fallback: next to the executable, then the source tree
    if let Ok(exe) = std::env::current_exe() {
        let p = exe.parent().unwrap().join("ppocr");
        if p.exists() {
            return Ok(p);
        }
    }
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/ppocr");
    if src.exists() {
        return Ok(src);
    }
    Err("PP-OCR 模型目录未找到".into())
}

struct Engine {
    det: Session,
    rec: Session,
    keys: Vec<String>,
    /// which rec model is loaded ("ch" / "japan")
    rec_kind: String,
}

fn load_keys(path: &PathBuf) -> Result<Vec<String>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读取字典失败: {e}"))?;
    Ok(text.lines().map(|l| l.to_string()).collect())
}

fn load_session(path: &PathBuf) -> Result<Session, String> {
    Session::builder()
        .and_then(|mut b| b.commit_from_file(path))
        .map_err(|e| format!("加载 OCR 模型失败 ({}): {e}", path.display()))
}

static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);

/// 首选语言 → rec 模型:ja → japan,ko → korean,其余走中英模型
fn rec_kind_for(langs: &[String]) -> &'static str {
    match langs.first().map(|l| l.as_str()).unwrap_or("") {
        l if l.starts_with("ja") => "japan",
        l if l.starts_with("ko") => "korean",
        _ => "ch",
    }
}

pub fn recognize(bytes: &[u8], langs: &[String]) -> Result<Vec<OcrLine>, String> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| format!("图片解码失败: {e}"))?
        .to_rgb8();
    let rec_kind = rec_kind_for(langs);

    let mut guard = ENGINE.lock().map_err(|e| e.to_string())?;
    if guard.as_ref().map(|e| e.rec_kind != rec_kind).unwrap_or(true) {
        let dir = model_dir()?;
        *guard = Some(Engine {
            det: load_session(&dir.join("det.onnx"))?,
            rec: load_session(&dir.join(format!("rec_{rec_kind}.onnx")))?,
            keys: load_keys(&dir.join(format!("keys_{rec_kind}.txt")))?,
            rec_kind: rec_kind.to_string(),
        });
    }
    let eng = guard.as_mut().unwrap();

    let boxes = detect(&mut eng.det, &img)?;
    let (w0, h0) = (img.width() as f32, img.height() as f32);
    let mut lines = Vec::new();
    for b in boxes {
        let (text, conf) = match recognize_box(&mut eng.rec, &eng.keys, &img, &b) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if text.trim().is_empty() {
            continue;
        }
        lines.push(OcrLine {
            t: text,
            c: conf,
            x: b.x0 / w0,
            y: b.y0 / h0,
            w: (b.x1 - b.x0) / w0,
            h: (b.y1 - b.y0) / h0,
        });
    }
    // reading order: top-to-bottom with same-line grouping, then left-to-right
    lines.sort_by(|a, b| {
        let same_row = (a.y - b.y).abs() < a.h.min(b.h) * 0.6;
        if same_row {
            a.x.partial_cmp(&b.x).unwrap()
        } else {
            a.y.partial_cmp(&b.y).unwrap()
        }
    });
    Ok(lines)
}

#[derive(Clone, Copy, Debug)]
struct TextBox {
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
}

const DET_LIMIT: u32 = 960;
const DET_THRESH: f32 = 0.3;
const BOX_THRESH: f32 = 0.5;
const UNCLIP: f32 = 1.6;

fn detect(det: &mut Session, img: &RgbImage) -> Result<Vec<TextBox>, String> {
    let (w0, h0) = (img.width(), img.height());
    let ratio = (DET_LIMIT as f32 / w0.max(h0) as f32).min(1.0);
    let rw = (((w0 as f32 * ratio) / 32.0).round().max(1.0) as u32 * 32).max(32);
    let rh = (((h0 as f32 * ratio) / 32.0).round().max(1.0) as u32 * 32).max(32);
    let resized = image::imageops::resize(img, rw, rh, image::imageops::FilterType::Triangle);

    // NCHW float, ImageNet mean/std
    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const STD: [f32; 3] = [0.229, 0.224, 0.225];
    let (rw_us, rh_us) = (rw as usize, rh as usize);
    let mut input = vec![0f32; 3 * rh_us * rw_us];
    for (y, row) in resized.rows().enumerate() {
        for (x, px) in row.enumerate() {
            for c in 0..3 {
                input[c * rh_us * rw_us + y * rw_us + x] =
                    (px.0[c] as f32 / 255.0 - MEAN[c]) / STD[c];
            }
        }
    }
    let tensor = ort::value::Tensor::from_array(([1usize, 3, rh_us, rw_us], input))
        .map_err(|e| e.to_string())?;
    let outputs = det.run(ort::inputs![tensor]).map_err(|e| format!("det 推理失败: {e}"))?;
    let (shape, prob) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;
    let (ph, pw) = (shape[2] as usize, shape[3] as usize);

    // binarize + 4-neighbour connected components
    let bin: Vec<bool> = prob.iter().map(|&p| p > DET_THRESH).collect();
    let mut label = vec![0u32; pw * ph];
    let mut next = 0u32;
    let mut comps: Vec<(u32, u32, u32, u32, f64, u32)> = Vec::new(); // x0,y0,x1,y1,prob_sum,count
    let mut stack = Vec::new();
    for start in 0..pw * ph {
        if !bin[start] || label[start] != 0 {
            continue;
        }
        next += 1;
        let mut comp = (u32::MAX, u32::MAX, 0u32, 0u32, 0f64, 0u32);
        stack.push(start);
        label[start] = next;
        while let Some(i) = stack.pop() {
            let (x, y) = ((i % pw) as u32, (i / pw) as u32);
            comp.0 = comp.0.min(x);
            comp.1 = comp.1.min(y);
            comp.2 = comp.2.max(x);
            comp.3 = comp.3.max(y);
            comp.4 += prob[i] as f64;
            comp.5 += 1;
            let neighbours = [
                (i >= 1 && x > 0).then(|| i - 1),
                (x + 1 < pw as u32).then(|| i + 1),
                (y > 0).then(|| i - pw),
                (y + 1 < ph as u32).then(|| i + pw),
            ];
            for n in neighbours.into_iter().flatten() {
                if bin[n] && label[n] == 0 {
                    label[n] = next;
                    stack.push(n);
                }
            }
        }
        comps.push(comp);
    }

    let sx = w0 as f32 / pw as f32;
    let sy = h0 as f32 / ph as f32;
    let mut boxes = Vec::new();
    for (x0, y0, x1, y1, psum, count) in comps {
        let (bw, bh) = ((x1 - x0 + 1) as f32, (y1 - y0 + 1) as f32);
        if bw < 3.0 || bh < 3.0 || count < 10 {
            continue;
        }
        if (psum / count as f64) < BOX_THRESH as f64 {
            continue;
        }
        // unclip: Vatti offset approximation for a rectangle
        let d = bw * bh * UNCLIP / (2.0 * (bw + bh));
        let bx0 = ((x0 as f32 - d) * sx).max(0.0);
        let by0 = ((y0 as f32 - d) * sy).max(0.0);
        let bx1 = ((x1 as f32 + 1.0 + d) * sx).min(w0 as f32);
        let by1 = ((y1 as f32 + 1.0 + d) * sy).min(h0 as f32);
        boxes.push(TextBox { x0: bx0, y0: by0, x1: bx1, y1: by1 });
    }
    Ok(boxes)
}

const REC_H: u32 = 48;
const REC_MAX_W: u32 = 800;

fn recognize_box(
    rec: &mut Session,
    keys: &[String],
    img: &RgbImage,
    b: &TextBox,
) -> Result<(String, f32), String> {
    let (x0, y0) = (b.x0.max(0.0) as u32, b.y0.max(0.0) as u32);
    let (x1, y1) = (
        (b.x1 as u32).min(img.width()),
        (b.y1 as u32).min(img.height()),
    );
    if x1 <= x0 + 2 || y1 <= y0 + 2 {
        return Err("empty box".into());
    }
    let crop = image::imageops::crop_imm(img, x0, y0, x1 - x0, y1 - y0).to_image();
    let scale = REC_H as f32 / crop.height() as f32;
    let tw = ((crop.width() as f32 * scale).ceil() as u32).clamp(16, REC_MAX_W);
    let resized =
        image::imageops::resize(&crop, tw, REC_H, image::imageops::FilterType::Triangle);

    let (h, w) = (REC_H as usize, tw as usize);
    let mut input = vec![0f32; 3 * h * w];
    for (y, row) in resized.rows().enumerate() {
        for (x, px) in row.enumerate() {
            for c in 0..3 {
                input[c * h * w + y * w + x] = px.0[c] as f32 / 127.5 - 1.0;
            }
        }
    }
    let tensor =
        ort::value::Tensor::from_array(([1usize, 3, h, w], input)).map_err(|e| e.to_string())?;
    let outputs = rec.run(ort::inputs![tensor]).map_err(|e| format!("rec 推理失败: {e}"))?;
    let (shape, probs) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;
    let (t_len, n_cls) = (shape[1] as usize, shape[2] as usize);

    // greedy CTC decode: blank = index 0; dict indices 1..=keys.len();
    // with use_space_char the LAST class is a literal space
    let mut text = String::new();
    let mut conf_sum = 0f32;
    let mut conf_n = 0u32;
    let mut prev = 0usize;
    for t in 0..t_len {
        let row = &probs[t * n_cls..(t + 1) * n_cls];
        let (mut best, mut best_p) = (0usize, f32::MIN);
        for (i, &p) in row.iter().enumerate() {
            if p > best_p {
                best = i;
                best_p = p;
            }
        }
        if best != 0 && best != prev {
            let ch = if best - 1 < keys.len() {
                keys[best - 1].as_str()
            } else {
                " "
            };
            text.push_str(ch);
            conf_sum += best_p;
            conf_n += 1;
        }
        prev = best;
    }
    let conf = if conf_n > 0 { conf_sum / conf_n as f32 } else { 0.0 };
    Ok((text, conf))
}

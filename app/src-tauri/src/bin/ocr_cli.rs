// solopdf-ocr — CLI driver for the OCR core (shipped artifact, global rule #4).
//
//   solopdf-ocr image <img.png|jpg> [--lang ja|ko|zh] [--json] [--photo]
//       OCR one image. Text to stdout, or normalized-coordinate JSON lines
//       with --json. --photo enables camera-shot preprocessing (document
//       detection + perspective correction on Apple platforms).
//
//   solopdf-ocr overlay <src.pdf> <results.json> <dest.pdf>
//       Inject an invisible text layer. results.json:
//       [{"page":0,"lines":[{"text","x","y","w","h"}]}] in PDF points
//       (y = box bottom, PDF y-up). Produces a searchable copy.
//
//   solopdf-ocr translate <text|-> --to zh-Hans [--fallback en]
//       On-device translation (Apple Translation framework, macOS 15+).
//       `-` reads the text from stdin. Prints the engine's JSON:
//       {"text","source","target"} or {"error","code",…}; exit 2 on error.
//
//   solopdf-ocr translate-download --from en --to zh-Hans
//       Show the system "Download Languages" sheet for a pair (needs a GUI
//       session — the one step on-device translation can't do headless).
//
// Engines: Apple Vision on macOS/iOS builds; PP-OCRv4 ONNX elsewhere
// (models via SOLOPDF_PPOCR_DIR, exe-sibling ppocr/, or the source tree).
// Translation lives here too: it is the same "Apple on-device ML" helper.

use solopdf_lib::{ocr, translate};
use std::io::Read;

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("image") => {
            let file = args.get(1).unwrap_or_else(|| die("用法: solopdf-ocr image <img> [--lang ja|zh] [--json]"));
            let bytes = std::fs::read(file).unwrap_or_else(|e| die(&format!("读取失败: {e}")));
            let lang = args
                .iter()
                .position(|a| a == "--lang")
                .and_then(|i| args.get(i + 1))
                .map(|s| s.as_str())
                .unwrap_or("zh");
            let langs: Vec<String> = match lang {
                "ja" => vec!["ja".into(), "en-US".into()],
                "ko" => vec!["ko".into(), "en-US".into()],
                "en" => vec!["en-US".into()],
                _ => vec!["zh-Hans".into(), "zh-Hant".into(), "en-US".into()],
            };
            let photo = args.iter().any(|a| a == "--photo");
            let lines = ocr::recognize(&bytes, &langs, photo).unwrap_or_else(|e| die(&e));
            if args.iter().any(|a| a == "--json") {
                println!("{}", serde_json::to_string(&lines).unwrap());
            } else {
                for l in &lines {
                    println!("{}", l.t);
                }
            }
        }
        Some("overlay") => {
            let (src, results, dest) = match (args.get(1), args.get(2), args.get(3)) {
                (Some(a), Some(b), Some(c)) => (a, b, c),
                _ => die("用法: solopdf-ocr overlay <src.pdf> <results.json> <dest.pdf>"),
            };
            let pdf = std::fs::read(src).unwrap_or_else(|e| die(&format!("读取 PDF 失败: {e}")));
            let json = std::fs::read_to_string(results).unwrap_or_else(|e| die(&format!("读取结果失败: {e}")));
            let pages: Vec<ocr::textlayer::PageOcr> =
                serde_json::from_str(&json).unwrap_or_else(|e| die(&format!("results.json 解析失败: {e}")));
            let out = ocr::textlayer::add_text_layer(&pdf, &pages).unwrap_or_else(|e| die(&e));
            std::fs::write(dest, out).unwrap_or_else(|e| die(&format!("写入失败: {e}")));
            eprintln!("✓ {dest}");
        }
        Some("engine") => println!("{}", ocr::engine_name()),
        Some("translate") => {
            let opt = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
            let mut text = args
                .get(1)
                .filter(|a| !a.starts_with("--"))
                .cloned()
                .unwrap_or_else(|| die("用法: solopdf-ocr translate <text|-> --to zh-Hans [--fallback en]"));
            if text == "-" {
                text.clear();
                std::io::stdin().read_to_string(&mut text).unwrap_or_else(|e| die(&format!("读取 stdin 失败: {e}")));
            }
            let to = opt("--to").unwrap_or_default();
            let fallback = opt("--fallback").unwrap_or_default();
            let v = translate::translate(&text, &to, &fallback);
            println!("{v}");
            if v.get("error").is_some() {
                std::process::exit(2);
            }
        }
        Some("translate-download") => {
            let opt = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
            let (Some(from), Some(to)) = (opt("--from"), opt("--to")) else {
                die("用法: solopdf-ocr translate-download --from en --to zh-Hans")
            };
            let v = translate::prepare(&from, &to);
            println!("{v}");
            if v.get("error").is_some() {
                std::process::exit(2);
            }
        }
        Some("translate-engine") => println!("{}", translate::engine_name()),
        _ => die(
            "solopdf-ocr — 本地 OCR 命令行\n\n\
             用法:\n  solopdf-ocr image <img.png|jpg> [--lang ja|ko|zh|en] [--json] [--photo]\n  \
             solopdf-ocr overlay <src.pdf> <results.json> <dest.pdf>\n  \
             solopdf-ocr engine\n  \
             solopdf-ocr translate <text|-> --to zh-Hans [--fallback en]\n  \
             solopdf-ocr translate-download --from en --to zh-Hans\n  \
             solopdf-ocr translate-engine",
        ),
    }
}

// solopdf-ocr — CLI driver for the OCR core (shipped artifact, global rule #4).
//
//   solopdf-ocr image <img.png|jpg> [--lang ja|zh] [--json]
//       OCR one image. Text to stdout, or normalized-coordinate JSON lines
//       with --json: [{"t","c","x","y","w","h"}]
//
//   solopdf-ocr overlay <src.pdf> <results.json> <dest.pdf>
//       Inject an invisible text layer. results.json:
//       [{"page":0,"lines":[{"text","x","y","w","h"}]}] in PDF points
//       (y = box bottom, PDF y-up). Produces a searchable copy.
//
// Engines: Apple Vision on macOS/iOS builds; PP-OCRv4 ONNX elsewhere
// (models via SOLOPDF_PPOCR_DIR, exe-sibling ppocr/, or the source tree).

use solopdf_lib::ocr;

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
                "en" => vec!["en-US".into()],
                _ => vec!["zh-Hans".into(), "zh-Hant".into(), "en-US".into()],
            };
            let lines = ocr::recognize(&bytes, &langs).unwrap_or_else(|e| die(&e));
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
        _ => die(
            "solopdf-ocr — 本地 OCR 命令行\n\n\
             用法:\n  solopdf-ocr image <img.png|jpg> [--lang ja|zh|en] [--json]\n  \
             solopdf-ocr overlay <src.pdf> <results.json> <dest.pdf>\n  \
             solopdf-ocr engine",
        ),
    }
}

// solopdf-doc — CLI driver for the document operations (shipped artifact,
// global rule #4). Everything here writes a NEW file; the source is opened
// read-only, exactly as in the app.
//
//   solopdf-doc pages <src.pdf> <dest.pdf> --keep 1,3-5 [--rotate 90] [--password pw]
//   solopdf-doc merge <dest.pdf> <a.pdf> <b.pdf> …
//   solopdf-doc split <src.pdf> <dest-dir> --ranges 1-3,4-10 [--password pw]
//   solopdf-doc annotate <src.pdf> <dest.pdf> <annots.json> [--password pw]
//   solopdf-doc compress <src.pdf> <dest.pdf> [--max-dim 1600] [--quality 72]
//   solopdf-doc images-to-pdf <dest.pdf> <a.png> <b.jpg> … [--dpi 150]
//   solopdf-doc protect <src.pdf> <dest.pdf> --password pw [--owner pw]
//   solopdf-doc unprotect <src.pdf> <dest.pdf> --password pw
//   solopdf-doc info <src.pdf> [--password pw]
//   solopdf-doc djvu-info <src.djvu>
//   solopdf-doc djvu-page <src.djvu> <dest.png> [--page 1] [--width 1400]
//
// annots.json is the same shape the app sends:
//   [{"page":1,"kind":"highlight","quads":[[x1,y1,x2,y2]],
//     "color":[1,0.85,0.2],"contents":"…","author":"…"}]

use solopdf_lib::{djvu, pdfops};

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1)
}

fn arg<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
}

/// "1,3-5,9" → [1,3,4,5,9]
fn parse_list(spec: &str) -> Vec<u32> {
    let mut out = Vec::new();
    for part in spec.split(',') {
        let part = part.trim();
        if let Some((a, b)) = part.split_once('-') {
            let (a, b) = (a.trim().parse::<u32>(), b.trim().parse::<u32>());
            if let (Ok(a), Ok(b)) = (a, b) {
                for p in a.min(b)..=a.max(b) {
                    out.push(p);
                }
            }
        } else if let Ok(n) = part.parse::<u32>() {
            out.push(n);
        }
    }
    out
}

/// "1-3,4-10" → [(1,3),(4,10)]
fn parse_ranges(spec: &str) -> Vec<(u32, u32)> {
    spec.split(',')
        .filter_map(|part| {
            let part = part.trim();
            match part.split_once('-') {
                Some((a, b)) => {
                    let a = a.trim().parse::<u32>().ok()?;
                    let b = b.trim().parse::<u32>().ok()?;
                    Some((a.min(b), a.max(b)))
                }
                None => part.parse::<u32>().ok().map(|n| (n, n)),
            }
        })
        .collect()
}

fn read(path: &str) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|e| die(&format!("读取失败 {path}: {e}")))
}

fn write(path: &str, bytes: Vec<u8>) {
    std::fs::write(path, bytes).unwrap_or_else(|e| die(&format!("写入失败 {path}: {e}")));
    eprintln!("✓ {path}");
}

fn ok<T>(r: Result<T, String>) -> T {
    r.unwrap_or_else(|e| die(&e))
}

fn usage() -> ! {
    eprintln!(
        "solopdf-doc — SoloPDF 文档操作（页面/合并/拆分/标注/压缩/加密）

  pages <src.pdf> <dest.pdf> --keep 1,3-5 [--rotate 90] [--password pw]
  merge <dest.pdf> <a.pdf> <b.pdf> …
  split <src.pdf> <dest-dir> --ranges 1-3,4-10 [--password pw]
  annotate <src.pdf> <dest.pdf> <annots.json> [--password pw]
  compress <src.pdf> <dest.pdf> [--max-dim 1600] [--quality 72]
  images-to-pdf <dest.pdf> <a.png> … [--dpi 150]
  protect <src.pdf> <dest.pdf> --password pw [--owner pw]
  unprotect <src.pdf> <dest.pdf> --password pw
  info <src.pdf> [--password pw]
  djvu-info <src.djvu>
  djvu-page <src.djvu> <dest.png> [--page 1] [--width 1400]

所有操作都写入新文件，源文件永不修改。"
    );
    std::process::exit(1)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let pw = arg(&args, "--password");
    let cmd = args.first().map(|s| s.as_str()).unwrap_or("");
    let positional: Vec<&String> = {
        // everything that isn't a flag or a flag's value
        let mut out = Vec::new();
        let mut skip = false;
        for (i, a) in args.iter().enumerate() {
            if i == 0 || skip {
                skip = false;
                continue;
            }
            if a.starts_with("--") {
                skip = true;
                continue;
            }
            out.push(a);
        }
        out
    };

    match cmd {
        "pages" => {
            let (src, dest) = (positional.first(), positional.get(1));
            let (Some(src), Some(dest)) = (src, dest) else { usage() };
            let keep = arg(&args, "--keep").unwrap_or_else(|| die("需要 --keep 1,3-5"));
            let order = parse_list(keep);
            if order.is_empty() {
                die("--keep 没有解析出页码");
            }
            let pdf = read(src);
            let mut out = ok(pdfops::arrange_pages(&pdf, pw, &order));
            if let Some(deg) = arg(&args, "--rotate").and_then(|d| d.parse::<i64>().ok()) {
                out = ok(pdfops::rotate_pages(&out, None, &[], deg));
            }
            write(dest, out);
        }
        "merge" => {
            let Some(dest) = positional.first() else { usage() };
            let inputs: Vec<(Vec<u8>, Option<String>)> =
                positional[1..].iter().map(|p| (read(p), None)).collect();
            if inputs.len() < 2 {
                die("至少需要两个输入文件");
            }
            write(dest, ok(pdfops::merge(&inputs)));
        }
        "split" => {
            let (Some(src), Some(dir)) = (positional.first(), positional.get(1)) else { usage() };
            let spec = arg(&args, "--ranges").unwrap_or_else(|| die("需要 --ranges 1-3,4-10"));
            let ranges = parse_ranges(spec);
            if ranges.is_empty() {
                die("--ranges 没有解析出范围");
            }
            std::fs::create_dir_all(dir).ok();
            let pdf = read(src);
            let parts = ok(pdfops::split(&pdf, pw, &ranges));
            let stem = std::path::Path::new(src.as_str())
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "document".into());
            for (i, bytes) in parts.into_iter().enumerate() {
                let (a, b) = ranges[i];
                write(&format!("{dir}/{stem}-{a}-{b}.pdf"), bytes);
            }
        }
        "annotate" => {
            let (Some(src), Some(dest), Some(json)) =
                (positional.first(), positional.get(1), positional.get(2))
            else {
                usage()
            };
            let specs: Vec<pdfops::AnnotSpec> = serde_json::from_slice(&read(json))
                .unwrap_or_else(|e| die(&format!("annots.json 解析失败: {e}")));
            write(dest, ok(pdfops::write_annotations(&read(src), pw, &specs)));
        }
        "compress" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let max_dim = arg(&args, "--max-dim").and_then(|v| v.parse().ok()).unwrap_or(1600);
            let quality = arg(&args, "--quality").and_then(|v| v.parse().ok()).unwrap_or(72);
            let pdf = read(src);
            let before = pdf.len();
            let out = ok(pdfops::compress_pdf(&pdf, pw, max_dim, quality));
            eprintln!("{} KB → {} KB", before / 1024, out.len() / 1024);
            write(dest, out);
        }
        "images-to-pdf" => {
            let Some(dest) = positional.first() else { usage() };
            let dpi = arg(&args, "--dpi").and_then(|v| v.parse().ok()).unwrap_or(150.0);
            let images: Vec<Vec<u8>> = positional[1..].iter().map(|p| read(p)).collect();
            if images.is_empty() {
                die("至少需要一张图片");
            }
            write(dest, ok(pdfops::images_to_pdf(&images, dpi)));
        }
        "protect" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let user = arg(&args, "--password").unwrap_or_else(|| die("需要 --password"));
            let owner = arg(&args, "--owner").unwrap_or("");
            // --password is the NEW password here, so the source must be open
            write(dest, ok(pdfops::set_password(&read(src), None, user, owner)));
        }
        "unprotect" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let pw = arg(&args, "--password").unwrap_or_else(|| die("需要 --password"));
            write(dest, ok(pdfops::remove_password(&read(src), pw)));
        }
        "info" => {
            let Some(src) = positional.first() else { usage() };
            let pdf = read(src);
            let sizes = ok(pdfops::page_sizes(&pdf, pw));
            println!(
                "{}",
                serde_json::json!({
                    "file": src,
                    "pages": ok(pdfops::page_count(&pdf, pw)),
                    "encrypted": pdfops::is_encrypted(&pdf),
                    "sizes": sizes.iter().map(|(w, h)| serde_json::json!([w, h])).collect::<Vec<_>>(),
                })
            );
        }
        "djvu-info" => {
            let Some(src) = positional.first() else { usage() };
            let info = ok(djvu::info(src));
            println!("{}", serde_json::to_string(&info).unwrap_or_default());
        }
        "djvu-page" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let page = arg(&args, "--page").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1);
            let width = arg(&args, "--width").and_then(|v| v.parse().ok()).unwrap_or(1400);
            write(dest, ok(djvu::render_page(src, page.saturating_sub(1), width)));
        }
        _ => usage(),
    }
}

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

use solopdf_lib::{crypto_sig, djvu, pdfops};

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
        "solopdf-doc — SoloPDF 文档操作（页面/合并/拆分/标注/压缩/加密/水印/页码/裁切/原图/脱敏/扁平化）

  pages <src.pdf> <dest.pdf> --keep 1,0,3-5 [--rotate 90] [--password pw]   (0 = 插入空白页)
  merge <dest.pdf> <a.pdf> <b.pdf> …
  split <src.pdf> <dest-dir> --ranges 1-3,4-10 [--password pw]
  annotate <src.pdf> <dest.pdf> <annots.json> [--password pw]
  compress <src.pdf> <dest.pdf> [--max-dim 1600] [--quality 72]
  images-to-pdf <dest.pdf> <a.png> … [--dpi 150]
  protect <src.pdf> <dest.pdf> --password pw [--owner pw]
  unprotect <src.pdf> <dest.pdf> --password pw
  watermark <src.pdf> <dest.pdf> [--text txt] [--image img.png] [--pos center|tile|…] [--opacity 0.22] [--rotate 45] [--font-size 48] [--under 1] [--pages 1-3]
  page-numbers <src.pdf> <dest.pdf> [--format \"{{n}} / {{total}}\"] [--pos bottom-center] [--start 1] [--from 1] [--to 0] [--font-size 10] [--margin 28]
  crop <src.pdf> <dest.pdf> [--margins top,right,bottom,left] [--box x1,y1,x2,y2] [--pages 1-5]
  extract-images <src.pdf> <dest-dir> [--min-dim 32] [--password pw]
  sanitize <src.pdf> <dest.pdf> [--annots 1] [--attachments 1] [--forms 1] [--password pw]
  flatten <src.pdf> <dest.pdf> [--password pw]
  redact <src.pdf> <dest.pdf> <rects.json> [--password pw]
  outlines <src.pdf> [--password pw]
  set-outlines <src.pdf> <dest.pdf> <outlines.json> [--password pw]
  nup <src.pdf> <dest.pdf> [--cols 2] [--rows 2] [--landscape 0|1] [--margin 18] [--gap 12] [--border 0|1] [--password pw]
  booklet <src.pdf> <dest.pdf> [--border 0|1] [--password pw]
  grayscale <src.pdf> <dest.pdf> [--whiten 0|1] [--password pw]
  resize <src.pdf> <dest.pdf> [--size A4|A3|Letter|Legal] [--width pt] [--height pt] [--password pw]
  verify-signatures <src.pdf> [--password pw]
  cert-sign <src.pdf> <dest.pdf> --signer <name> [--reason r] [--location l] [--page p] [--rect x,y,w,h] [--p12 path] [--pass pw] [--password pdf_pw]
  split-2up <src.pdf> <dest.pdf> [--dir vertical|horizontal] [--rtl 0|1] [--only-wide 0|1] [--overlap pt] [--password pw]
  single-page <src.pdf> <dest.pdf> [--gap 16] [--border 0|1] [--password pw]
  detect-blank <src.pdf> [--threshold 0.005] [--password pw]
  remove-blank <src.pdf> <dest.pdf> [--threshold 0.005] [--password pw]
  overlay <src.pdf> <dest.pdf> <overlay.pdf> [--under 0|1] [--repeat 0|1] [--overlay-password pw] [--password pw]
  attachments-list <src.pdf> [--password pw]
  attachments-add <src.pdf> <dest.pdf> <file1> [file2 …] [--desc txt] [--password pw]
  attachments-remove <src.pdf> <dest.pdf> [--names a.txt,b.csv] [--password pw]
  pipeline <src.pdf> <dest.pdf> <steps.json> [--password pw]
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
        "watermark" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let mut spec = pdfops::WatermarkSpec::default();
            if let Some(t) = arg(&args, "--text") {
                spec.text = t.to_string();
            }
            if let Some(ip) = arg(&args, "--image") {
                spec.image_png = read(ip);
            }
            if let Some(pos) = arg(&args, "--pos") {
                spec.position = pos.to_string();
            }
            if let Some(op) = arg(&args, "--opacity").and_then(|v| v.parse().ok()) {
                spec.opacity = op;
            }
            if let Some(rot) = arg(&args, "--rotate").and_then(|v| v.parse().ok()) {
                spec.rotate = rot;
            }
            if let Some(fs) = arg(&args, "--font-size").and_then(|v| v.parse().ok()) {
                spec.font_size = fs;
            }
            if let Some(sp) = arg(&args, "--spacing").and_then(|v| v.parse().ok()) {
                spec.tile_spacing = sp;
            }
            if let Some(sc) = arg(&args, "--scale").and_then(|v| v.parse().ok()) {
                spec.scale = sc;
            }
            if let Some(u) = arg(&args, "--under") {
                spec.under = u == "1" || u == "true";
            }
            if let Some(pg) = arg(&args, "--pages") {
                spec.pages = parse_list(pg);
            }
            write(dest, ok(pdfops::watermark_pdf(&read(src), pw, &spec)));
        }
        "page-numbers" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let mut spec = pdfops::PageNumberSpec::default();
            if let Some(f) = arg(&args, "--format") {
                spec.format = f.to_string();
            }
            if let Some(pos) = arg(&args, "--pos") {
                spec.position = pos.to_string();
            }
            if let Some(s) = arg(&args, "--start").and_then(|v| v.parse().ok()) {
                spec.start_number = s;
            }
            if let Some(fr) = arg(&args, "--from").and_then(|v| v.parse().ok()) {
                spec.from_page = fr;
            }
            if let Some(to) = arg(&args, "--to").and_then(|v| v.parse().ok()) {
                spec.to_page = to;
            }
            if let Some(fs) = arg(&args, "--font-size").and_then(|v| v.parse().ok()) {
                spec.font_size = fs;
            }
            if let Some(m) = arg(&args, "--margin").and_then(|v| v.parse().ok()) {
                spec.margin = m;
            }
            write(dest, ok(pdfops::add_page_numbers(&read(src), pw, &spec)));
        }
        "crop" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let mut spec = pdfops::CropSpec::default();
            if let Some(m) = arg(&args, "--margins") {
                let v: Vec<f32> = m.split(',').filter_map(|x| x.trim().parse().ok()).collect();
                if v.len() == 4 {
                    spec.margins = [v[0], v[1], v[2], v[3]];
                } else if v.len() == 1 {
                    spec.margins = [v[0]; 4];
                } else {
                    die("--margins 需要 4 个数值（上,右,下,左）或 1 个统一数值");
                }
            }
            if let Some(b) = arg(&args, "--box") {
                let v: Vec<f32> = b.split(',').filter_map(|x| x.trim().parse().ok()).collect();
                if v.len() == 4 {
                    spec.box_rect = Some([v[0], v[1], v[2], v[3]]);
                } else {
                    die("--box 需要 4 个数值 x1,y1,x2,y2");
                }
            }
            if let Some(pg) = arg(&args, "--pages") {
                spec.pages = parse_list(pg);
            }
            write(dest, ok(pdfops::crop_pages(&read(src), pw, &spec)));
        }
        "extract-images" => {
            let (Some(src), Some(dir)) = (positional.first(), positional.get(1)) else { usage() };
            let min_dim = arg(&args, "--min-dim").and_then(|v| v.parse().ok()).unwrap_or(32);
            std::fs::create_dir_all(dir).ok();
            let pdf = read(src);
            let stem = std::path::Path::new(src.as_str())
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "document".into());
            let imgs = ok(pdfops::extract_images(&pdf, pw, min_dim));
            let mut list = Vec::new();
            for img in imgs {
                let path = format!("{dir}/{stem}-p{:03}-img{:03}.{}", img.page, img.index, img.ext);
                write(&path, img.bytes);
                list.push(serde_json::json!({
                    "path": path,
                    "page": img.page,
                    "index": img.index,
                    "width": img.width,
                    "height": img.height,
                    "format": img.format,
                }));
            }
            println!("{}", serde_json::json!({ "count": list.len(), "images": list }));
        }
        "sanitize" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let spec = pdfops::SanitizeSpec {
                metadata: arg(&args, "--metadata").map(|v| v != "0" && v != "false").unwrap_or(true),
                annotations: arg(&args, "--annots").map(|v| v == "1" || v == "true").unwrap_or(false),
                attachments: arg(&args, "--attachments").map(|v| v == "1" || v == "true").unwrap_or(false),
                javascript_actions: arg(&args, "--actions").map(|v| v != "0" && v != "false").unwrap_or(true),
                forms: arg(&args, "--forms").map(|v| v == "1" || v == "true").unwrap_or(false),
            };
            let (bytes, report) = ok(pdfops::sanitize_pdf(&read(src), pw, &spec));
            write(dest, bytes);
            println!("{}", serde_json::to_string(&report).unwrap_or_default());
        }
        "flatten" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            write(dest, ok(pdfops::flatten_pdf(&read(src), pw)));
        }
        "redact" => {
            let (Some(src), Some(dest), Some(json)) =
                (positional.first(), positional.get(1), positional.get(2))
            else {
                usage()
            };
            let rects: Vec<pdfops::RedactRect> = serde_json::from_slice(&read(json))
                .unwrap_or_else(|e| die(&format!("rects.json 解析失败: {e}")));
            let strip_meta = arg(&args, "--strip-metadata").map(|v| v != "0" && v != "false").unwrap_or(true);
            write(dest, ok(pdfops::redact_pdf(&read(src), pw, &rects, strip_meta)));
        }
        "outlines" => {
            let Some(src) = positional.first() else { usage() };
            let tree = ok(pdfops::get_outlines(&read(src), pw));
            println!("{}", serde_json::to_string_pretty(&tree).unwrap_or_default());
        }
        "set-outlines" => {
            let (Some(src), Some(dest), Some(json)) =
                (positional.first(), positional.get(1), positional.get(2))
            else {
                usage()
            };
            let outlines: Vec<pdfops::OutlineNode> = serde_json::from_slice(&read(json))
                .unwrap_or_else(|e| die(&format!("outlines.json 解析失败: {e}")));
            write(dest, ok(pdfops::set_outlines(&read(src), pw, &outlines)));
        }
        "nup" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let cols = arg(&args, "--cols").and_then(|v| v.parse().ok()).unwrap_or(2);
            let rows = arg(&args, "--rows").and_then(|v| v.parse().ok()).unwrap_or(2);
            let landscape = arg(&args, "--landscape").map(|v| v == "1" || v == "true");
            let margin = arg(&args, "--margin").and_then(|v| v.parse().ok()).unwrap_or(18.0);
            let gap = arg(&args, "--gap").and_then(|v| v.parse().ok()).unwrap_or(12.0);
            let border = arg(&args, "--border").map(|v| v == "1" || v == "true").unwrap_or(false);
            let spec = pdfops::NupSpec {
                cols,
                rows,
                landscape,
                margin,
                gap,
                border,
            };
            write(dest, ok(pdfops::nup_pdf(&read(src), pw, &spec)));
        }
        "booklet" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let border = arg(&args, "--border").map(|v| v == "1" || v == "true").unwrap_or(false);
            write(dest, ok(pdfops::booklet_pdf(&read(src), pw, border)));
        }
        "grayscale" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let whiten = arg(&args, "--whiten").map(|v| v == "1" || v == "true").unwrap_or(false);
            write(dest, ok(pdfops::grayscale_pdf(&read(src), pw, whiten)));
        }
        "resize" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let preset = arg(&args, "--size").map(|s| s.to_ascii_lowercase());
            let (mut w, mut h) = match preset.as_deref() {
                Some("a4") => (595.28f32, 841.89f32),
                Some("a3") => (841.89f32, 1190.55f32),
                Some("letter") => (612.0f32, 792.0f32),
                Some("legal") => (612.0f32, 1008.0f32),
                Some(other) => die(&format!("未知纸张规格: {other}（支持 A4|A3|Letter|Legal）")),
                None => (0.0f32, 0.0f32),
            };
            if let Some( custom_w ) = arg(&args, "--width").and_then(|v| v.parse().ok()) {
                w = custom_w;
            }
            if let Some( custom_h ) = arg(&args, "--height").and_then(|v| v.parse().ok()) {
                h = custom_h;
            }
            if w <= 0.0 || h <= 0.0 {
                die("需要 --size A4|A3|Letter|Legal 或 --width <pt> --height <pt>");
            }
            write(dest, ok(pdfops::normalize_page_size(&read(src), pw, w, h)));
        }
        "verify-signatures" => {
            let Some(src) = positional.first() else { usage() };
            let sigs = ok(crypto_sig::verify_signatures(&read(src), pw));
            println!("{}", serde_json::to_string_pretty(&sigs).unwrap_or_default());
        }
        "cert-sign" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let signer_name = arg(&args, "--signer")
                .map(|s| s.to_string())
                .unwrap_or_else(|| "SoloPDF Signer".to_string());
            let reason = arg(&args, "--reason").map(|s| s.to_string());
            let location = arg(&args, "--location").map(|s| s.to_string());
            let contact = arg(&args, "--contact").map(|s| s.to_string());
            let page = arg(&args, "--page").and_then(|v| v.parse().ok());
            let rect = arg(&args, "--rect").and_then(|r| {
                let v: Vec<f32> = r.split(',').filter_map(|x| x.trim().parse().ok()).collect();
                (v.len() == 4).then(|| [v[0], v[1], v[2], v[3]])
            });
            let p12_bytes = arg(&args, "--p12").map(read);
            let passphrase = arg(&args, "--pass").map(|s| s.to_string());
            let spec = crypto_sig::CertSignSpec {
                signer_name,
                reason,
                location,
                contact,
                page,
                rect,
                p12_bytes,
                passphrase,
            };
            write(dest, ok(crypto_sig::sign_pdf_pkcs12(&read(src), pw, &spec)));
        }
        "split-2up" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let direction = arg(&args, "--dir").unwrap_or("vertical").to_string();
            let rtl = arg(&args, "--rtl").map(|v| v == "1" || v == "true").unwrap_or(false);
            let only_wide = arg(&args, "--only-wide")
                .map(|v| v == "1" || v == "true")
                .unwrap_or(false);
            let overlap = arg(&args, "--overlap").and_then(|v| v.parse().ok()).unwrap_or(0.0);
            let spec = pdfops::Split2upSpec {
                direction,
                rtl,
                only_wide,
                overlap,
            };
            write(dest, ok(pdfops::split_2up_pdf(&read(src), pw, &spec)));
        }
        "single-page" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let gap = arg(&args, "--gap").and_then(|v| v.parse().ok()).unwrap_or(16.0);
            let border = arg(&args, "--border").map(|v| v == "1" || v == "true").unwrap_or(false);
            write(dest, ok(pdfops::single_large_page_pdf(&read(src), pw, gap, border)));
        }
        "detect-blank" => {
            let Some(src) = positional.first() else { usage() };
            let thr = arg(&args, "--threshold").and_then(|v| v.parse().ok()).unwrap_or(0.005);
            let blanks = ok(pdfops::detect_blank_pages(&read(src), pw, thr));
            println!("{}", serde_json::json!({ "blankPages": blanks, "count": blanks.len() }));
        }
        "remove-blank" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let thr = arg(&args, "--threshold").and_then(|v| v.parse().ok()).unwrap_or(0.005);
            let (out, removed) = ok(pdfops::remove_blank_pages(&read(src), pw, thr));
            write(dest, out);
            println!("{}", serde_json::json!({ "removedPages": removed, "count": removed.len() }));
        }
        "overlay" => {
            let (Some(src), Some(dest), Some(ov_path)) =
                (positional.first(), positional.get(1), positional.get(2))
            else {
                usage()
            };
            let under = arg(&args, "--under").map(|v| v != "0" && v != "false").unwrap_or(true);
            let repeat = arg(&args, "--repeat").map(|v| v != "0" && v != "false").unwrap_or(true);
            let ov_pw = arg(&args, "--overlay-password");
            write(
                dest,
                ok(pdfops::overlay_pdf(
                    &read(src),
                    pw,
                    &read(ov_path),
                    ov_pw,
                    under,
                    repeat,
                )),
            );
        }
        "attachments-list" => {
            let Some(src) = positional.first() else { usage() };
            let list = ok(pdfops::list_embedded_attachments(&read(src), pw));
            println!("{}", serde_json::to_string_pretty(&list).unwrap_or_default());
        }
        "attachments-add" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            if positional.len() < 3 {
                die("需要至少一个待嵌入的附件文件路径");
            }
            let desc = arg(&args, "--desc").unwrap_or("").to_string();
            let mut inputs = Vec::new();
            for fpath in &positional[2..] {
                let bytes = read(fpath);
                let name = std::path::Path::new(fpath.as_str())
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "attachment".into());
                inputs.push(pdfops::EmbeddedAttachmentInput {
                    name,
                    bytes,
                    description: desc.clone(),
                });
            }
            write(dest, ok(pdfops::add_embedded_attachments(&read(src), pw, &inputs)));
        }
        "attachments-remove" => {
            let (Some(src), Some(dest)) = (positional.first(), positional.get(1)) else { usage() };
            let names: Vec<String> = arg(&args, "--names")
                .map(|s| {
                    s.split(',')
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            write(dest, ok(pdfops::remove_embedded_attachments(&read(src), pw, &names)));
        }
        "pipeline" => {
            let (Some(src), Some(dest), Some(json_arg)) =
                (positional.first(), positional.get(1), positional.get(2))
            else {
                usage()
            };
            let raw_json = if std::path::Path::new(json_arg.as_str()).exists() {
                read(json_arg)
            } else {
                json_arg.as_bytes().to_vec()
            };
            let steps: Vec<pdfops::PipelineStep> = serde_json::from_slice(&raw_json)
                .unwrap_or_else(|e| die(&format!("pipeline steps 解析失败: {e}")));
            write(dest, ok(pdfops::run_pipeline(&read(src), pw, &steps)));
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

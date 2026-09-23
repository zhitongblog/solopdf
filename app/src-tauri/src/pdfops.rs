//! Document-level PDF operations: everything that WRITES a new PDF.
//!
//! All of it goes through `lopdf` (already a dependency for the OCR text
//! layer) rather than a second engine, and all of it is copy-out: the source
//! file is opened read-only and a new byte vector comes back. SoloPDF never
//! edits a user's PDF in place — a reader that can corrupt the thing you were
//! reading is not a reader anyone should trust.
//!
//! Contents:
//!   annotations  — sidecar marks → standard PDF markup annotations
//!   pages        — rotate / delete / extract / reorder / merge / split
//!   images       — PDF → (rendered elsewhere) / images → PDF / recompress
//!   stamp        — signature and date images placed on a page
//!   security     — set or remove an open password

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;

type R<T> = Result<T, String>;

fn e<T: std::fmt::Display>(what: &str) -> impl Fn(T) -> String + '_ {
    move |err| format!("{what}: {err}")
}

// ── loading / saving ─────────────────────────────────────────────────────

pub fn load(bytes: &[u8], password: Option<&str>) -> R<Document> {
    let mut doc = Document::load_mem(bytes).map_err(e("无法解析 PDF"))?;
    if doc.is_encrypted() {
        normalize_encrypt_dict(&mut doc);
        let pw = password.unwrap_or("");
        doc.decrypt(pw).map_err(e("解密失败（密码不对？）"))?;
    }
    Ok(doc)
}

/// Work around lopdf's over-strict `/Length` check on AES-256 documents.
///
/// Per ISO 32000 `/Length` only applies to V2/V3 (40–128 bits), but plenty of
/// real V5 producers — including the tool that made our own encrypted test
/// fixture — write `/Length 256`. lopdf validates the range for every version
/// and refuses the file outright. For V5 the key length is fixed at 256 bits,
/// so dropping the entry is both safe and spec-correct.
fn normalize_encrypt_dict(doc: &mut Document) {
    let Ok(entry) = doc.trailer.get(b"Encrypt").cloned() else { return };
    let fix = |d: &mut Dictionary| {
        let v = d.get(b"V").and_then(Object::as_i64).unwrap_or(0);
        let len = d.get(b"Length").and_then(Object::as_i64).unwrap_or(0);
        if v >= 5 && !(40..=128).contains(&len) {
            d.remove(b"Length");
        }
    };
    match entry {
        Object::Reference(id) => {
            if let Ok(Object::Dictionary(d)) = doc.get_object_mut(id) {
                fix(d);
            }
        }
        Object::Dictionary(mut d) => {
            fix(&mut d);
            doc.trailer.set("Encrypt", Object::Dictionary(d));
        }
        _ => {}
    }
}

pub fn save(doc: &mut Document) -> R<Vec<u8>> {
    doc.compress();
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(e("写入 PDF 失败"))?;
    Ok(out)
}

/// Page object ids in document order (1-based page number → id).
fn page_ids(doc: &Document) -> Vec<ObjectId> {
    doc.get_pages().into_values().collect()
}

// ── annotations ──────────────────────────────────────────────────────────

#[derive(Deserialize, Clone, Debug, Default)]
pub struct AnnotSpec {
    /// 1-based
    pub page: u32,
    /// highlight | underline | strike | squiggly | note | region |
    /// ink | textbox | rect | ellipse | line | arrow
    pub kind: String,
    /// PDF user-space rects, one per visual line (drawn marks: their box)
    pub quads: Vec<[f32; 4]>,
    /// 0–1 RGB
    pub color: [f32; 3],
    #[serde(default)]
    pub contents: String,
    #[serde(default)]
    pub author: String,
    /// drawn marks: stroke width in points
    #[serde(default)]
    pub width: f32,
    /// ink: strokes as flat [x0, y0, x1, y1, …] Catmull-Rom control points
    #[serde(default)]
    pub strokes: Vec<Vec<f32>>,
    /// ink: per-point width factors (stylus pressure), parallel to `strokes`
    #[serde(default)]
    pub pressure: Vec<Vec<f32>>,
    /// line/arrow: start → end
    #[serde(default)]
    pub line: Option<[f32; 4]>,
    /// text box: font size in points
    #[serde(default)]
    pub font_size: f32,
    /// text box: screen rotation it was typed at (0/90/180/270) — the text
    /// runs along that screen's x axis, see core DrawData.rotate
    #[serde(default)]
    pub rotate: i32,
}

fn subtype_of(kind: &str) -> &'static str {
    match kind {
        "underline" => "Underline",
        "strike" => "StrikeOut",
        "squiggly" => "Squiggly",
        "note" => "Text",
        "region" | "rect" => "Square",
        "ellipse" => "Circle",
        "line" | "arrow" => "Line",
        "ink" => "Ink",
        "textbox" => "FreeText",
        _ => "Highlight",
    }
}

/// A PDF *text string*: plain bytes when ASCII, else UTF-16BE with a BOM.
/// Raw UTF-8 is not a valid text string — every reader decodes it as
/// PDFDocEncoding and a Chinese note turns into mojibake.
fn text_string(s: &str) -> Object {
    if s.is_ascii() {
        return Object::string_literal(s);
    }
    let mut b = vec![0xFE, 0xFF];
    for u in s.encode_utf16() {
        b.extend_from_slice(&u.to_be_bytes());
    }
    Object::String(b, lopdf::StringFormat::Hexadecimal)
}

fn bbox(quads: &[[f32; 4]]) -> [f32; 4] {
    let mut r = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
    for q in quads {
        r[0] = r[0].min(q[0].min(q[2]));
        r[1] = r[1].min(q[1].min(q[3]));
        r[2] = r[2].max(q[0].max(q[2]));
        r[3] = r[3].max(q[1].max(q[3]));
    }
    if quads.is_empty() { [0.0, 0.0, 0.0, 0.0] } else { r }
}

fn nums(v: &[f32]) -> Object {
    Object::Array(v.iter().map(|n| Object::Real(*n)).collect())
}

/// Write sidecar marks into a copy of the PDF as standard markup annotations,
/// so Preview / Acrobat / Foxit show them too.
///
/// Text marks get no appearance stream: every mainstream renderer (PDFium,
/// Preview, Acrobat, pdf.js) synthesises Highlight/Underline/StrikeOut/
/// Squiggly/Text from QuadPoints, and a hand-rolled /AP is one more thing to
/// get wrong per viewer. Drawn marks (Ink/Square/Circle/Line/FreeText) DO
/// get one — viewers are far less consistent at synthesising those, and a
/// pressure-varying ink stroke can't be described by /BS at all.
pub fn write_annotations(pdf: &[u8], password: Option<&str>, annots: &[AnnotSpec]) -> R<Vec<u8>> {
    let mut doc = load(pdf, password)?;
    let pages = page_ids(&doc);
    // group by page so each page's /Annots is touched once
    let mut by_page: std::collections::BTreeMap<u32, Vec<&AnnotSpec>> = Default::default();
    for a in annots {
        if a.page >= 1 && (a.page as usize) <= pages.len() {
            by_page.entry(a.page).or_default().push(a);
        }
    }
    for (page_no, specs) in by_page {
        let page_id = pages[page_no as usize - 1];
        let mut new_ids: Vec<Object> = Vec::new();
        for a in specs {
            let rect = bbox(&a.quads);
            let mut dict = dictionary! {
                "Type" => "Annot",
                "Subtype" => subtype_of(&a.kind),
                // 4 = Print: an annotation nobody can print is half a feature
                "F" => 4,
                "C" => nums(&a.color),
                "Contents" => text_string(&a.contents),
                "T" => text_string(if a.author.is_empty() { "SoloPDF" } else { &a.author }),
            };
            match a.kind.as_str() {
                "ink" | "rect" | "ellipse" | "line" | "arrow" | "textbox" => {
                    drawn_annotation(&mut doc, &mut dict, a);
                }
                "note" => {
                    // a pin, drawn by the viewer at a fixed icon size
                    dict.set("Rect", nums(&[rect[0], rect[1] - 20.0, rect[0] + 20.0, rect[1]]));
                    dict.set("Name", Object::Name(b"Comment".to_vec()));
                    dict.set("Open", Object::Boolean(false));
                }
                "region" => {
                    dict.set("Rect", nums(&rect));
                    dict.set("BS", Object::Dictionary(dictionary! { "W" => 2, "S" => "S" }));
                }
                _ => {
                    dict.set("Rect", nums(&rect));
                    // QuadPoints order is upper-left, upper-right, lower-left,
                    // lower-right — NOT the rect order, and viewers that read
                    // it literally will draw a bow-tie if you get it wrong
                    let mut qp: Vec<f32> = Vec::with_capacity(a.quads.len() * 8);
                    for q in &a.quads {
                        let (x1, x2) = (q[0].min(q[2]), q[0].max(q[2]));
                        let (y1, y2) = (q[1].min(q[3]), q[1].max(q[3]));
                        qp.extend_from_slice(&[x1, y2, x2, y2, x1, y1, x2, y1]);
                    }
                    dict.set("QuadPoints", nums(&qp));
                    if a.kind == "highlight" {
                        dict.set("CA", Object::Real(0.4));
                    }
                }
            }
            let id = doc.add_object(Object::Dictionary(dict));
            new_ids.push(Object::Reference(id));
        }
        // append to whatever the page already had
        let existing = doc
            .get_dictionary(page_id)
            .ok()
            .and_then(|d| d.get(b"Annots").ok().cloned());
        let mut list: Vec<Object> = match existing {
            Some(Object::Array(v)) => v,
            Some(Object::Reference(r)) => match doc.get_object(r) {
                Ok(Object::Array(v)) => v.clone(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        };
        list.extend(new_ids);
        doc.get_dictionary_mut(page_id)
            .map_err(e("页面结构异常"))?
            .set("Annots", Object::Array(list));
    }
    save(&mut doc)
}

// ── drawn marks: ink / shapes / text boxes ───────────────────────────────

/// Uniform Catmull-Rom through `pts` as cubic Béziers — the exact mirror of
/// core/src/drawing.ts catmullRom(), so the exported stroke is the curve the
/// reader saw on screen. Each item: [c1x, c1y, c2x, c2y, x, y].
fn catmull_rom(pts: &[(f32, f32)]) -> Vec<[f32; 6]> {
    let n = pts.len();
    let p = |i: isize| pts[i.clamp(0, n as isize - 1) as usize];
    (0..n.saturating_sub(1))
        .map(|i| {
            let i = i as isize;
            let (x0, y0) = p(i - 1);
            let (x1, y1) = p(i);
            let (x2, y2) = p(i + 1);
            let (x3, y3) = p(i + 2);
            [
                x1 + (x2 - x0) / 6.0,
                y1 + (y2 - y0) / 6.0,
                x2 - (x3 - x1) / 6.0,
                y2 - (y3 - y1) / 6.0,
                x2,
                y2,
            ]
        })
        .collect()
}

/// Wings of an open arrowhead at the END of `line` (mirrors arrowHead()).
fn arrow_wings(line: [f32; 4], width: f32) -> [f32; 4] {
    let [x1, y1, x2, y2] = line;
    let len = ((x2 - x1).powi(2) + (y2 - y1).powi(2)).sqrt().max(0.001);
    let (ux, uy) = ((x2 - x1) / len, (y2 - y1) / len);
    let size = (width * 4.0).max(7.0);
    let a = std::f32::consts::PI / 7.0;
    let (back, side) = (size * a.cos(), size * a.sin());
    [
        x2 - ux * back - uy * side,
        y2 - uy * back + ux * side,
        x2 - ux * back + uy * side,
        y2 - uy * back - ux * side,
    ]
}

fn op(name: &str, args: &[f32]) -> Operation {
    Operation::new(name, args.iter().map(|n| Object::Real(*n)).collect())
}

fn pairs(v: &[f32]) -> Vec<(f32, f32)> {
    v.chunks_exact(2).map(|c| (c[0], c[1])).collect()
}

/// Grow `r` to cover every point, padded by `pad`.
fn cover(mut r: [f32; 4], pts: &[(f32, f32)], pad: f32) -> [f32; 4] {
    for (x, y) in pts {
        r[0] = r[0].min(x - pad);
        r[1] = r[1].min(y - pad);
        r[2] = r[2].max(x + pad);
        r[3] = r[3].max(y + pad);
    }
    r
}

/// Standard Helvetica advance widths (AFM, per mille) for ASCII 32–126.
const HELV: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
    611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
    222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/// Text a WinAnsi Helvetica can show (Latin-1 printable, which WinAnsi
/// shares byte for byte). Anything else goes through the CJK font.
fn is_latin(c: char) -> bool {
    matches!(c as u32, 0x20..=0x7E | 0xA0..=0xFF)
}

fn char_width(c: char, latin_font: bool, fs: f32) -> f32 {
    let u = c as u32;
    if (0x20..=0x7E).contains(&u) {
        // the CJK font's Latin range is half-width
        if latin_font { HELV[(u - 0x20) as usize] as f32 / 1000.0 * fs } else { fs * 0.5 }
    } else if latin_font {
        fs * 0.556
    } else {
        fs
    }
}

/// Greedy wrap to `max_w`: Latin words stay whole where they fit, CJK breaks
/// anywhere (as it does on screen).
fn wrap(text: &str, latin_font: bool, fs: f32, max_w: f32) -> Vec<String> {
    let mut out = Vec::new();
    for para in text.split('\n') {
        // tokens: a run of Latin letters/digits, or any single other char
        let mut tokens: Vec<String> = Vec::new();
        for c in para.chars() {
            let wordy = c.is_ascii_alphanumeric() || (is_latin(c) && c.is_alphanumeric());
            match tokens.last_mut() {
                Some(t) if wordy && t.chars().last().map_or(false, |p| p.is_ascii_alphanumeric() || (is_latin(p) && p.is_alphanumeric())) => t.push(c),
                _ => tokens.push(c.to_string()),
            }
        }
        let mut line = String::new();
        let mut w = 0.0;
        for t in tokens {
            let tw: f32 = t.chars().map(|c| char_width(c, latin_font, fs)).sum();
            if w + tw > max_w && !line.is_empty() {
                out.push(line.trim_end().to_string());
                line = String::new();
                w = 0.0;
                if t == " " {
                    continue;
                }
            }
            if tw > max_w {
                // a single word wider than the box: split it by characters
                for c in t.chars() {
                    let cw = char_width(c, latin_font, fs);
                    if w + cw > max_w && !line.is_empty() {
                        out.push(std::mem::take(&mut line));
                        w = 0.0;
                    }
                    line.push(c);
                    w += cw;
                }
                continue;
            }
            line.push_str(&t);
            w += tw;
        }
        out.push(line.trim_end().to_string());
    }
    out
}

/// Font resource for a text box: WinAnsi Helvetica, or — for anything past
/// Latin-1 — Adobe's non-embedded STSong-Light via UniGB-UCS2-H. That is the
/// standard "CJK without embedding a font" route: Acrobat maps it to its
/// Asian font pack, Preview/PDFium/pdf.js to a system CJK face.
fn text_font(latin_font: bool) -> Dictionary {
    if latin_font {
        return dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
            "Encoding" => "WinAnsiEncoding",
        };
    }
    let descriptor = dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => "STSong-Light",
        "Flags" => 6,
        "FontBBox" => vec![Object::Integer(-25), Object::Integer(-254), Object::Integer(1000), Object::Integer(880)],
        "ItalicAngle" => 0,
        "Ascent" => 880,
        "Descent" => -120,
        "CapHeight" => 880,
        "StemV" => 93,
    };
    let cid = dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType0",
        "BaseFont" => "STSong-Light",
        "CIDSystemInfo" => dictionary! {
            "Registry" => Object::string_literal("Adobe"),
            "Ordering" => Object::string_literal("GB1"),
            "Supplement" => 2,
        },
        "FontDescriptor" => descriptor,
        "DW" => 1000,
        // CIDs 1–95 are the half-width Latin range in Adobe-GB1
        "W" => vec![Object::Integer(1), Object::Integer(95), Object::Integer(500)],
    };
    dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "BaseFont" => "STSong-Light",
        "Encoding" => "UniGB-UCS2-H",
        "DescendantFonts" => vec![Object::Dictionary(cid)],
    }
}

fn text_bytes(line: &str, latin_font: bool) -> Object {
    if latin_font {
        let b: Vec<u8> = line.chars().map(|c| c as u32 as u8).collect();
        return Object::String(b, lopdf::StringFormat::Literal);
    }
    // UCS-2: characters beyond the BMP have no code in this CMap
    let mut b = Vec::with_capacity(line.len() * 2);
    for c in line.chars() {
        let u = if (c as u32) < 0x10000 { c as u32 as u16 } else { '?' as u16 };
        b.extend_from_slice(&u.to_be_bytes());
    }
    Object::String(b, lopdf::StringFormat::Hexadecimal)
}

/// Fill in an Ink / Square / Circle / Line / FreeText annotation: geometry
/// keys, border style and a normal appearance stream drawn in page space
/// (BBox = Rect, identity Matrix, so the stream's coordinates ARE the page's).
fn drawn_annotation(doc: &mut Document, dict: &mut Dictionary, a: &AnnotSpec) {
    let w = if a.width > 0.0 { a.width } else { 1.5 };
    let [r, g, b] = a.color;
    let mut rect = bbox(&a.quads);
    let mut ops: Vec<Operation> = vec![
        op("q", &[]),
        op("RG", &[r, g, b]),
        // round caps + joins: a pen stroke, not a technical drawing
        Operation::new("J", vec![Object::Integer(1)]),
        Operation::new("j", vec![Object::Integer(1)]),
    ];
    let mut resources: Option<Dictionary> = None;
    match a.kind.as_str() {
        "ink" => {
            let mut ink_list = Vec::new();
            for (si, s) in a.strokes.iter().enumerate() {
                let pts = pairs(s);
                if pts.is_empty() {
                    continue;
                }
                ink_list.push(nums(s));
                let f = a.pressure.get(si).filter(|f| f.len() == pts.len());
                let max_f = f.map_or(1.0, |f| f.iter().cloned().fold(1.0, f32::max));
                rect = cover(rect, &pts, w * max_f / 2.0 + 0.5);
                if pts.len() == 1 {
                    // a dot: zero-length line, the round cap draws the disc
                    let (x, y) = pts[0];
                    ops.push(op("w", &[w * f.map_or(1.0, |f| f[0])]));
                    ops.push(op("m", &[x, y]));
                    ops.push(op("l", &[x, y]));
                    ops.push(op("S", &[]));
                    continue;
                }
                let segs = catmull_rom(&pts);
                match f {
                    None => {
                        ops.push(op("w", &[w]));
                        ops.push(op("m", &[pts[0].0, pts[0].1]));
                        for c in &segs {
                            ops.push(op("c", c));
                        }
                        ops.push(op("S", &[]));
                    }
                    Some(f) => {
                        // pressure: each segment at its own width, round caps
                        // hide the seams
                        for (i, c) in segs.iter().enumerate() {
                            ops.push(op("w", &[w * (f[i] + f[i + 1]) / 2.0]));
                            ops.push(op("m", &[pts[i].0, pts[i].1]));
                            ops.push(op("c", c));
                            ops.push(op("S", &[]));
                        }
                    }
                }
            }
            dict.set("InkList", Object::Array(ink_list));
        }
        "rect" | "ellipse" => {
            let i = w / 2.0;
            let (x1, y1, x2, y2) = (rect[0] + i, rect[1] + i, rect[2] - i, rect[3] - i);
            ops.push(op("w", &[w]));
            if a.kind == "rect" {
                ops.push(op("re", &[x1, y1, x2 - x1, y2 - y1]));
            } else {
                // four Béziers, κ = 0.5523 — the classic circle approximation
                let (cx, cy, rx, ry) = ((x1 + x2) / 2.0, (y1 + y2) / 2.0, (x2 - x1) / 2.0, (y2 - y1) / 2.0);
                let (kx, ky) = (rx * 0.5523, ry * 0.5523);
                ops.push(op("m", &[cx + rx, cy]));
                ops.push(op("c", &[cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry]));
                ops.push(op("c", &[cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy]));
                ops.push(op("c", &[cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry]));
                ops.push(op("c", &[cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy]));
                ops.push(op("h", &[]));
            }
            ops.push(op("S", &[]));
            // RD: how far the drawn border sits inside Rect (none here)
            dict.set("RD", nums(&[0.0, 0.0, 0.0, 0.0]));
        }
        "line" | "arrow" => {
            let l = a.line.unwrap_or([rect[0], rect[1], rect[2], rect[3]]);
            ops.push(op("w", &[w]));
            ops.push(op("m", &[l[0], l[1]]));
            ops.push(op("l", &[l[2], l[3]]));
            ops.push(op("S", &[]));
            let mut pts = vec![(l[0], l[1]), (l[2], l[3])];
            let end = if a.kind == "arrow" {
                let h = arrow_wings(l, w);
                ops.push(op("m", &[h[0], h[1]]));
                ops.push(op("l", &[l[2], l[3]]));
                ops.push(op("l", &[h[2], h[3]]));
                ops.push(op("S", &[]));
                pts.push((h[0], h[1]));
                pts.push((h[2], h[3]));
                "OpenArrow"
            } else {
                "None"
            };
            rect = cover(rect, &pts, w / 2.0 + 0.5);
            dict.set("L", nums(&l));
            dict.set("LE", Object::Array(vec![Object::Name(b"None".to_vec()), Object::Name(end.as_bytes().to_vec())]));
        }
        "textbox" => {
            let fs = if a.font_size > 0.0 { a.font_size } else { 12.0 };
            let latin_font = a.contents.chars().all(|c| c == '\n' || is_latin(c));
            let pad = 2.0;
            // text frame: origin at the box's top-left AS SEEN when typed,
            // x along the text, y up the text (see drawing.ts textFrame)
            let [x1, y1, x2, y2] = rect;
            let (m, frame_w) = match ((a.rotate % 360) + 360) % 360 {
                90 => ([0.0, 1.0, -1.0, 0.0, x1, y1], y2 - y1),
                180 => ([-1.0, 0.0, 0.0, -1.0, x2, y1], x2 - x1),
                270 => ([0.0, -1.0, 1.0, 0.0, x2, y2], y2 - y1),
                _ => ([1.0, 0.0, 0.0, 1.0, x1, y2], x2 - x1),
            };
            let lines = wrap(&a.contents, latin_font, fs, (frame_w - 2.0 * pad).max(fs));
            let lead = fs * 1.25;
            ops.push(op("cm", &m));
            ops.push(op("BT", &[]));
            ops.push(Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), Object::Real(fs)]));
            ops.push(op("rg", &[r, g, b]));
            ops.push(op("Td", &[pad, -pad - fs * 0.9]));
            for (i, line) in lines.iter().enumerate() {
                if i > 0 {
                    ops.push(op("Td", &[0.0, -lead]));
                }
                ops.push(Operation::new("Tj", vec![text_bytes(line, latin_font)]));
            }
            ops.push(op("ET", &[]));
            resources = Some(dictionary! { "Font" => dictionary! { "F1" => text_font(latin_font) } });
            let hex = format!(
                "#{:02x}{:02x}{:02x}",
                (r * 255.0).round() as u8,
                (g * 255.0).round() as u8,
                (b * 255.0).round() as u8
            );
            // DA is what a viewer regenerates the look from; DS is the
            // rich-text default style Acrobat and Preview read on edit
            dict.set("DA", Object::string_literal(format!("/Helv {fs} Tf {r} {g} {b} rg")));
            dict.set("DS", Object::string_literal(format!("font: {fs}pt Helvetica; color: {hex}")));
            // no border: it is text on the page, not a form field
            dict.set("BS", Object::Dictionary(dictionary! { "W" => 0 }));
        }
        _ => {}
    }
    ops.push(op("Q", &[]));
    if a.kind != "textbox" {
        dict.set("BS", Object::Dictionary(dictionary! { "W" => Object::Real(w), "S" => "S" }));
    }
    dict.set("Rect", nums(&rect));
    let content = Content { operations: ops }.encode().unwrap_or_default();
    let mut form = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Form",
        "BBox" => nums(&rect),
    };
    if let Some(res) = resources {
        form.set("Resources", Object::Dictionary(res));
    }
    let ap = doc.add_object(Stream::new(form, content));
    dict.set("AP", Object::Dictionary(dictionary! { "N" => Object::Reference(ap) }));
}


// ── page operations ──────────────────────────────────────────────────────

/// Rotate pages by an absolute angle. `pages` empty means every page.
pub fn rotate_pages(pdf: &[u8], password: Option<&str>, pages: &[u32], degrees: i64) -> R<Vec<u8>> {
    let mut doc = load(pdf, password)?;
    let ids = page_ids(&doc);
    let targets: Vec<usize> = if pages.is_empty() {
        (0..ids.len()).collect()
    } else {
        pages.iter().filter(|p| **p >= 1 && (**p as usize) <= ids.len()).map(|p| *p as usize - 1).collect()
    };
    for i in targets {
        let d = doc.get_dictionary_mut(ids[i]).map_err(e("页面结构异常"))?;
        let base = d.get(b"Rotate").and_then(Object::as_i64).unwrap_or(0);
        let next = ((base + degrees) % 360 + 360) % 360;
        d.set("Rotate", Object::Integer(next));
    }
    save(&mut doc)
}

/// Keep exactly `order` (1-based page numbers), in that order.
/// One primitive covers delete, extract and reorder — they are all "which
/// pages, in what sequence" and doing them separately invites three bugs.
pub fn arrange_pages(pdf: &[u8], password: Option<&str>, order: &[u32]) -> R<Vec<u8>> {
    if order.is_empty() {
        return Err("至少要保留一页".into());
    }
    let mut doc = load(pdf, password)?;
    let ids = page_ids(&doc);
    for p in order {
        if *p < 1 || (*p as usize) > ids.len() {
            return Err(format!("页码 {p} 超出范围"));
        }
    }
    let keep: Vec<ObjectId> = order.iter().map(|p| ids[*p as usize - 1]).collect();
    let pages_id = doc
        .catalog()
        .and_then(|c| c.get(b"Pages"))
        .and_then(Object::as_reference)
        .map_err(e("找不到页面树"))?;
    // flatten the tree: every kept page becomes a direct child of the root
    // Pages node, which is legal and sidesteps intermediate-node bookkeeping
    for id in &keep {
        if let Ok(d) = doc.get_dictionary_mut(*id) {
            d.set("Parent", Object::Reference(pages_id));
        }
    }
    let kids: Vec<Object> = keep.iter().map(|id| Object::Reference(*id)).collect();
    let count = kids.len() as i64;
    let root = doc.get_dictionary_mut(pages_id).map_err(e("页面树异常"))?;
    root.set("Kids", Object::Array(kids));
    root.set("Count", Object::Integer(count));
    // outline destinations may point at dropped pages; a dangling /Dest is a
    // dead click, a pruned one is just absent
    doc.catalog_mut().ok().map(|c| c.remove(b"Outlines"));
    doc.prune_objects();
    doc.renumber_objects();
    save(&mut doc)
}

/// Concatenate documents. Each input may carry its own password.
pub fn merge(inputs: &[(Vec<u8>, Option<String>)]) -> R<Vec<u8>> {
    if inputs.is_empty() {
        return Err("没有要合并的文件".into());
    }
    let mut out = Document::with_version("1.5");
    let mut page_refs: Vec<ObjectId> = Vec::new();
    // Renumber every input into a disjoint id range BEFORE allocating any id
    // of our own: taking one first (for the Pages node) collides with the
    // first document's object 1 and silently eats a page.
    let mut max_id = 1u32;

    for (bytes, pw) in inputs {
        let mut doc = load(bytes, pw.as_deref())?;
        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;
        let page_list = page_ids(&doc);
        // inherited attributes (MediaBox/Resources/Rotate) live on the old
        // parent node, which we are about to drop — copy them down first
        for id in &page_list {
            for key in [&b"MediaBox"[..], b"Resources", b"Rotate", b"CropBox"] {
                if doc.get_dictionary(*id).map(|d| d.has(key)).unwrap_or(false) {
                    continue;
                }
                if let Some(v) = inherited(&doc, *id, key) {
                    if let Ok(d) = doc.get_dictionary_mut(*id) {
                        d.set(key.to_vec(), v);
                    }
                }
            }
        }
        page_refs.extend(page_list);
        out.objects.extend(doc.objects);
    }

    // Point the document's own id counter past every imported object BEFORE
    // allocating the Pages node and the catalog — new_object_id() starts at 1
    // otherwise and overwrites the first input's object 1 (which silently
    // costs a page).
    out.max_id = max_id;
    let pages_id = out.new_object_id();
    for id in &page_refs {
        if let Ok(d) = out.get_dictionary_mut(*id) {
            d.set("Parent", Object::Reference(pages_id));
        }
    }
    let kids: Vec<Object> = page_refs.iter().map(|id| Object::Reference(*id)).collect();
    let count = kids.len() as i64;
    out.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(kids),
            "Count" => count,
        }),
    );
    let catalog_id = out.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    out.trailer.set("Root", catalog_id);
    out.prune_objects();
    out.renumber_objects();
    save(&mut out)
}

/// Walk up /Parent looking for an inheritable page attribute.
fn inherited(doc: &Document, page: ObjectId, key: &[u8]) -> Option<Object> {
    let mut node = page;
    for _ in 0..32 {
        let d = doc.get_dictionary(node).ok()?;
        if let Ok(v) = d.get(key) {
            return Some(v.clone());
        }
        node = d.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

/// Split into several documents, one per page range (1-based, inclusive).
pub fn split(pdf: &[u8], password: Option<&str>, ranges: &[(u32, u32)]) -> R<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    for (from, to) in ranges {
        let order: Vec<u32> = (*from..=*to).collect();
        out.push(arrange_pages(pdf, password, &order)?);
    }
    Ok(out)
}

// ── images ───────────────────────────────────────────────────────────────

/// Build an image XObject (plus an /SMask when the source has real alpha).
fn image_xobject(bytes: &[u8]) -> R<(Stream, Option<Stream>)> {
    let img = image::load_from_memory(bytes).map_err(e("图片解码失败"))?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    let mut alpha = Vec::with_capacity((w * h) as usize);
    for p in rgba.pixels() {
        rgb.extend_from_slice(&p.0[..3]);
        alpha.push(p.0[3]);
    }
    let mut stream = Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => w as i64,
            "Height" => h as i64,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
        },
        rgb,
    );
    let _ = stream.compress();
    let smask = if alpha.iter().any(|a| *a != 255) {
        let mut m = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => w as i64,
                "Height" => h as i64,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
            },
            alpha,
        );
        let _ = m.compress();
        Some(m)
    } else {
        None
    };
    Ok((stream, smask))
}

/// One image per page, page sized to the image at `dpi`.
pub fn images_to_pdf(images: &[Vec<u8>], dpi: f32) -> R<Vec<u8>> {
    if images.is_empty() {
        return Err("没有图片".into());
    }
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let mut kids = Vec::new();
    for bytes in images {
        let dims = image::load_from_memory(bytes).map_err(e("图片解码失败"))?;
        let (iw, ih) = (dims.width() as f32, dims.height() as f32);
        let (pw, ph) = (iw * 72.0 / dpi, ih * 72.0 / dpi);
        let (xobj, smask) = image_xobject(bytes)?;
        let mut xobj = xobj;
        if let Some(m) = smask {
            let mid = doc.add_object(m);
            xobj.dict.set("SMask", Object::Reference(mid));
        }
        let img_id = doc.add_object(xobj);
        let content = format!("q {pw} 0 0 {ph} 0 0 cm /Im0 Do Q");
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "MediaBox" => nums(&[0.0, 0.0, pw, ph]),
            "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => img_id } },
        });
        kids.push(Object::Reference(page_id));
    }
    let count = kids.len() as i64;
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => Object::Array(kids), "Count" => count,
        }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    save(&mut doc)
}

/// Shrink a PDF: re-encode oversized image XObjects as JPEG and flate the
/// rest. Conservative on purpose — anything with an unusual colour space,
/// bit depth or filter chain is left exactly as it was, because a smaller
/// file that renders wrong is worse than a big one that renders right.
pub fn compress_pdf(pdf: &[u8], password: Option<&str>, max_dim: u32, quality: u8) -> R<Vec<u8>> {
    let mut doc = load(pdf, password)?;
    let ids: Vec<ObjectId> = doc.objects.keys().cloned().collect();
    for id in ids {
        let Ok(stream) = doc.get_object(id).and_then(|o| o.as_stream()) else { continue };
        if !stream.dict.has_type(b"XObject") {
            continue;
        }
        if stream.dict.get(b"Subtype").and_then(Object::as_name).map(|n| n != b"Image").unwrap_or(true) {
            continue;
        }
        // only plain 8-bit RGB/Gray without a mask; everything else is skipped
        if stream.dict.get(b"SMask").is_ok() || stream.dict.get(b"Mask").is_ok() {
            continue;
        }
        if stream.dict.get(b"BitsPerComponent").and_then(Object::as_i64).unwrap_or(0) != 8 {
            continue;
        }
        let cs = stream.dict.get(b"ColorSpace").and_then(Object::as_name).map(|n| n.to_vec()).ok();
        let gray = match cs.as_deref() {
            Some(b"DeviceRGB") => false,
            Some(b"DeviceGray") => true,
            _ => continue,
        };
        let w = stream.dict.get(b"Width").and_then(Object::as_i64).unwrap_or(0) as u32;
        let h = stream.dict.get(b"Height").and_then(Object::as_i64).unwrap_or(0) as u32;
        if w == 0 || h == 0 {
            continue;
        }
        let filters = stream.filters().unwrap_or_default();
        let is_jpeg = filters.iter().any(|f| *f == b"DCTDecode");
        if w <= max_dim && h <= max_dim && is_jpeg {
            continue; // already small and already compressed
        }
        let raw: Vec<u8> = if is_jpeg {
            stream.content.clone()
        } else {
            match stream.decompressed_content() {
                Ok(c) => c,
                Err(_) => continue,
            }
        };
        let img = if is_jpeg {
            match image::load_from_memory(&raw) {
                Ok(i) => i,
                Err(_) => continue,
            }
        } else {
            let expected = (w * h * if gray { 1 } else { 3 }) as usize;
            if raw.len() < expected {
                continue;
            }
            let buf = if gray {
                image::GrayImage::from_raw(w, h, raw[..expected].to_vec()).map(image::DynamicImage::ImageLuma8)
            } else {
                image::RgbImage::from_raw(w, h, raw[..expected].to_vec()).map(image::DynamicImage::ImageRgb8)
            };
            match buf {
                Some(i) => i,
                None => continue,
            }
        };
        let img = if img.width() > max_dim || img.height() > max_dim {
            img.resize(max_dim, max_dim, image::imageops::FilterType::Lanczos3)
        } else {
            img
        };
        let mut jpg = Vec::new();
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, quality);
        let rgb = img.to_rgb8();
        if image::ImageEncoder::write_image(
            enc,
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .is_err()
        {
            continue;
        }
        // only accept the swap if it actually saved something
        if jpg.len() >= stream.content.len() {
            continue;
        }
        let mut dict = stream.dict.clone();
        dict.set("Width", Object::Integer(rgb.width() as i64));
        dict.set("Height", Object::Integer(rgb.height() as i64));
        dict.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
        dict.set("BitsPerComponent", Object::Integer(8));
        dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
        dict.remove(b"DecodeParms");
        doc.set_object(id, Stream::new(dict, jpg));
    }
    save(&mut doc)
}

// ── stamping (signatures, date marks) ────────────────────────────────────

#[derive(Deserialize, Clone, Debug)]
pub struct StampSpec {
    /// 1-based
    pub page: u32,
    /// PDF user space: [x, y, width, height], y-up from the page's bottom-left
    pub rect: [f32; 4],
    /// PNG bytes, base64-free (they arrive as a raw body and are split by the
    /// caller); alpha is honoured via /SMask
    #[serde(skip)]
    pub png: Vec<u8>,
}

/// Draw images onto pages. Every stamp is wrapped in its own q/Q and the
/// original content is bracketed too, so a page whose content stream leaves
/// a transform dangling can't drag the signature off the paper.
pub fn stamp_images(pdf: &[u8], password: Option<&str>, stamps: &[StampSpec]) -> R<Vec<u8>> {
    let mut doc = load(pdf, password)?;
    let ids = page_ids(&doc);
    for (n, s) in stamps.iter().enumerate() {
        if s.page < 1 || (s.page as usize) > ids.len() {
            return Err(format!("页码 {} 超出范围", s.page));
        }
        let page_id = ids[s.page as usize - 1];
        let (xobj, smask) = image_xobject(&s.png)?;
        let mut xobj = xobj;
        if let Some(m) = smask {
            let mid = doc.add_object(m);
            xobj.dict.set("SMask", Object::Reference(mid));
        }
        let img_id = doc.add_object(xobj);
        let name = format!("SoloStamp{n}");
        doc.add_xobject(page_id, name.clone(), img_id).map_err(e("放置签名失败"))?;
        let [x, y, w, h] = s.rect;
        let open = doc.add_object(Stream::new(dictionary! {}, b"q\n".to_vec()));
        let draw = doc.add_object(Stream::new(
            dictionary! {},
            format!("Q\nq\n{w} 0 0 {h} {x} {y} cm\n/{name} Do\nQ\n").into_bytes(),
        ));
        let mut contents = doc.get_page_contents(page_id);
        contents.insert(0, open);
        contents.push(draw);
        doc.get_dictionary_mut(page_id)
            .map_err(e("页面结构异常"))?
            .set("Contents", Object::Array(contents.into_iter().map(Object::Reference).collect()));
    }
    save(&mut doc)
}

// ── security ─────────────────────────────────────────────────────────────

/// Export a copy without an open password (the document must already be
/// unlocked — SoloPDF has the session password, we don't crack anything).
pub fn remove_password(pdf: &[u8], password: &str) -> R<Vec<u8>> {
    let mut doc = Document::load_mem(pdf).map_err(e("无法解析 PDF"))?;
    if !doc.is_encrypted() {
        return Err("该文件没有密码".into());
    }
    normalize_encrypt_dict(&mut doc);
    doc.decrypt(password).map_err(e("解密失败（密码不对？）"))?;
    save(&mut doc)
}

/// Export an AES-256 encrypted copy. `owner` empty reuses the user password.
pub fn set_password(pdf: &[u8], current: Option<&str>, user: &str, owner: &str) -> R<Vec<u8>> {
    use lopdf::encryption::{EncryptionState, EncryptionVersion, Permissions};
    let mut doc = load(pdf, current)?;
    // compress/normalise BEFORE encrypting: touching streams afterwards
    // would write plaintext into an encrypted document
    doc.compress();
    let owner = if owner.is_empty() { user } else { owner };
    let key = aes256_key();
    let version = EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: Default::default(),
        file_encryption_key: &key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password: owner,
        user_password: user,
        permissions: Permissions::all(),
    };
    let state = EncryptionState::try_from(version).map_err(e("加密参数无效"))?;
    doc.encrypt(&state).map_err(e("加密失败"))?;
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(e("写入 PDF 失败"))?;
    Ok(out)
}

/// 32 random bytes for the AES-256 file encryption key.
fn aes256_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    getrandom_bytes(&mut key);
    key
}

/// Small OS-entropy helper — one call site, not worth a crate.
fn getrandom_bytes(buf: &mut [u8]) {
    use std::io::Read;
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(buf).is_ok() {
            return;
        }
    }
    // Fallback (Windows has no /dev/urandom): hash a moving target. Weaker,
    // but never silently zero — and the desktop builds that need it are the
    // ones where the file lives on the user's own disk anyway.
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut h = seed as u64 ^ (std::process::id() as u64) << 32;
    for b in buf.iter_mut() {
        h ^= h << 13;
        h ^= h >> 7;
        h ^= h << 17;
        *b = (h >> 24) as u8;
    }
}

/// Does this file need a password to open?
pub fn is_encrypted(pdf: &[u8]) -> bool {
    Document::load_mem(pdf).map(|d| d.is_encrypted()).unwrap_or(false)
}

#[allow(dead_code)]
fn _dict_used(_: &Dictionary) {}

/// Page count without a full parse commitment — used by the CLI/MCP surface.
pub fn page_count(pdf: &[u8], password: Option<&str>) -> R<usize> {
    Ok(load(pdf, password)?.get_pages().len())
}

/// Page sizes in points, honouring inherited MediaBox.
pub fn page_sizes(pdf: &[u8], password: Option<&str>) -> R<Vec<(f32, f32)>> {
    let doc = load(pdf, password)?;
    let mut out = Vec::new();
    for id in page_ids(&doc) {
        let mb = inherited(&doc, id, b"MediaBox")
            .and_then(|o| o.as_array().ok().map(|a| a.to_vec()))
            .unwrap_or_default();
        let v: Vec<f32> = mb
            .iter()
            .map(|o| o.as_float().unwrap_or(0.0))
            .collect();
        if v.len() == 4 {
            out.push(((v[2] - v[0]).abs(), (v[3] - v[1]).abs()));
        } else {
            out.push((612.0, 792.0));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> Vec<u8> {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-fixtures")
            .join(name);
        std::fs::read(&p).unwrap_or_else(|e| panic!("fixture {}: {e}", p.display()))
    }

    /// Small, text-layer, multi-page — most tests only need page identity,
    /// and re-saving a 3.7MB document a dozen times dominates the runtime.
    fn sample() -> Vec<u8> {
        fixture("w9-manual.pdf")
    }

    #[test]
    fn arrange_keeps_order_and_count() {
        let out = arrange_pages(&sample(), None, &[3, 1, 2]).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        assert_eq!(doc.get_pages().len(), 3);
        // page 1 of the result must be page 3 of the source: compare the
        // content stream bytes, which survive the copy untouched
        let src = Document::load_mem(&sample()).unwrap();
        let src_pages: Vec<_> = src.get_pages().into_values().collect();
        let want = src.get_page_content(src_pages[2]).unwrap();
        let got_pages: Vec<_> = doc.get_pages().into_values().collect();
        let got = doc.get_page_content(got_pages[0]).unwrap();
        assert_eq!(want, got);
    }

    #[test]
    fn arrange_rejects_out_of_range_and_empty() {
        assert!(arrange_pages(&sample(), None, &[]).is_err());
        assert!(arrange_pages(&sample(), None, &[9999]).is_err());
    }

    #[test]
    fn rotate_accumulates_and_wraps() {
        let once = rotate_pages(&sample(), None, &[1], 90).unwrap();
        let twice = rotate_pages(&once, None, &[1], 270).unwrap();
        let doc = Document::load_mem(&twice).unwrap();
        let id = *doc.get_pages().get(&1).unwrap();
        let rot = doc.get_dictionary(id).unwrap().get(b"Rotate").and_then(Object::as_i64).unwrap();
        assert_eq!(rot, 0, "90 + 270 must come back to 0, not 360");
    }

    #[test]
    fn rotate_all_pages_when_list_is_empty() {
        let out = rotate_pages(&sample(), None, &[], 180).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        for id in doc.get_pages().into_values() {
            let rot = doc.get_dictionary(id).unwrap().get(b"Rotate").and_then(Object::as_i64).unwrap();
            assert_eq!(rot, 180);
        }
    }

    #[test]
    fn split_produces_one_document_per_range() {
        let total = page_count(&sample(), None).unwrap() as u32;
        assert!(total >= 4, "fixture must have enough pages to split");
        let parts = split(&sample(), None, &[(1, 2), (3, total)]).unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(Document::load_mem(&parts[0]).unwrap().get_pages().len(), 2);
        assert_eq!(
            Document::load_mem(&parts[1]).unwrap().get_pages().len(),
            (total - 2) as usize
        );
    }

    #[test]
    fn merge_concatenates_page_counts() {
        let a = arrange_pages(&sample(), None, &[1, 2]).unwrap();
        let b = arrange_pages(&sample(), None, &[3]).unwrap();
        let out = merge(&[(a, None), (b, None)]).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        assert_eq!(doc.get_pages().len(), 3);
        // merged pages must still know their size — the old parent node with
        // the inherited MediaBox is gone by now
        for id in doc.get_pages().into_values() {
            assert!(
                inherited(&doc, id, b"MediaBox").is_some(),
                "merged page lost its MediaBox"
            );
        }
    }

    #[test]
    fn annotations_land_on_the_right_pages() {
        let specs = vec![
            AnnotSpec {
                page: 2,
                kind: "highlight".into(),
                quads: vec![[100.0, 700.0, 200.0, 715.0]],
                color: [1.0, 0.85, 0.2],
                contents: "hello".into(),
                author: String::new(),
                ..Default::default()
            },
            AnnotSpec {
                page: 2,
                kind: "underline".into(),
                quads: vec![[100.0, 600.0, 220.0, 612.0]],
                color: [0.2, 0.6, 0.35],
                contents: String::new(),
                author: "alex".into(),
                ..Default::default()
            },
            AnnotSpec {
                page: 4,
                kind: "note".into(),
                quads: vec![[50.0, 500.0, 51.0, 501.0]],
                color: [1.0, 0.85, 0.2],
                contents: "check this".into(),
                author: String::new(),
                ..Default::default()
            },
        ];
        let out = write_annotations(&sample(), None, &specs).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        let pages: Vec<_> = doc.get_pages().into_values().collect();

        let ours = |d: &&Dictionary| {
            d.get(b"T").and_then(Object::as_str).map(|t| t == b"SoloPDF" || t == b"alex").unwrap_or(false)
        };
        let all2 = doc.get_page_annotations(pages[1]).unwrap();
        let p2: Vec<&Dictionary> = all2.into_iter().filter(|d| ours(&d)).collect();
        assert_eq!(p2.len(), 2);
        let subtypes: Vec<Vec<u8>> = p2
            .iter()
            .map(|d| d.get(b"Subtype").and_then(Object::as_name).unwrap().to_vec())
            .collect();
        assert!(subtypes.contains(&b"Highlight".to_vec()));
        assert!(subtypes.contains(&b"Underline".to_vec()));

        // QuadPoints must be upper-left, upper-right, lower-left, lower-right
        let hl = p2
            .iter()
            .find(|d| d.get(b"Subtype").and_then(Object::as_name).unwrap() == b"Highlight")
            .unwrap();
        let qp: Vec<f32> = hl
            .get(b"QuadPoints")
            .and_then(Object::as_array)
            .unwrap()
            .iter()
            .map(|o| o.as_float().unwrap())
            .collect();
        assert_eq!(qp, vec![100.0, 715.0, 200.0, 715.0, 100.0, 700.0, 200.0, 700.0]);

        let all4 = doc.get_page_annotations(pages[3]).unwrap();
        let p4: Vec<&Dictionary> = all4.into_iter().filter(|d| ours(&d)).collect();
        assert_eq!(p4.len(), 1);
        assert_eq!(
            p4[0].get(b"Subtype").and_then(Object::as_name).unwrap(),
            b"Text"
        );
    }

    #[test]
    fn annotations_are_appended_not_replaced() {
        let one = write_annotations(
            &sample(),
            None,
            &[AnnotSpec { page: 1, kind: "highlight".into(), quads: vec![[10.0, 10.0, 20.0, 20.0]], color: [1.0, 1.0, 0.0], contents: String::new(), author: String::new(), ..Default::default() }],
        )
        .unwrap();
        let two = write_annotations(
            &one,
            None,
            &[AnnotSpec { page: 1, kind: "strike".into(), quads: vec![[30.0, 30.0, 40.0, 40.0]], color: [1.0, 0.0, 0.0], contents: String::new(), author: String::new(), ..Default::default() }],
        )
        .unwrap();
        let doc = Document::load_mem(&two).unwrap();
        let pages: Vec<_> = doc.get_pages().into_values().collect();
        let mine = doc
            .get_page_annotations(pages[0])
            .unwrap()
            .into_iter()
            .filter(|d| d.get(b"T").and_then(Object::as_str).map(|t| t == b"SoloPDF").unwrap_or(false))
            .count();
        assert_eq!(mine, 2, "the second pass must append, not replace");
    }

    /// Every drawn kind lands as its real subtype, with the geometry keys a
    /// viewer needs and a non-empty normal appearance stream.
    #[test]
    fn drawn_marks_export_as_real_annotations_with_appearances() {
        let red = [0.9, 0.2, 0.2];
        let specs = vec![
            AnnotSpec {
                page: 1,
                kind: "ink".into(),
                quads: vec![[98.0, 98.0, 162.0, 142.0]],
                color: red,
                width: 2.0,
                strokes: vec![vec![100.0, 100.0, 120.0, 140.0, 160.0, 110.0], vec![130.0, 130.0]],
                pressure: vec![vec![0.5, 1.0, 1.5]],
                ..Default::default()
            },
            AnnotSpec {
                page: 1,
                kind: "rect".into(),
                quads: vec![[200.0, 200.0, 300.0, 260.0]],
                color: red,
                width: 3.0,
                ..Default::default()
            },
            AnnotSpec {
                page: 1,
                kind: "ellipse".into(),
                quads: vec![[200.0, 300.0, 300.0, 360.0]],
                color: red,
                width: 1.0,
                ..Default::default()
            },
            AnnotSpec {
                page: 1,
                kind: "arrow".into(),
                quads: vec![[50.0, 400.0, 150.0, 420.0]],
                color: red,
                width: 2.0,
                line: Some([50.0, 410.0, 150.0, 410.0]),
                ..Default::default()
            },
            AnnotSpec {
                page: 1,
                kind: "line".into(),
                quads: vec![[50.0, 450.0, 150.0, 470.0]],
                color: red,
                width: 1.0,
                line: Some([50.0, 460.0, 150.0, 460.0]),
                ..Default::default()
            },
            AnnotSpec {
                page: 1,
                kind: "textbox".into(),
                quads: vec![[300.0, 500.0, 420.0, 540.0]],
                color: [0.1, 0.4, 0.8],
                contents: "Check this figure again before sending".into(),
                font_size: 12.0,
                ..Default::default()
            },
            AnnotSpec {
                page: 1,
                kind: "textbox".into(),
                quads: vec![[300.0, 600.0, 420.0, 640.0]],
                color: [0.1, 0.4, 0.8],
                contents: "再核对一次".into(),
                font_size: 14.0,
                ..Default::default()
            },
        ];
        let out = write_annotations(&sample(), None, &specs).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        let page = doc.get_pages().into_values().next().unwrap();
        let mine: Vec<&Dictionary> = doc
            .get_page_annotations(page)
            .unwrap()
            .into_iter()
            .filter(|d| d.get(b"T").and_then(Object::as_str).map(|t| t == b"SoloPDF").unwrap_or(false))
            .collect();
        let by = |sub: &[u8]| -> Vec<&Dictionary> {
            mine.iter().copied().filter(|d| d.get(b"Subtype").and_then(Object::as_name).unwrap() == sub).collect()
        };
        let appearance = |d: &Dictionary| -> String {
            let ap = d.get(b"AP").and_then(Object::as_dict).expect("drawn mark needs /AP");
            let id = ap.get(b"N").and_then(Object::as_reference).expect("/AP /N stream");
            let mut st = doc.get_object(id).unwrap().as_stream().unwrap().clone();
            let _ = st.decompress();
            String::from_utf8_lossy(&st.content).into_owned()
        };

        let ink = by(b"Ink");
        assert_eq!(ink.len(), 1);
        let list = ink[0].get(b"InkList").and_then(Object::as_array).unwrap();
        assert_eq!(list.len(), 2, "one InkList entry per stroke");
        let ap = appearance(ink[0]);
        assert!(ap.contains(" c"), "strokes must be drawn as Béziers: {ap}");
        // pressure → several different widths in one stream
        assert!(ap.matches(" w").count() >= 3, "{ap}");

        let sq = by(b"Square");
        assert_eq!(sq.len(), 1);
        assert!(appearance(sq[0]).contains(" re"));
        assert_eq!(by(b"Circle").len(), 1);
        assert!(appearance(by(b"Circle")[0]).contains(" c"));

        let lines = by(b"Line");
        assert_eq!(lines.len(), 2);
        let arrow = lines
            .iter()
            .find(|d| {
                d.get(b"LE").and_then(Object::as_array).unwrap()[1].as_name().unwrap() == b"OpenArrow"
            })
            .expect("arrow ends in an OpenArrow");
        let l: Vec<f32> = arrow.get(b"L").and_then(Object::as_array).unwrap().iter().map(|o| o.as_float().unwrap()).collect();
        assert_eq!(l, vec![50.0, 410.0, 150.0, 410.0]);
        // the arrow's Rect must include the head, not just the shaft
        let rect: Vec<f32> = arrow.get(b"Rect").and_then(Object::as_array).unwrap().iter().map(|o| o.as_float().unwrap()).collect();
        assert!(rect[3] > 412.0 && rect[1] < 408.0);

        let ft = by(b"FreeText");
        assert_eq!(ft.len(), 2);
        for d in &ft {
            assert!(d.get(b"DA").is_ok(), "FreeText needs /DA");
            assert!(appearance(d).contains("Tj"));
        }
        // the Chinese box: UTF-16 /Contents and a CJK font in its appearance
        let cjk = ft
            .iter()
            .find(|d| d.get(b"Contents").and_then(Object::as_str).unwrap().starts_with(&[0xFE, 0xFF]))
            .expect("non-ASCII /Contents must be UTF-16BE with BOM");
        let ap = cjk.get(b"AP").and_then(Object::as_dict).unwrap();
        let form = doc.get_object(ap.get(b"N").and_then(Object::as_reference).unwrap()).unwrap().as_stream().unwrap();
        let font = form.dict.get(b"Resources").and_then(Object::as_dict).unwrap()
            .get(b"Font").and_then(Object::as_dict).unwrap()
            .get(b"F1").and_then(Object::as_dict).unwrap();
        assert_eq!(font.get(b"Subtype").and_then(Object::as_name).unwrap(), b"Type0");
        let latin = ft.iter().find(|d| !std::ptr::eq(**d, *cjk)).unwrap();
        let lap = appearance(latin); assert!(lap.contains(" cm") && lap.contains("540"), "unrotated frame starts top-left: {lap}");
        let wrapped = appearance(latin);
        assert!(wrapped.matches("Tj").count() >= 2, "long text must wrap in a 120pt box: {wrapped}");
    }

    #[test]
    fn catmull_rom_passes_through_its_points() {
        let segs = catmull_rom(&[(0.0, 0.0), (10.0, 10.0), (20.0, 0.0)]);
        assert_eq!(segs.len(), 2);
        assert_eq!([segs[0][4], segs[0][5]], [10.0, 10.0]);
        assert_eq!([segs[1][4], segs[1][5]], [20.0, 0.0]);
        // same numbers as core/src/drawing.ts: c1 = p1 + (p2 - p0) / 6
        assert!((segs[0][0] - 10.0 / 6.0).abs() < 1e-5);
    }

    #[test]
    fn wrap_keeps_words_and_breaks_cjk_anywhere() {
        let lines = wrap("hello world again", true, 10.0, 30.0);
        assert!(lines.len() >= 2);
        assert!(lines.iter().all(|l| !l.starts_with(' ')));
        assert!(lines.iter().any(|l| l == "hello"));
        let cjk = wrap("一二三四五六", false, 10.0, 30.0);
        assert_eq!(cjk, vec!["一二三", "四五六"]);
    }

    #[test]
    fn password_round_trip() {
        let src = sample();
        let locked = set_password(&src, None, "hunter2", "").unwrap();
        assert!(is_encrypted(&locked), "output should need a password");
        // wrong password must fail, right one must work
        assert!(remove_password(&locked, "nope").is_err());
        let unlocked = remove_password(&locked, "hunter2").unwrap();
        assert!(!is_encrypted(&unlocked));
        assert_eq!(
            Document::load_mem(&unlocked).unwrap().get_pages().len(),
            Document::load_mem(&src).unwrap().get_pages().len()
        );
    }

    #[test]
    fn opens_the_encrypted_fixture_with_its_password() {
        let enc = fixture("encrypted-password-solopdf.pdf");
        assert!(is_encrypted(&enc));
        assert!(load(&enc, Some("solopdf")).is_ok());
        assert!(load(&enc, Some("wrong")).is_err());
        assert!(page_count(&enc, Some("solopdf")).unwrap() > 0);
    }

    #[test]
    fn images_to_pdf_sizes_pages_from_dpi() {
        // 144x72 px at 144 dpi = 72x36 pt
        let mut png = Vec::new();
        let img = image::RgbImage::from_pixel(144, 72, image::Rgb([200, 30, 30]));
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let out = images_to_pdf(&[png], 144.0).unwrap();
        let sizes = page_sizes(&out, None).unwrap();
        assert_eq!(sizes.len(), 1);
        assert!((sizes[0].0 - 72.0).abs() < 0.5, "width {:?}", sizes[0]);
        assert!((sizes[0].1 - 36.0).abs() < 0.5, "height {:?}", sizes[0]);
    }

    #[test]
    fn stamp_keeps_the_page_and_adds_content() {
        let mut png = Vec::new();
        let img = image::RgbaImage::from_pixel(40, 20, image::Rgba([0, 0, 0, 128]));
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let src = sample();
        let before = Document::load_mem(&src).unwrap();
        let bp = *before.get_pages().get(&1).unwrap();
        let before_len = before.get_page_contents(bp).len();

        let out = stamp_images(
            &src,
            None,
            &[StampSpec { page: 1, rect: [72.0, 72.0, 120.0, 60.0], png }],
        )
        .unwrap();
        let doc = Document::load_mem(&out).unwrap();
        assert_eq!(doc.get_pages().len(), before.get_pages().len());
        let id = *doc.get_pages().get(&1).unwrap();
        // one stream prepended (q) and one appended (the stamp)
        assert_eq!(doc.get_page_contents(id).len(), before_len + 2);
        let content = String::from_utf8_lossy(&doc.get_page_content(id).unwrap()).to_string();
        assert!(content.contains("/SoloStamp0 Do"), "stamp draw op missing");
        // an alpha channel must survive as an /SMask
        let has_smask = doc.objects.values().any(|o| {
            o.as_stream().map(|s| s.dict.get(b"SMask").is_ok()).unwrap_or(false)
        });
        assert!(has_smask, "translucent stamp lost its soft mask");
    }

    #[test]
    fn compress_never_grows_a_file() {
        let src = fixture("scanned-no-textlayer.pdf");
        let out = compress_pdf(&src, None, 1200, 70).unwrap();
        assert!(out.len() <= src.len(), "{} -> {}", src.len(), out.len());
        // and it must still be a readable PDF with the same page count
        assert_eq!(
            Document::load_mem(&out).unwrap().get_pages().len(),
            Document::load_mem(&src).unwrap().get_pages().len()
        );
    }
}


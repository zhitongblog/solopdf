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
use serde::{Deserialize, Serialize};

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

/// Keep exactly `order` (1-based page numbers, or `0` for an inserted blank
/// page), in that order.
/// One primitive covers delete, extract, reorder, duplicate and blank-page
/// insertion — they are all "which pages, in what sequence".
pub fn arrange_pages(pdf: &[u8], password: Option<&str>, order: &[u32]) -> R<Vec<u8>> {
    if order.is_empty() {
        return Err("至少要保留一页".into());
    }
    let mut doc = load(pdf, password)?;
    let ids = page_ids(&doc);
    for p in order {
        if (*p as usize) > ids.len() {
            return Err(format!("页码 {p} 超出范围"));
        }
    }
    let pages_id = doc
        .catalog()
        .and_then(|c| c.get(b"Pages"))
        .and_then(Object::as_reference)
        .map_err(e("找不到页面树"))?;

    // Copy down inherited attributes before flattening the page tree
    for &id in &ids {
        for key in [&b"MediaBox"[..], b"Resources", b"Rotate", b"CropBox"] {
            if doc.get_dictionary(id).map(|d| d.has(key)).unwrap_or(false) {
                continue;
            }
            if let Some(v) = inherited(&doc, id, key) {
                if let Ok(d) = doc.get_dictionary_mut(id) {
                    d.set(key.to_vec(), v);
                }
            }
        }
    }

    let mut seen = std::collections::HashSet::new();
    let mut keep: Vec<ObjectId> = Vec::with_capacity(order.len());
    for (idx, &p) in order.iter().enumerate() {
        if p == 0 {
            // Blank page: inherit MediaBox and Rotate from nearest neighbor
            let ref_src = order[..idx]
                .iter()
                .rev()
                .chain(order[idx + 1..].iter())
                .find(|&&x| x >= 1)
                .map(|&x| ids[x as usize - 1])
                .or_else(|| ids.first().copied());
            let mb = ref_src
                .and_then(|id| doc.get_dictionary(id).ok())
                .and_then(|d| d.get(b"MediaBox").ok().cloned())
                .unwrap_or_else(|| nums(&[0.0, 0.0, 595.28, 841.89]));
            let rot = ref_src
                .and_then(|id| doc.get_dictionary(id).ok())
                .and_then(|d| d.get(b"Rotate").ok().cloned())
                .unwrap_or(Object::Integer(0));
            let empty_stream = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
            let blank_id = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => mb,
                "Rotate" => rot,
                "Contents" => empty_stream,
                "Resources" => dictionary! {},
            });
            keep.push(blank_id);
        } else {
            let orig_id = ids[p as usize - 1];
            if seen.insert(orig_id) {
                if let Ok(d) = doc.get_dictionary_mut(orig_id) {
                    d.set("Parent", Object::Reference(pages_id));
                }
                keep.push(orig_id);
            } else {
                // Duplicate page: clone dictionary into a distinct ObjectId so
                // /Kids never holds two references to the same page object
                let mut cloned = doc
                    .get_dictionary(orig_id)
                    .map_err(e("页面结构异常"))?
                    .clone();
                cloned.set("Parent", Object::Reference(pages_id));
                let dup_id = doc.add_object(Object::Dictionary(cloned));
                keep.push(dup_id);
            }
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
        let [x1, y1, x2, y2] = page_box(&doc, id);
        out.push(((x2 - x1).abs(), (y2 - y1).abs()));
    }
    Ok(out)
}

/// Effective visible box of a page (`CropBox` if present, else `MediaBox`),
/// normalized to `[x_min, y_min, x_max, y_max]`.
fn page_box(doc: &Document, page_id: ObjectId) -> [f32; 4] {
    for key in [&b"CropBox"[..], b"MediaBox"] {
        if let Some(arr) = inherited(doc, page_id, key).and_then(|o| o.as_array().ok().cloned()) {
            let v: Vec<f32> = arr
                .iter()
                .map(|o| o.as_float().unwrap_or_else(|_| o.as_i64().unwrap_or(0) as f32))
                .collect();
            if v.len() == 4 {
                return [v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])];
            }
        }
    }
    [0.0, 0.0, 612.0, 792.0]
}

// ── crop pages ───────────────────────────────────────────────────────────

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub struct CropSpec {
    /// Inset margins `[top, right, bottom, left]` in PDF points
    #[serde(default)]
    pub margins: [f32; 4],
    /// Optional separate margins for odd pages (1, 3, 5…)
    #[serde(default)]
    pub odd_margins: Option<[f32; 4]>,
    /// Optional separate margins for even pages (2, 4, 6…)
    #[serde(default)]
    pub even_margins: Option<[f32; 4]>,
    /// Optional explicit `[x1, y1, x2, y2]` box in PDF points
    #[serde(default)]
    pub box_rect: Option<[f32; 4]>,
    /// Optional per-page explicit `[x1, y1, x2, y2]` boxes (e.g. auto-crop)
    #[serde(default)]
    pub per_page: Vec<(u32, [f32; 4])>,
    /// 1-based target pages; empty = every page
    #[serde(default)]
    pub pages: Vec<u32>,
}

/// Permanently crop pages by updating both `/CropBox` and `/MediaBox`.
pub fn crop_pages(pdf: &[u8], password: Option<&str>, spec: &CropSpec) -> R<Vec<u8>> {
    let mut doc = load(pdf, password)?;
    let ids = page_ids(&doc);
    let per_map: std::collections::HashMap<u32, [f32; 4]> =
        spec.per_page.iter().copied().collect();
    let targets: Vec<u32> = if !per_map.is_empty() {
        per_map.keys().copied().collect()
    } else if spec.pages.is_empty() {
        (1..=ids.len() as u32).collect()
    } else {
        spec.pages
            .iter()
            .copied()
            .filter(|&p| p >= 1 && (p as usize) <= ids.len())
            .collect()
    };
    if targets.is_empty() {
        return Err("没有匹配的页码".into());
    }
    for p in targets {
        let page_id = ids[p as usize - 1];
        let [bx1, by1, bx2, by2] = page_box(&doc, page_id);
        let [mut nx1, mut ny1, mut nx2, mut ny2] = if let Some(&r) = per_map.get(&p) {
            [r[0].min(r[2]), r[1].min(r[3]), r[0].max(r[2]), r[1].max(r[3])]
        } else if let Some(r) = spec.box_rect {
            [r[0].min(r[2]), r[1].min(r[3]), r[0].max(r[2]), r[1].max(r[3])]
        } else {
            let [top, right, bottom, left] = if p % 2 == 1 {
                spec.odd_margins.unwrap_or(spec.margins)
            } else {
                spec.even_margins.unwrap_or(spec.margins)
            };
            [bx1 + left, by1 + bottom, bx2 - right, by2 - top]
        };
        // Clamp inside original box and ensure at least 36x36 pt remains
        nx1 = nx1.clamp(bx1, (bx2 - 36.0).max(bx1));
        ny1 = ny1.clamp(by1, (by2 - 36.0).max(by1));
        nx2 = nx2.clamp((nx1 + 36.0).min(bx2), bx2);
        ny2 = ny2.clamp((ny1 + 36.0).min(by2), by2);
        let d = doc.get_dictionary_mut(page_id).map_err(e("页面结构异常"))?;
        d.set("MediaBox", nums(&[nx1, ny1, nx2, ny2]));
        d.set("CropBox", nums(&[nx1, ny1, nx2, ny2]));
    }
    save(&mut doc)
}

// ── watermark & page numbers ─────────────────────────────────────────────

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct WatermarkSpec {
    #[serde(default)]
    pub text: String,
    #[serde(skip)]
    pub image_png: Vec<u8>,
    #[serde(default = "default_wm_font_size")]
    pub font_size: f32,
    #[serde(default = "default_wm_color")]
    pub color: [f32; 3],
    #[serde(default = "default_wm_opacity")]
    pub opacity: f32,
    #[serde(default = "default_wm_rotate")]
    pub rotate: f32,
    /// center | tile | top-left | top-center | top-right |
    /// middle-left | middle-right | bottom-left | bottom-center | bottom-right
    #[serde(default = "default_wm_pos")]
    pub position: String,
    #[serde(default = "default_wm_spacing")]
    pub tile_spacing: f32,
    #[serde(default = "default_wm_scale")]
    pub scale: f32,
    #[serde(default)]
    pub under: bool,
    #[serde(default)]
    pub pages: Vec<u32>,
}

fn default_wm_font_size() -> f32 { 48.0 }
fn default_wm_color() -> [f32; 3] { [0.55, 0.55, 0.55] }
fn default_wm_opacity() -> f32 { 0.22 }
fn default_wm_rotate() -> f32 { 45.0 }
fn default_wm_pos() -> String { "center".into() }
fn default_wm_spacing() -> f32 { 180.0 }
fn default_wm_scale() -> f32 { 0.3 }

impl Default for WatermarkSpec {
    fn default() -> Self {
        Self {
            text: String::new(),
            image_png: Vec::new(),
            font_size: default_wm_font_size(),
            color: default_wm_color(),
            opacity: default_wm_opacity(),
            rotate: default_wm_rotate(),
            position: default_wm_pos(),
            tile_spacing: default_wm_spacing(),
            scale: default_wm_scale(),
            under: false,
            pages: Vec::new(),
        }
    }
}

fn text_advance(text: &str, latin_font: bool, fs: f32) -> f32 {
    text.chars().map(|c| char_width(c, latin_font, fs)).sum()
}

fn anchor_coords(box_rect: [f32; 4], pos: &str, item_w: f32, item_h: f32, margin: f32) -> (f32, f32) {
    let [x1, y1, x2, y2] = box_rect;
    let (w, h) = (x2 - x1, y2 - y1);
    let cx = match pos {
        "top-left" | "middle-left" | "bottom-left" => x1 + margin + item_w / 2.0,
        "top-right" | "middle-right" | "bottom-right" => x2 - margin - item_w / 2.0,
        _ => x1 + w / 2.0,
    };
    let cy = match pos {
        "top-left" | "top-center" | "top-right" => y2 - margin - item_h / 2.0,
        "bottom-left" | "bottom-center" | "bottom-right" => y1 + margin + item_h / 2.0,
        _ => y1 + h / 2.0,
    };
    (cx, cy)
}

/// Attach a Form XObject to `page_id` and draw it either under or over existing page contents.
fn attach_form_layer(
    doc: &mut Document,
    page_id: ObjectId,
    name: &str,
    form_id: ObjectId,
    under: bool,
) -> R<()> {
    doc.add_xobject(page_id, name.to_string(), form_id)
        .map_err(e("写入图层资源失败"))?;
    let mut contents = doc.get_page_contents(page_id);
    if under {
        let pre = doc.add_object(Stream::new(
            dictionary! {},
            format!("q\n/{name} Do\nQ\nq\n").into_bytes(),
        ));
        let post = doc.add_object(Stream::new(dictionary! {}, b"Q\n".to_vec()));
        contents.insert(0, pre);
        contents.push(post);
    } else {
        let pre = doc.add_object(Stream::new(dictionary! {}, b"q\n".to_vec()));
        let post = doc.add_object(Stream::new(
            dictionary! {},
            format!("Q\nq\n/{name} Do\nQ\n").into_bytes(),
        ));
        contents.insert(0, pre);
        contents.push(post);
    }
    doc.get_dictionary_mut(page_id)
        .map_err(e("页面结构异常"))?
        .set("Contents", Object::Array(contents.into_iter().map(Object::Reference).collect()));
    Ok(())
}

/// Stamp a text or image watermark onto target pages.
pub fn watermark_pdf(pdf: &[u8], password: Option<&str>, spec: &WatermarkSpec) -> R<Vec<u8>> {
    let is_img = !spec.image_png.is_empty();
    if !is_img && spec.text.trim().is_empty() {
        return Err("水印内容不能为空".into());
    }
    let mut doc = load(pdf, password)?;
    let ids = page_ids(&doc);
    let targets: Vec<usize> = if spec.pages.is_empty() {
        (0..ids.len()).collect()
    } else {
        spec.pages
            .iter()
            .filter(|&&p| p >= 1 && (p as usize) <= ids.len())
            .map(|&p| p as usize - 1)
            .collect()
    };
    if targets.is_empty() {
        return Err("没有匹配的页码".into());
    }

    let opacity = spec.opacity.clamp(0.02, 1.0);
    let rad = spec.rotate.to_radians();
    let (cos_a, sin_a) = (rad.cos(), rad.sin());

    // Pre-build image XObject once if this is an image watermark
    let img_entry = if is_img {
        let dims = image::load_from_memory(&spec.image_png).map_err(e("水印图片解码失败"))?;
        let (iw, ih) = (dims.width().max(1) as f32, dims.height().max(1) as f32);
        let (mut xobj, smask) = image_xobject(&spec.image_png)?;
        if let Some(m) = smask {
            let mid = doc.add_object(m);
            xobj.dict.set("SMask", Object::Reference(mid));
        }
        let img_id = doc.add_object(xobj);
        Some((img_id, iw, ih))
    } else {
        None
    };

    for (idx, &page_idx) in targets.iter().enumerate() {
        let page_id = ids[page_idx];
        let b = page_box(&doc, page_id);
        let (pw, _ph) = ((b[2] - b[0]).max(1.0), (b[3] - b[1]).max(1.0));
        let mut ops: Vec<Operation> = vec![
            op("q", &[]),
            Operation::new("gs", vec![Object::Name(b"GS1".to_vec())]),
        ];
        let mut res = dictionary! {
            "ExtGState" => dictionary! {
                "GS1" => dictionary! {
                    "Type" => "ExtGState",
                    "ca" => Object::Real(opacity),
                    "CA" => Object::Real(opacity),
                }
            }
        };

        if let Some((img_id, iw, ih)) = img_entry {
            let scale = spec.scale.clamp(0.05, 1.0);
            let draw_w = pw * scale;
            let draw_h = draw_w * (ih / iw);
            res.set("XObject", Object::Dictionary(dictionary! { "WmImg" => img_id }));
            let centers: Vec<(f32, f32)> = if spec.position == "tile" {
                let step_x = (draw_w + spec.tile_spacing.max(40.0)).max(80.0);
                let step_y = (draw_h + spec.tile_spacing.max(40.0)).max(80.0);
                let mut pts = Vec::new();
                let mut y = b[1] + step_y * 0.5;
                while y < b[3] + step_y * 0.5 {
                    let mut x = b[0] + step_x * 0.5;
                    while x < b[2] + step_x * 0.5 {
                        pts.push((x, y));
                        x += step_x;
                    }
                    y += step_y;
                }
                pts
            } else {
                vec![anchor_coords(b, &spec.position, draw_w, draw_h, 36.0)]
            };
            for (cx, cy) in centers {
                ops.push(op("q", &[]));
                ops.push(op("cm", &[1.0, 0.0, 0.0, 1.0, cx, cy]));
                ops.push(op("cm", &[cos_a, sin_a, -sin_a, cos_a, 0.0, 0.0]));
                ops.push(op("cm", &[draw_w, 0.0, 0.0, draw_h, -draw_w / 2.0, -draw_h / 2.0]));
                ops.push(Operation::new("Do", vec![Object::Name(b"WmImg".to_vec())]));
                ops.push(op("Q", &[]));
            }
        } else {
            let fs = spec.font_size.clamp(8.0, 240.0);
            let text = spec.text.trim();
            let latin_font = text.chars().all(is_latin);
            let tw = text_advance(text, latin_font, fs);
            let th = fs;
            let [r, g, bl] = spec.color;
            res.set("Font", Object::Dictionary(dictionary! { "F1" => text_font(latin_font) }));
            let centers: Vec<(f32, f32)> = if spec.position == "tile" {
                let step_x = (tw + spec.tile_spacing.max(60.0)).max(120.0);
                let step_y = (th + spec.tile_spacing.max(60.0)).max(100.0);
                let mut pts = Vec::new();
                let mut row = 0i32;
                let mut y = b[1] - step_y * 0.5;
                while y <= b[3] + step_y {
                    let offset = if row % 2 != 0 { step_x * 0.5 } else { 0.0 };
                    let mut x = b[0] - step_x * 0.5 + offset;
                    while x <= b[2] + step_x {
                        pts.push((x, y));
                        x += step_x;
                    }
                    y += step_y;
                    row += 1;
                }
                pts
            } else {
                vec![anchor_coords(b, &spec.position, tw, th, 36.0)]
            };
            let encoded = text_bytes(text, latin_font);
            for (cx, cy) in centers {
                ops.push(op("q", &[]));
                ops.push(op("cm", &[cos_a, sin_a, -sin_a, cos_a, cx, cy]));
                ops.push(op("BT", &[]));
                ops.push(Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), Object::Real(fs)]));
                ops.push(op("rg", &[r, g, bl]));
                ops.push(op("Td", &[-tw / 2.0, -fs * 0.35]));
                ops.push(Operation::new("Tj", vec![encoded.clone()]));
                ops.push(op("ET", &[]));
                ops.push(op("Q", &[]));
            }
        }
        ops.push(op("Q", &[]));
        let content = Content { operations: ops }.encode().unwrap_or_default();
        let form = dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => nums(&b),
            "Resources" => res,
        };
        let form_id = doc.add_object(Stream::new(form, content));
        attach_form_layer(&mut doc, page_id, &format!("SoloWm{idx}"), form_id, spec.under)?;
    }
    save(&mut doc)
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct PageNumberSpec {
    /// Format template: `{n}`, `{n} / {total}`, `第 {n} 页`, `DOC-{n:06}` (Bates)
    #[serde(default = "default_pn_format")]
    pub format: String,
    /// bottom-center | bottom-left | bottom-right | top-center | top-left |
    /// top-right | bottom-outside | top-outside | bottom-inside | top-inside
    #[serde(default = "default_pn_pos")]
    pub position: String,
    #[serde(default = "default_pn_one")]
    pub start_number: u32,
    #[serde(default = "default_pn_one")]
    pub from_page: u32,
    /// 0 = through the last page
    #[serde(default)]
    pub to_page: u32,
    #[serde(default = "default_pn_fs")]
    pub font_size: f32,
    #[serde(default = "default_pn_margin")]
    pub margin: f32,
    #[serde(default = "default_pn_color")]
    pub color: [f32; 3],
}

fn default_pn_format() -> String { "{n}".into() }
fn default_pn_pos() -> String { "bottom-center".into() }
fn default_pn_one() -> u32 { 1 }
fn default_pn_fs() -> f32 { 10.0 }
fn default_pn_margin() -> f32 { 28.0 }
fn default_pn_color() -> [f32; 3] { [0.25, 0.25, 0.25] }

impl Default for PageNumberSpec {
    fn default() -> Self {
        Self {
            format: default_pn_format(),
            position: default_pn_pos(),
            start_number: 1,
            from_page: 1,
            to_page: 0,
            font_size: 10.0,
            margin: 28.0,
            color: default_pn_color(),
        }
    }
}

/// Format a page number or Bates label from a template string.
pub fn format_page_number(tpl: &str, n: u32, total: u32, page: u32, pages: u32) -> String {
    let mut s = tpl
        .replace("{n}", &n.to_string())
        .replace("{total}", &total.to_string())
        .replace("{page}", &page.to_string())
        .replace("{pages}", &pages.to_string());
    // Support Bates zero-padding `{n:03}` .. `{n:09}`
    for width in 2..=9usize {
        let token = format!("{{n:0{width}}}");
        if s.contains(&token) {
            s = s.replace(&token, &format!("{n:0>width$}", width = width));
        }
    }
    s
}

/// Stamp page numbers (or headers/footers/Bates numbers) onto pages.
pub fn add_page_numbers(pdf: &[u8], password: Option<&str>, spec: &PageNumberSpec) -> R<Vec<u8>> {
    let mut doc = load(pdf, password)?;
    let ids = page_ids(&doc);
    let total_pages = ids.len() as u32;
    if total_pages == 0 {
        return Err("PDF 没有页面".into());
    }
    let from = spec.from_page.max(1).min(total_pages);
    let to = if spec.to_page == 0 {
        total_pages
    } else {
        spec.to_page.max(from).min(total_pages)
    };
    let count = to - from + 1;
    let fs = spec.font_size.clamp(6.0, 72.0);
    let margin = spec.margin.clamp(6.0, 200.0);
    let [r, g, bl] = spec.color;
    let tpl = if spec.format.trim().is_empty() { "{n}" } else { spec.format.as_str() };

    for p in from..=to {
        let n = spec.start_number + (p - from);
        let label = format_page_number(tpl, n, count, p, total_pages);
        let latin_font = label.chars().all(is_latin);
        let tw = text_advance(&label, latin_font, fs);
        let page_id = ids[p as usize - 1];
        let b = page_box(&doc, page_id);
        let resolved_pos = match spec.position.as_str() {
            "bottom-outside" => if p % 2 == 1 { "bottom-right" } else { "bottom-left" },
            "bottom-inside" => if p % 2 == 1 { "bottom-left" } else { "bottom-right" },
            "top-outside" => if p % 2 == 1 { "top-right" } else { "top-left" },
            "top-inside" => if p % 2 == 1 { "top-left" } else { "top-right" },
            other => other,
        };
        let (cx, cy) = anchor_coords(b, resolved_pos, tw, fs, margin);
        let ops = vec![
            op("q", &[]),
            op("BT", &[]),
            Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), Object::Real(fs)]),
            op("rg", &[r, g, bl]),
            op("Td", &[cx - tw / 2.0, cy - fs * 0.35]),
            Operation::new("Tj", vec![text_bytes(&label, latin_font)]),
            op("ET", &[]),
            op("Q", &[]),
        ];
        let content = Content { operations: ops }.encode().unwrap_or_default();
        let form = dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => nums(&b),
            "Resources" => dictionary! {
                "Font" => dictionary! { "F1" => text_font(latin_font) }
            },
        };
        let form_id = doc.add_object(Stream::new(form, content));
        attach_form_layer(&mut doc, page_id, &format!("SoloPn{p}"), form_id, false)?;
    }
    save(&mut doc)
}

// ── extract embedded images ──────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct ExtractedImage {
    /// 1-based page where the image first appears
    pub page: u32,
    /// 1-based index across the document
    pub index: u32,
    pub width: u32,
    pub height: u32,
    /// "jpeg" | "png"
    pub format: String,
    /// "jpg" | "png"
    pub ext: String,
    #[serde(skip)]
    pub bytes: Vec<u8>,
}

/// Extract embedded image XObjects from a PDF without lossy re-encoding.
/// `min_dim` skips tiny spacer/decor images smaller than `min_dim` px.
pub fn extract_images(pdf: &[u8], password: Option<&str>, min_dim: u32) -> R<Vec<ExtractedImage>> {
    let doc = load(pdf, password)?;
    let ids = page_ids(&doc);
    let mut visited = std::collections::HashSet::new();
    let mut out = Vec::new();

    for (pi, &page_id) in ids.iter().enumerate() {
        let page_no = (pi + 1) as u32;
        let Some(res_obj) = inherited(&doc, page_id, b"Resources") else { continue };
        let mut queue = vec![res_obj];
        while let Some(r_obj) = queue.pop() {
            let res_dict = match r_obj {
                Object::Dictionary(d) => d,
                Object::Reference(id) => match doc.get_dictionary(id) {
                    Ok(d) => d.clone(),
                    Err(_) => continue,
                },
                _ => continue,
            };
            let Ok(xobj_entry) = res_dict.get(b"XObject") else { continue };
            let xobj_dict = match xobj_entry {
                Object::Dictionary(d) => d.clone(),
                Object::Reference(id) => match doc.get_dictionary(*id) {
                    Ok(d) => d.clone(),
                    Err(_) => continue,
                },
                _ => continue,
            };
            for (_, val) in xobj_dict.iter() {
                let Object::Reference(xid) = val else { continue };
                if !visited.insert(*xid) {
                    continue;
                }
                let Ok(stream) = doc.get_object(*xid).and_then(|o| o.as_stream()) else { continue };
                let subtype = stream.dict.get(b"Subtype").and_then(Object::as_name).unwrap_or(b"");
                if subtype == b"Form" {
                    if let Ok(sub_res) = stream.dict.get(b"Resources") {
                        queue.push(sub_res.clone());
                    }
                    continue;
                }
                if subtype != b"Image" {
                    continue;
                }
                let w = stream.dict.get(b"Width").and_then(Object::as_i64).unwrap_or(0) as u32;
                let h = stream.dict.get(b"Height").and_then(Object::as_i64).unwrap_or(0) as u32;
                if w < min_dim || h < min_dim || w == 0 || h == 0 {
                    continue;
                }
                if let Some((fmt, ext, bytes)) = decode_pdf_image(&doc, stream, w, h) {
                    let index = (out.len() + 1) as u32;
                    out.push(ExtractedImage {
                        page: page_no,
                        index,
                        width: w,
                        height: h,
                        format: fmt.into(),
                        ext: ext.into(),
                        bytes,
                    });
                }
            }
        }
    }
    Ok(out)
}

fn decode_pdf_image(
    doc: &Document,
    stream: &Stream,
    w: u32,
    h: u32,
) -> Option<(&'static str, &'static str, Vec<u8>)> {
    let filters = stream.filters().unwrap_or_default();
    let is_jpeg = filters.iter().any(|f| *f == b"DCTDecode");
    let smask_stream = stream
        .dict
        .get(b"SMask")
        .and_then(Object::as_reference)
        .and_then(|id| doc.get_object(id))
        .and_then(|o| o.as_stream())
        .ok();

    // Direct lossless JPEG passthrough when there is no soft mask
    if is_jpeg && smask_stream.is_none() {
        return Some(("jpeg", "jpg", stream.content.clone()));
    }

    let dyn_img = if is_jpeg {
        image::load_from_memory(&stream.content).ok()?
    } else {
        let bpc = stream.dict.get(b"BitsPerComponent").and_then(Object::as_i64).unwrap_or(8);
        if bpc != 8 {
            return None;
        }
        let cs = stream.dict.get(b"ColorSpace").and_then(Object::as_name).unwrap_or(b"DeviceRGB");
        let raw = stream.decompressed_content().ok()?;
        if cs == b"DeviceGray" {
            let need = (w * h) as usize;
            if raw.len() < need {
                return None;
            }
            image::DynamicImage::ImageLuma8(image::GrayImage::from_raw(w, h, raw[..need].to_vec())?)
        } else if cs == b"DeviceRGB" {
            let need = (w * h * 3) as usize;
            if raw.len() < need {
                return None;
            }
            image::DynamicImage::ImageRgb8(image::RgbImage::from_raw(w, h, raw[..need].to_vec())?)
        } else {
            return None;
        }
    };

    let mut png_bytes = Vec::new();
    if let Some(sm) = smask_stream {
        if let Ok(alpha) = sm.decompressed_content() {
            if alpha.len() >= (w * h) as usize {
                let mut rgba = dyn_img.to_rgba8();
                for (i, p) in rgba.pixels_mut().enumerate() {
                    p.0[3] = alpha[i];
                }
                image::DynamicImage::ImageRgba8(rgba)
                    .write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
                    .ok()?;
                return Some(("png", "png", png_bytes));
            }
        }
    }
    dyn_img
        .write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .ok()?;
    Some(("png", "png", png_bytes))
}

// ── sanitize / flatten / redact ──────────────────────────────────────────

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct SanitizeSpec {
    #[serde(default = "default_true")]
    pub metadata: bool,
    #[serde(default)]
    pub annotations: bool,
    #[serde(default)]
    pub attachments: bool,
    #[serde(default = "default_true")]
    pub javascript_actions: bool,
    #[serde(default)]
    pub forms: bool,
}

fn default_true() -> bool { true }

impl Default for SanitizeSpec {
    fn default() -> Self {
        Self {
            metadata: true,
            annotations: false,
            attachments: false,
            javascript_actions: true,
            forms: false,
        }
    }
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct SanitizeReport {
    pub removed_metadata: bool,
    pub removed_annotations: usize,
    pub removed_attachments: bool,
    pub removed_actions: usize,
    pub removed_forms: bool,
}

/// Strip metadata, XMP streams, scripts, annotations, attachments or forms.
pub fn sanitize_pdf(
    pdf: &[u8],
    password: Option<&str>,
    spec: &SanitizeSpec,
) -> R<(Vec<u8>, SanitizeReport)> {
    let mut doc = load(pdf, password)?;
    let mut report = SanitizeReport::default();

    if spec.metadata {
        if doc.trailer.remove(b"Info").is_some() {
            report.removed_metadata = true;
        }
        let all_ids: Vec<ObjectId> = doc.objects.keys().copied().collect();
        for id in all_ids {
            if let Ok(Object::Dictionary(d)) = doc.get_object_mut(id) {
                for key in [&b"Metadata"[..], b"PieceInfo", b"SpiderInfo", b"StructTreeRoot", b"MarkInfo"] {
                    if d.remove(key).is_some() {
                        report.removed_metadata = true;
                    }
                }
            }
        }
    }

    if spec.javascript_actions {
        let all_ids: Vec<ObjectId> = doc.objects.keys().copied().collect();
        for id in all_ids {
            if let Ok(Object::Dictionary(d)) = doc.get_object_mut(id) {
                for key in [&b"OpenAction"[..], b"AA", b"JS", b"JavaScript", b"Launch"] {
                    if d.remove(key).is_some() {
                        report.removed_actions += 1;
                    }
                }
            }
        }
        if let Ok(cat) = doc.catalog_mut() {
            if let Ok(Object::Dictionary(names)) = cat.get_mut(b"Names") {
                if names.remove(b"JavaScript").is_some() {
                    report.removed_actions += 1;
                }
            }
        }
    }

    if spec.attachments {
        if let Ok(cat) = doc.catalog_mut() {
            if cat.remove(b"AF").is_some() {
                report.removed_attachments = true;
            }
            if let Ok( names_ref ) = cat.get(b"Names").cloned() {
                match names_ref {
                    Object::Dictionary(mut nd) => {
                        if nd.remove(b"EmbeddedFiles").is_some() {
                            report.removed_attachments = true;
                        }
                        cat.set("Names", Object::Dictionary(nd));
                    }
                    Object::Reference(nid) => {
                        if let Ok(Object::Dictionary(nd)) = doc.get_object_mut(nid) {
                            if nd.remove(b"EmbeddedFiles").is_some() {
                                report.removed_attachments = true;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    if spec.forms {
        if let Ok(cat) = doc.catalog_mut() {
            if cat.remove(b"AcroForm").is_some() {
                report.removed_forms = true;
            }
        }
    }

    let pages = page_ids(&doc);
    for page_id in pages {
        if spec.annotations {
            if let Ok(annots) = doc.get_page_annotations(page_id) {
                report.removed_annotations += annots.len();
            }
            if let Ok(d) = doc.get_dictionary_mut(page_id) {
                d.remove(b"Annots");
            }
        } else if spec.attachments || spec.forms {
            // Selective filter of /Annots
            let existing = doc
                .get_dictionary(page_id)
                .ok()
                .and_then(|d| d.get(b"Annots").ok().cloned());
            let list: Vec<Object> = match existing {
                Some(Object::Array(v)) => v,
                Some(Object::Reference(r)) => match doc.get_object(r) {
                    Ok(Object::Array(v)) => v.clone(),
                    _ => Vec::new(),
                },
                _ => Vec::new(),
            };
            if !list.is_empty() {
                let mut kept = Vec::new();
                for item in list {
                    let sub = match &item {
                        Object::Reference(aid) => doc
                            .get_dictionary(*aid)
                            .ok()
                            .and_then(|d| d.get(b"Subtype").and_then(Object::as_name).ok())
                            .map(|b| b.to_vec()),
                        Object::Dictionary(d) => d
                            .get(b"Subtype")
                            .and_then(Object::as_name)
                            .ok()
                            .map(|b| b.to_vec()),
                        _ => None,
                    };
                    let drop = (spec.attachments && sub.as_deref() == Some(b"FileAttachment"))
                        || (spec.forms && sub.as_deref() == Some(b"Widget"));
                    if drop {
                        if sub.as_deref() == Some(b"FileAttachment") {
                            report.removed_attachments = true;
                        } else {
                            report.removed_forms = true;
                        }
                    } else {
                        kept.push(item);
                    }
                }
                if let Ok(d) = doc.get_dictionary_mut(page_id) {
                    if kept.is_empty() {
                        d.remove(b"Annots");
                    } else {
                        d.set("Annots", Object::Array(kept));
                    }
                }
            }
        }
    }

    doc.prune_objects();
    doc.renumber_objects();
    Ok((save(&mut doc)?, report))
}

/// Flatten interactive annotations and form widgets into static page content
/// so they can no longer be edited or removed separately.
pub fn flatten_pdf(pdf: &[u8], password: Option<&str>) -> R<Vec<u8>> {
    let mut doc = load(pdf, password)?;
    let pages = page_ids(&doc);
    let mut seq = 0usize;

    for page_id in pages {
        let pbox = page_box(&doc, page_id);
        let annots: Vec<Dictionary> = doc
            .get_page_annotations(page_id)
            .map(|v| v.into_iter().cloned().collect())
            .unwrap_or_default();
        if annots.is_empty() {
            continue;
        }
        let mut draw_ops: Vec<Operation> = vec![op("q", &[])];
        let mut xobjects = Dictionary::new();

        for ad in annots {
            let subtype = ad.get(b"Subtype").and_then(Object::as_name).unwrap_or(b"");
            if subtype == b"Link" || subtype == b"Popup" {
                continue;
            }
            let rect = ad
                .get(b"Rect")
                .and_then(Object::as_array)
                .map(|a| {
                    let v: Vec<f32> = a
                        .iter()
                        .map(|o| o.as_float().unwrap_or_else(|_| o.as_i64().unwrap_or(0) as f32))
                        .collect();
                    if v.len() == 4 {
                        [v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])]
                    } else {
                        [0.0; 4]
                    }
                })
                .unwrap_or([0.0; 4]);
            let (rw, rh) = (rect[2] - rect[0], rect[3] - rect[1]);
            if rw <= 0.0 || rh <= 0.0 {
                continue;
            }

            // 1. Check if the annotation has an appearance stream (/AP -> /N)
            let ap_n_id = ad
                .get(b"AP")
                .ok()
                .and_then(|o| match o {
                    Object::Dictionary(d) => Some(d),
                    Object::Reference(id) => doc.get_dictionary(*id).ok(),
                    _ => None,
                })
                .and_then(|ap| ap.get(b"N").ok())
                .and_then(|n| match n {
                    Object::Reference(id) => match doc.get_object(*id) {
                        Ok(Object::Stream(_)) => Some(*id),
                        Ok(Object::Dictionary(states)) => {
                            let state = ad.get(b"AS").and_then(Object::as_name).unwrap_or(b"Off");
                            states.get(state).and_then(Object::as_reference).ok()
                        }
                        _ => None,
                    },
                    _ => None,
                });

            if let Some(ap_id) = ap_n_id {
                let bbox = doc
                    .get_object(ap_id)
                    .and_then(|o| o.as_stream())
                    .and_then(|s| s.dict.get(b"BBox"))
                    .and_then(Object::as_array)
                    .map(|a| {
                        let v: Vec<f32> = a
                            .iter()
                            .map(|o| o.as_float().unwrap_or_else(|_| o.as_i64().unwrap_or(0) as f32))
                            .collect();
                        if v.len() == 4 { [v[0], v[1], v[2], v[3]] } else { rect }
                    })
                    .unwrap_or(rect);
                let bw = (bbox[2] - bbox[0]).abs().max(0.001);
                let bh = (bbox[3] - bbox[1]).abs().max(0.001);
                let sx = rw / bw;
                let sy = rh / bh;
                let tx = rect[0] - bbox[0].min(bbox[2]) * sx;
                let ty = rect[1] - bbox[1].min(bbox[3]) * sy;
                let xname = format!("FlatAp{seq}");
                seq += 1;
                xobjects.set(xname.clone(), Object::Reference(ap_id));
                draw_ops.push(op("q", &[]));
                draw_ops.push(op("cm", &[sx, 0.0, 0.0, sy, tx, ty]));
                draw_ops.push(Operation::new("Do", vec![Object::Name(xname.into_bytes())]));
                draw_ops.push(op("Q", &[]));
                continue;
            }

            // 2. Synthesize appearance for standard markup without /AP
            let color: [f32; 3] = ad
                .get(b"C")
                .and_then(Object::as_array)
                .map(|a| {
                    let v: Vec<f32> = a.iter().map(|o| o.as_float().unwrap_or(0.0)).collect();
                    if v.len() == 3 { [v[0], v[1], v[2]] } else { [1.0, 0.85, 0.2] }
                })
                .unwrap_or([1.0, 0.85, 0.2]);
            draw_ops.push(op("q", &[]));
            if subtype == b"Highlight" {
                // Light tint rectangle
                let [r, g, b] = [
                    1.0 - (1.0 - color[0]) * 0.35,
                    1.0 - (1.0 - color[1]) * 0.35,
                    1.0 - (1.0 - color[2]) * 0.35,
                ];
                draw_ops.push(op("rg", &[r, g, b]));
                draw_ops.push(op("re", &[rect[0], rect[1], rw, rh]));
                draw_ops.push(op("f", &[]));
            } else if subtype == b"Underline" || subtype == b"StrikeOut" || subtype == b"Squiggly" {
                let y = if subtype == b"StrikeOut" { rect[1] + rh * 0.5 } else { rect[1] + 1.0 };
                draw_ops.push(op("RG", &color));
                draw_ops.push(op("w", &[1.2]));
                draw_ops.push(op("m", &[rect[0], y]));
                draw_ops.push(op("l", &[rect[2], y]));
                draw_ops.push(op("S", &[]));
            } else if subtype == b"Square" {
                draw_ops.push(op("RG", &color));
                draw_ops.push(op("w", &[1.5]));
                draw_ops.push(op("re", &[rect[0], rect[1], rw, rh]));
                draw_ops.push(op("S", &[]));
            }
            draw_ops.push(op("Q", &[]));
        }

        draw_ops.push(op("Q", &[]));
        if draw_ops.len() > 2 {
            let content = Content { operations: draw_ops }.encode().unwrap_or_default();
            let mut form = dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => nums(&pbox),
            };
            if !xobjects.is_empty() {
                form.set("Resources", Object::Dictionary(dictionary! { "XObject" => xobjects }));
            }
            let form_id = doc.add_object(Stream::new(form, content));
            attach_form_layer(&mut doc, page_id, &format!("SoloFlatPage{seq}"), form_id, false)?;
            seq += 1;
        }
        if let Ok(d) = doc.get_dictionary_mut(page_id) {
            d.remove(b"Annots");
        }
    }

    if let Ok(cat) = doc.catalog_mut() {
        cat.remove(b"AcroForm");
    }
    doc.prune_objects();
    doc.renumber_objects();
    save(&mut doc)
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct RedactRect {
    /// 1-based page number
    pub page: u32,
    /// `[x1, y1, x2, y2]` in PDF user-space points
    pub rect: [f32; 4],
    #[serde(default)]
    pub color: [f32; 3],
    #[serde(default)]
    pub label: String,
}

fn rects_overlap(a: [f32; 4], b: [f32; 4]) -> bool {
    let (ax1, ay1, ax2, ay2) = (a[0].min(a[2]), a[1].min(a[3]), a[0].max(a[2]), a[1].max(a[3]));
    let (bx1, by1, bx2, by2) = (b[0].min(b[2]), b[1].min(b[3]), b[0].max(b[2]), b[1].max(b[3]));
    ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1
}

fn mat_mul(m1: [f32; 6], m2: [f32; 6]) -> [f32; 6] {
    [
        m1[0] * m2[0] + m1[1] * m2[2],
        m1[0] * m2[1] + m1[1] * m2[3],
        m1[2] * m2[0] + m1[3] * m2[2],
        m1[2] * m2[1] + m1[3] * m2[3],
        m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
        m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
    ]
}

fn op_floats(op: &Operation) -> Vec<f32> {
    op.operands
        .iter()
        .map(|o| o.as_float().unwrap_or_else(|_| o.as_i64().unwrap_or(0) as f32))
        .collect()
}

/// Remove text-showing operations from `raw_content` whose position overlaps any `boxes`.
fn strip_text_in_rects(raw_content: &[u8], boxes: &[[f32; 4]]) -> Option<Vec<u8>> {
    let decoded = Content::decode(raw_content).ok()?;
    let mut ctm = [1.0f32, 0.0, 0.0, 1.0, 0.0, 0.0];
    let mut ctm_stack: Vec<[f32; 6]> = Vec::new();
    let mut tm = [1.0f32, 0.0, 0.0, 1.0, 0.0, 0.0];
    let mut tlm = [1.0f32, 0.0, 0.0, 1.0, 0.0, 0.0];
    let mut font_size = 12.0f32;
    let mut leading = 14.0f32;
    let mut out_ops = Vec::with_capacity(decoded.operations.len());

    for op in decoded.operations {
        match op.operator.as_str() {
            "q" => {
                ctm_stack.push(ctm);
                out_ops.push(op);
            }
            "Q" => {
                if let Some(prev) = ctm_stack.pop() {
                    ctm = prev;
                }
                out_ops.push(op);
            }
            "cm" => {
                let v = op_floats(&op);
                if v.len() == 6 {
                    ctm = mat_mul([v[0], v[1], v[2], v[3], v[4], v[5]], ctm);
                }
                out_ops.push(op);
            }
            "BT" => {
                tm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
                tlm = tm;
                out_ops.push(op);
            }
            "Tf" => {
                if let Some(fs) = op.operands.get(1) {
                    font_size = fs.as_float().unwrap_or_else(|_| fs.as_i64().unwrap_or(12) as f32).abs().max(1.0);
                }
                out_ops.push(op);
            }
            "TL" => {
                let v = op_floats(&op);
                if let Some(&tl) = v.first() {
                    leading = tl;
                }
                out_ops.push(op);
            }
            "Tm" => {
                let v = op_floats(&op);
                if v.len() == 6 {
                    tm = [v[0], v[1], v[2], v[3], v[4], v[5]];
                    tlm = tm;
                }
                out_ops.push(op);
            }
            "Td" | "TD" => {
                let v = op_floats(&op);
                if v.len() == 2 {
                    if op.operator == "TD" {
                        leading = -v[1];
                    }
                    tlm = mat_mul([1.0, 0.0, 0.0, 1.0, v[0], v[1]], tlm);
                    tm = tlm;
                }
                out_ops.push(op);
            }
            "T*" => {
                tlm = mat_mul([1.0, 0.0, 0.0, 1.0, 0.0, -leading], tlm);
                tm = tlm;
                out_ops.push(op);
            }
            "Tj" | "TJ" | "'" | "\"" => {
                if op.operator == "'" || op.operator == "\"" {
                    tlm = mat_mul([1.0, 0.0, 0.0, 1.0, 0.0, -leading], tlm);
                    tm = tlm;
                }
                let m = mat_mul(tm, ctm);
                let scale_y = (m[2].hypot(m[3])).max(1.0);
                let scale_x = (m[0].hypot(m[1])).max(1.0);
                let h = (font_size * scale_y).max(6.0);
                // Estimate character count of the shown string(s)
                let char_count: usize = op
                    .operands
                    .iter()
                    .map(|o| match o {
                        Object::String(b, _) => b.len().max(1),
                        Object::Array(arr) => arr
                            .iter()
                            .map(|it| match it {
                                Object::String(b, _) => b.len(),
                                _ => 0,
                            })
                            .sum(),
                        _ => 0,
                    })
                    .sum();
                let w = (char_count.max(1) as f32) * font_size * scale_x * 0.55;
                let tx = m[4];
                let ty = m[5];
                let text_box = [tx, ty - h * 0.25, tx + w, ty + h * 0.85];
                let hit = boxes.iter().any(|r| rects_overlap(text_box, *r));
                if !hit {
                    out_ops.push(op);
                }
                // Advance horizontal position so subsequentTj on the same line stays in place
                tm[4] += (char_count as f32) * font_size * 0.5 * tm[0];
            }
            _ => out_ops.push(op),
        }
    }
    Content { operations: out_ops }.encode().ok()
}

/// True redaction: strips underlying text-showing operations overlapping the
/// redaction rectangles, removes overlapping annotations, paints opaque boxes,
/// and optionally sanitizes document metadata.
pub fn redact_pdf(
    pdf: &[u8],
    password: Option<&str>,
    rects: &[RedactRect],
    strip_metadata: bool,
) -> R<Vec<u8>> {
    if rects.is_empty() {
        return Err("没有指定脱敏区域".into());
    }
    let mut doc = load(pdf, password)?;
    let ids = page_ids(&doc);
    let mut by_page: std::collections::BTreeMap<u32, Vec<&RedactRect>> = Default::default();
    for r in rects {
        if r.page >= 1 && (r.page as usize) <= ids.len() {
            by_page.entry(r.page).or_default().push(r);
        }
    }
    if by_page.is_empty() {
        return Err("脱敏区域页码超出范围".into());
    }

    for (page_no, list) in by_page {
        let page_id = ids[page_no as usize - 1];
        let pbox = page_box(&doc, page_id);
        let boxes: Vec<[f32; 4]> = list
            .iter()
            .map(|r| {
                let q = r.rect;
                [q[0].min(q[2]), q[1].min(q[3]), q[0].max(q[2]), q[1].max(q[3])]
            })
            .collect();

        // 1. Strip underlying text operations inside the redaction boxes
        if let Ok(raw) = doc.get_page_content(page_id) {
            if let Some(cleaned) = strip_text_in_rects(&raw, &boxes) {
                let new_stream = doc.add_object(Stream::new(dictionary! {}, cleaned));
                if let Ok(d) = doc.get_dictionary_mut(page_id) {
                    d.set("Contents", Object::Reference(new_stream));
                }
            }
        }

        // 2. Drop annotations overlapping any redaction box
        let existing_annots = doc
            .get_dictionary(page_id)
            .ok()
            .and_then(|d| d.get(b"Annots").ok().cloned());
        if let Some(Object::Array(arr)) = existing_annots {
            let mut kept = Vec::new();
            for item in arr {
                let arect = match &item {
                    Object::Reference(aid) => doc.get_dictionary(*aid).ok().and_then(|d| d.get(b"Rect").ok()),
                    Object::Dictionary(d) => d.get(b"Rect").ok(),
                    _ => None,
                }
                .and_then(|o| o.as_array().ok())
                .map(|a| {
                    let v: Vec<f32> = a.iter().map(|x| x.as_float().unwrap_or(0.0)).collect();
                    if v.len() == 4 { Some([v[0], v[1], v[2], v[3]]) } else { None }
                })
                .flatten();
                let overlaps = arect.map_or(false, |ar| boxes.iter().any(|br| rects_overlap(ar, *br)));
                if !overlaps {
                    kept.push(item);
                }
            }
            if let Ok(d) = doc.get_dictionary_mut(page_id) {
                if kept.is_empty() {
                    d.remove(b"Annots");
                } else {
                    d.set("Annots", Object::Array(kept));
                }
            }
        }

        // 3. Draw opaque redaction boxes (plus optional label)
        let mut ops: Vec<Operation> = vec![op("q", &[])];
        let mut need_font = None;
        for (i, r) in list.iter().enumerate() {
            let [x1, y1, x2, y2] = boxes[i];
            let (w, h) = (x2 - x1, y2 - y1);
            let [cr, cg, cb] = r.color;
            ops.push(op("rg", &[cr, cg, cb]));
            ops.push(op("re", &[x1, y1, w, h]));
            ops.push(op("f", &[]));
            let lbl = r.label.trim();
            if !lbl.is_empty() && w > 16.0 && h > 6.0 {
                let latin = lbl.chars().all(is_latin);
                need_font = Some(latin);
                let fs = (h * 0.65).clamp(6.0, 14.0);
                let tw = text_advance(lbl, latin, fs);
                // Contrasting text color (white on dark box, black on light box)
                let lum = 0.299 * cr + 0.587 * cg + 0.114 * cb;
                let tc = if lum < 0.5 { 1.0 } else { 0.0 };
                ops.push(op("BT", &[]));
                ops.push(Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), Object::Real(fs)]));
                ops.push(op("rg", &[tc, tc, tc]));
                ops.push(op("Td", &[x1 + (w - tw).max(2.0) / 2.0, y1 + (h - fs * 0.75) / 2.0]));
                ops.push(Operation::new("Tj", vec![text_bytes(lbl, latin)]));
                ops.push(op("ET", &[]));
            }
        }
        ops.push(op("Q", &[]));
        let content = Content { operations: ops }.encode().unwrap_or_default();
        let mut form = dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => nums(&pbox),
        };
        if let Some(latin) = need_font {
            form.set(
                "Resources",
                Object::Dictionary(dictionary! { "Font" => dictionary! { "F1" => text_font(latin) } }),
            );
        }
        let form_id = doc.add_object(Stream::new(form, content));
        attach_form_layer(&mut doc, page_id, &format!("SoloRedact{page_no}"), form_id, false)?;
    }

    if strip_metadata {
        doc.trailer.remove(b"Info");
        let all_ids: Vec<ObjectId> = doc.objects.keys().copied().collect();
        for id in all_ids {
            if let Ok(Object::Dictionary(d)) = doc.get_object_mut(id) {
                d.remove(b"Metadata");
                d.remove(b"PieceInfo");
            }
        }
    }
    doc.prune_objects();
    doc.renumber_objects();
    save(&mut doc)
}

// ── outlines (bookmarks) ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutlineNode {
    pub title: String,
    /// 1-based page number
    pub page: u32,
    #[serde(default)]
    pub top: Option<f32>,
    #[serde(default)]
    pub children: Vec<OutlineNode>,
}

fn resolve_dict<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a Dictionary> {
    match obj {
        Object::Dictionary(d) => Some(d),
        Object::Reference(id) => doc.get_dictionary(*id).ok(),
        _ => None,
    }
}

fn resolve_array<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a Vec<Object>> {
    match obj {
        Object::Array(a) => Some(a),
        Object::Reference(id) => doc.get_object(*id).and_then(Object::as_array).ok(),
        _ => None,
    }
}

fn parse_dest_array(
    arr: &[Object],
    page_map: &std::collections::HashMap<ObjectId, u32>,
    total_pages: u32,
) -> Option<(u32, Option<f32>)> {
    let first = arr.first()?;
    let page = match first {
        Object::Reference(pid) => *page_map.get(pid)?,
        Object::Integer(n) => (*n as u32 + 1).clamp(1, total_pages.max(1)),
        _ => return None,
    };
    let mode = arr.get(1).and_then(|o| o.as_name().ok()).unwrap_or(b"");
    let top_obj = if mode == b"XYZ" {
        arr.get(3)
    } else if mode == b"FitH" || mode == b"FitBH" {
        arr.get(2)
    } else {
        None
    };
    let top = top_obj.and_then(|o| {
        o.as_float()
            .ok()
            .or_else(|| o.as_i64().ok().map(|n| n as f32))
    });
    Some((page, top))
}

fn resolve_outline_dest(
    doc: &Document,
    item: &Dictionary,
    page_map: &std::collections::HashMap<ObjectId, u32>,
    total_pages: u32,
) -> (u32, Option<f32>) {
    if let Ok(dest_obj) = item.get(b"Dest") {
        if let Some(arr) = resolve_array(doc, dest_obj) {
            if let Some(res) = parse_dest_array(arr, page_map, total_pages) {
                return res;
            }
        }
    }
    if let Ok(act_obj) = item.get(b"A") {
        if let Some(act_dict) = resolve_dict(doc, act_obj) {
            let is_goto = act_dict
                .get(b"S")
                .and_then(Object::as_name)
                .map(|s| s == b"GoTo")
                .unwrap_or(true);
            if is_goto {
                if let Ok(d_obj) = act_dict.get(b"D") {
                    if let Some(arr) = resolve_array(doc, d_obj) {
                        if let Some(res) = parse_dest_array(arr, page_map, total_pages) {
                            return res;
                        }
                    }
                }
            }
        }
    }
    (1, None)
}

fn read_outline_siblings(
    doc: &Document,
    first_id: ObjectId,
    page_map: &std::collections::HashMap<ObjectId, u32>,
    total_pages: u32,
    visited: &mut std::collections::HashSet<ObjectId>,
    depth: usize,
) -> Vec<OutlineNode> {
    if depth > 32 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cur = Some(first_id);
    while let Some(id) = cur {
        if !visited.insert(id) {
            break;
        }
        let Ok(item) = doc.get_dictionary(id) else {
            break;
        };
        let title = item
            .get(b"Title")
            .ok()
            .and_then(|o| match o {
                Object::String(b, _) => Some(crate::crypto_sig::decode_pdf_string(b)),
                _ => None,
            })
            .unwrap_or_default();
        let (page, top) = resolve_outline_dest(doc, item, page_map, total_pages);
        let children = item
            .get(b"First")
            .and_then(Object::as_reference)
            .ok()
            .map(|child_first| {
                read_outline_siblings(doc, child_first, page_map, total_pages, visited, depth + 1)
            })
            .unwrap_or_default();
        out.push(OutlineNode {
            title,
            page,
            top,
            children,
        });
        cur = item.get(b"Next").and_then(Object::as_reference).ok();
    }
    out
}

/// Read the document's `/Outlines` bookmark tree.
pub fn get_outlines(pdf: &[u8], password: Option<&str>) -> R<Vec<OutlineNode>> {
    let doc = load(pdf, password)?;
    let pages_btree = doc.get_pages();
    let total_pages = pages_btree.len() as u32;
    let page_map: std::collections::HashMap<ObjectId, u32> =
        pages_btree.into_iter().map(|(num, id)| (id, num)).collect();

    let Ok(cat) = doc.catalog() else {
        return Ok(Vec::new());
    };
    let Ok(outlines_obj) = cat.get(b"Outlines") else {
        return Ok(Vec::new());
    };
    let Some(outlines_dict) = resolve_dict(&doc, outlines_obj) else {
        return Ok(Vec::new());
    };
    let Ok(first_id) = outlines_dict.get(b"First").and_then(Object::as_reference) else {
        return Ok(Vec::new());
    };

    let mut visited = std::collections::HashSet::new();
    Ok(read_outline_siblings(
        &doc,
        first_id,
        &page_map,
        total_pages,
        &mut visited,
        0,
    ))
}

fn build_outline_siblings(
    doc: &mut Document,
    nodes: &[OutlineNode],
    parent_id: ObjectId,
    pages: &[ObjectId],
) -> (ObjectId, ObjectId, usize) {
    let sibling_ids: Vec<ObjectId> = (0..nodes.len()).map(|_| doc.new_object_id()).collect();
    let mut total_count = nodes.len();

    for (i, node) in nodes.iter().enumerate() {
        let id = sibling_ids[i];
        let page_idx = (node.page.max(1) as usize - 1).min(pages.len().saturating_sub(1));
        let page_id = pages[page_idx];
        let top_obj = node.top.map(Object::Real).unwrap_or(Object::Null);
        let dest = Object::Array(vec![
            Object::Reference(page_id),
            Object::Name(b"XYZ".to_vec()),
            Object::Null,
            top_obj,
            Object::Null,
        ]);

        let mut dict = dictionary! {
            "Title" => text_string(&node.title),
            "Parent" => Object::Reference(parent_id),
            "Dest" => dest,
        };
        if i > 0 {
            dict.set("Prev", Object::Reference(sibling_ids[i - 1]));
        }
        if i + 1 < nodes.len() {
            dict.set("Next", Object::Reference(sibling_ids[i + 1]));
        }
        if !node.children.is_empty() {
            let (first_child, last_child, child_count) =
                build_outline_siblings(doc, &node.children, id, pages);
            dict.set("First", Object::Reference(first_child));
            dict.set("Last", Object::Reference(last_child));
            dict.set("Count", Object::Integer(child_count as i64));
            total_count += child_count;
        }
        doc.objects.insert(id, Object::Dictionary(dict));
    }

    (
        *sibling_ids.first().unwrap(),
        *sibling_ids.last().unwrap(),
        total_count,
    )
}

/// Replace the document's `/Outlines` bookmark tree with `outlines`.
pub fn set_outlines(pdf: &[u8], password: Option<&str>, outlines: &[OutlineNode]) -> R<Vec<u8>> {
    let mut doc = load(pdf, password)?;
    let pages = page_ids(&doc);
    if pages.is_empty() {
        return Err("PDF 没有页面".into());
    }
    if outlines.is_empty() {
        if let Ok(cat) = doc.catalog_mut() {
            cat.remove(b"Outlines");
        }
        doc.prune_objects();
        doc.renumber_objects();
        return save(&mut doc);
    }

    let root_id = doc.new_object_id();
    let (first_id, last_id, total_count) =
        build_outline_siblings(&mut doc, outlines, root_id, &pages);
    let root_dict = dictionary! {
        "Type" => "Outlines",
        "First" => Object::Reference(first_id),
        "Last" => Object::Reference(last_id),
        "Count" => Object::Integer(total_count as i64),
    };
    doc.objects.insert(root_id, Object::Dictionary(root_dict));
    let cat = doc.catalog_mut().map_err(e("找不到 Catalog"))?;
    cat.set("Outlines", Object::Reference(root_id));
    cat.set("PageMode", Object::Name(b"UseOutlines".to_vec()));
    doc.prune_objects();
    doc.renumber_objects();
    save(&mut doc)
}

// ── N-up & Booklet multi-page imposition ─────────────────────────────────

fn default_nup_margin() -> f32 {
    18.0
}
fn default_nup_gap() -> f32 {
    12.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NupSpec {
    pub cols: u32,
    pub rows: u32,
    #[serde(default)]
    pub landscape: Option<bool>,
    #[serde(default = "default_nup_margin")]
    pub margin: f32,
    #[serde(default = "default_nup_gap")]
    pub gap: f32,
    #[serde(default)]
    pub border: bool,
}

impl Default for NupSpec {
    fn default() -> Self {
        Self {
            cols: 2,
            rows: 2,
            landscape: None,
            margin: default_nup_margin(),
            gap: default_nup_gap(),
            border: false,
        }
    }
}

/// Convert a page into a standalone `/Type /XObject /Subtype /Form`, returning `(form_id, bbox)`.
fn page_to_form_xobject(doc: &mut Document, page_id: ObjectId) -> (ObjectId, [f32; 4]) {
    let bbox = page_box(doc, page_id);
    let resources = inherited(doc, page_id, b"Resources")
        .unwrap_or_else(|| Object::Dictionary(Dictionary::new()));
    let raw_content = doc.get_page_content(page_id).unwrap_or_default();
    let form_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Form",
        "BBox" => nums(&bbox),
        "Resources" => resources,
    };
    let form_id = doc.add_object(Stream::new(form_dict, raw_content));
    (form_id, bbox)
}

/// Impose `cols * rows` source pages onto each output sheet.
pub fn nup_pdf(pdf: &[u8], password: Option<&str>, spec: &NupSpec) -> R<Vec<u8>> {
    if spec.cols == 0 || spec.rows == 0 {
        return Err("行列数必须大于 0".into());
    }
    let mut doc = load(pdf, password)?;
    let src_pages = page_ids(&doc);
    if src_pages.is_empty() {
        return Err("PDF 没有页面".into());
    }
    let pages_id = doc
        .catalog()
        .and_then(|c| c.get(b"Pages"))
        .and_then(Object::as_reference)
        .map_err(e("找不到页面树"))?;

    let first_box = page_box(&doc, src_pages[0]);
    let bw0 = (first_box[2] - first_box[0]).abs().max(72.0);
    let bh0 = (first_box[3] - first_box[1]).abs().max(72.0);
    let (port_w, port_h) = (bw0.min(bh0), bw0.max(bh0));
    let is_landscape = spec.landscape.unwrap_or(spec.cols > spec.rows);
    let (sheet_w, sheet_h) = if is_landscape {
        (port_h, port_w)
    } else {
        (port_w, port_h)
    };

    let mut forms = Vec::with_capacity(src_pages.len());
    for &pid in &src_pages {
        forms.push(page_to_form_xobject(&mut doc, pid));
    }

    let per_sheet = (spec.cols * spec.rows) as usize;
    let margin = spec.margin.max(0.0);
    let gap = spec.gap.max(0.0);
    let avail_w = (sheet_w - 2.0 * margin - (spec.cols as f32 - 1.0) * gap).max(10.0);
    let avail_h = (sheet_h - 2.0 * margin - (spec.rows as f32 - 1.0) * gap).max(10.0);
    let cell_w = avail_w / (spec.cols as f32);
    let cell_h = avail_h / (spec.rows as f32);

    let mut new_kids: Vec<Object> = Vec::new();
    for chunk in forms.chunks(per_sheet) {
        let mut ops: Vec<Operation> = Vec::new();
        let mut xobj_dict = Dictionary::new();

        for (k, &(form_id, bbox)) in chunk.iter().enumerate() {
            let col = (k as u32) % spec.cols;
            let row = (k as u32) / spec.cols;
            let cell_x = margin + (col as f32) * (cell_w + gap);
            let cell_y = sheet_h - margin - ((row + 1) as f32) * cell_h - (row as f32) * gap;

            let pw = (bbox[2] - bbox[0]).abs().max(1.0);
            let ph = (bbox[3] - bbox[1]).abs().max(1.0);
            let s = (cell_w / pw).min(cell_h / ph);
            let dw = pw * s;
            let dh = ph * s;
            let tx = cell_x + (cell_w - dw) * 0.5 - bbox[0] * s;
            let ty = cell_y + (cell_h - dh) * 0.5 - bbox[1] * s;

            let fm_name = format!("Fm{k}");
            xobj_dict.set(fm_name.clone(), Object::Reference(form_id));
            ops.push(op("q", &[]));
            ops.push(op("cm", &[s, 0.0, 0.0, s, tx, ty]));
            ops.push(Operation::new("Do", vec![Object::Name(fm_name.into_bytes())]));
            ops.push(op("Q", &[]));

            if spec.border {
                ops.push(op("q", &[]));
                ops.push(op("RG", &[0.75, 0.75, 0.75]));
                ops.push(op("w", &[0.5]));
                ops.push(op("re", &[cell_x, cell_y, cell_w, cell_h]));
                ops.push(op("S", &[]));
                ops.push(op("Q", &[]));
            }
        }

        let content_bytes = Content { operations: ops }.encode().unwrap_or_default();
        let content_id = doc.add_object(Stream::new(dictionary! {}, content_bytes));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => nums(&[0.0, 0.0, sheet_w, sheet_h]),
            "Contents" => content_id,
            "Resources" => dictionary! { "XObject" => Object::Dictionary(xobj_dict) },
        });
        new_kids.push(Object::Reference(page_id));
    }

    let count = new_kids.len() as i64;
    let root = doc.get_dictionary_mut(pages_id).map_err(e("页面树异常"))?;
    root.set("Kids", Object::Array(new_kids));
    root.set("Count", Object::Integer(count));
    let _ = doc.catalog_mut().map(|c| c.remove(b"Outlines"));
    doc.prune_objects();
    doc.renumber_objects();
    save(&mut doc)
}

/// Saddle-stitch booklet imposition: pads page count $N$ to a multiple of 4
/// ($M = \lceil N/4 \rceil \times 4$) and imposes 2-up landscape sheets ordered
/// as Front `(M - 2s, 1 + 2s)` and Back `(2 + 2s, M - 1 - 2s)`.
pub fn booklet_pdf(pdf: &[u8], password: Option<&str>, border: bool) -> R<Vec<u8>> {
    let mut doc = load(pdf, password)?;
    let src_pages = page_ids(&doc);
    let n = src_pages.len();
    if n == 0 {
        return Err("PDF 没有页面".into());
    }
    let pages_id = doc
        .catalog()
        .and_then(|c| c.get(b"Pages"))
        .and_then(Object::as_reference)
        .map_err(e("找不到页面树"))?;

    let first_box = page_box(&doc, src_pages[0]);
    let bw0 = (first_box[2] - first_box[0]).abs().max(72.0);
    let bh0 = (first_box[3] - first_box[1]).abs().max(72.0);
    let (port_w, port_h) = (bw0.min(bh0), bw0.max(bh0));
    let (sheet_w, sheet_h) = if port_h > port_w {
        (port_h, port_w)
    } else {
        (port_w * 2.0, port_h)
    };

    let mut forms = Vec::with_capacity(n);
    for &pid in &src_pages {
        forms.push(page_to_form_xobject(&mut doc, pid));
    }

    let m = ((n + 3) / 4) * 4;
    let mut pairs: Vec<(usize, usize)> = Vec::with_capacity(m / 2);
    for s in 0..(m / 4) {
        // Front side: left = M - 2s, right = 1 + 2s
        pairs.push((m - 2 * s, 1 + 2 * s));
        // Back side: left = 2 + 2s, right = M - 1 - 2s
        pairs.push((2 + 2 * s, m - 1 - 2 * s));
    }

    let half_w = sheet_w * 0.5;
    let cell_h = sheet_h;
    let mut new_kids: Vec<Object> = Vec::with_capacity(pairs.len());

    for (left_p, right_p) in pairs {
        let mut ops: Vec<Operation> = Vec::new();
        let mut xobj_dict = Dictionary::new();

        for (slot_idx, p_no) in [left_p, right_p].into_iter().enumerate() {
            let cell_x = (slot_idx as f32) * half_w;
            let cell_y = 0.0f32;
            if p_no >= 1 && p_no <= n {
                let (form_id, bbox) = forms[p_no - 1];
                let pw = (bbox[2] - bbox[0]).abs().max(1.0);
                let ph = (bbox[3] - bbox[1]).abs().max(1.0);
                let s = (half_w / pw).min(cell_h / ph);
                let dw = pw * s;
                let dh = ph * s;
                let tx = cell_x + (half_w - dw) * 0.5 - bbox[0] * s;
                let ty = cell_y + (cell_h - dh) * 0.5 - bbox[1] * s;
                let fm_name = format!("Fm{slot_idx}");
                xobj_dict.set(fm_name.clone(), Object::Reference(form_id));
                ops.push(op("q", &[]));
                ops.push(op("cm", &[s, 0.0, 0.0, s, tx, ty]));
                ops.push(Operation::new("Do", vec![Object::Name(fm_name.into_bytes())]));
                ops.push(op("Q", &[]));
            }
            if border {
                ops.push(op("q", &[]));
                ops.push(op("RG", &[0.75, 0.75, 0.75]));
                ops.push(op("w", &[0.5]));
                ops.push(op("re", &[cell_x, cell_y, half_w, cell_h]));
                ops.push(op("S", &[]));
                ops.push(op("Q", &[]));
            }
        }

        let content_bytes = Content { operations: ops }.encode().unwrap_or_default();
        let content_id = doc.add_object(Stream::new(dictionary! {}, content_bytes));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => nums(&[0.0, 0.0, sheet_w, sheet_h]),
            "Contents" => content_id,
            "Resources" => dictionary! { "XObject" => Object::Dictionary(xobj_dict) },
        });
        new_kids.push(Object::Reference(page_id));
    }

    let count = new_kids.len() as i64;
    let root = doc.get_dictionary_mut(pages_id).map_err(e("页面树异常"))?;
    root.set("Kids", Object::Array(new_kids));
    root.set("Count", Object::Integer(count));
    let _ = doc.catalog_mut().map(|c| c.remove(b"Outlines"));
    doc.prune_objects();
    doc.renumber_objects();
    save(&mut doc)
}

// ── grayscale & scan background whitening ────────────────────────────────

fn rewrite_stream_to_grayscale(raw: &[u8]) -> Option<Vec<u8>> {
    let decoded = Content::decode(raw).ok()?;
    let mut changed = false;
    let mut out_ops = Vec::with_capacity(decoded.operations.len());

    for op_item in decoded.operations {
        match op_item.operator.as_str() {
            "rg" | "RG" => {
                let v = op_floats(&op_item);
                if v.len() == 3 {
                    let lum = (0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2]).clamp(0.0, 1.0);
                    let new_op = if op_item.operator == "rg" { "g" } else { "G" };
                    out_ops.push(op(new_op, &[lum]));
                    changed = true;
                } else {
                    out_ops.push(op_item);
                }
            }
            "k" | "K" => {
                let v = op_floats(&op_item);
                if v.len() == 4 {
                    let lum = (1.0 - (0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2] + v[3]).min(1.0))
                        .clamp(0.0, 1.0);
                    let new_op = if op_item.operator == "k" { "g" } else { "G" };
                    out_ops.push(op(new_op, &[lum]));
                    changed = true;
                } else {
                    out_ops.push(op_item);
                }
            }
            _ => out_ops.push(op_item),
        }
    }

    if !changed {
        return None;
    }
    Content { operations: out_ops }.encode().ok()
}

fn whiten_gray_pixels(pixels: &mut [u8]) {
    for p in pixels.iter_mut() {
        let v = *p;
        if v >= 210 {
            *p = 255;
        } else if v <= 35 {
            *p = 0;
        } else {
            // Stretch [35..210] -> [0..255] to clean gray scan backgrounds
            *p = (((v as u32 - 35) * 255) / 175).min(255) as u8;
        }
    }
}

/// Convert page/form content streams and embedded image XObjects to grayscale,
/// optionally whitening light-gray scan backgrounds (`whiten_bg = true`).
pub fn grayscale_pdf(pdf: &[u8], password: Option<&str>, whiten_bg: bool) -> R<Vec<u8>> {
    let mut doc = load(pdf, password)?;

    // 1. Rewrite page content streams
    for page_id in page_ids(&doc) {
        if let Ok(raw) = doc.get_page_content(page_id) {
            if let Some(gray_bytes) = rewrite_stream_to_grayscale(&raw) {
                let new_stream = doc.add_object(Stream::new(dictionary! {}, gray_bytes));
                if let Ok(d) = doc.get_dictionary_mut(page_id) {
                    d.set("Contents", Object::Reference(new_stream));
                }
            }
        }
    }

    // 2. Rewrite Form XObjects and convert Image XObjects to DeviceGray
    let all_ids: Vec<ObjectId> = doc.objects.keys().copied().collect();
    for id in all_ids {
        let Ok(stream) = doc.get_object(id).and_then(Object::as_stream).cloned() else {
            continue;
        };
        let subtype = stream
            .dict
            .get(b"Subtype")
            .and_then(Object::as_name)
            .unwrap_or(b"");

        if subtype == b"Form" {
            if let Ok(raw) = stream.decompressed_content() {
                if let Some(gray_bytes) = rewrite_stream_to_grayscale(&raw) {
                    let mut dict = stream.dict.clone();
                    dict.remove(b"Filter");
                    dict.remove(b"DecodeParms");
                    let mut new_stream = Stream::new(dict, gray_bytes);
                    let _ = new_stream.compress();
                    doc.objects.insert(id, Object::Stream(new_stream));
                }
            }
            continue;
        }

        if subtype != b"Image" {
            continue;
        }
        let w = stream.dict.get(b"Width").and_then(Object::as_i64).unwrap_or(0) as u32;
        let h = stream.dict.get(b"Height").and_then(Object::as_i64).unwrap_or(0) as u32;
        if w == 0 || h == 0 {
            continue;
        }
        let bpc = stream
            .dict
            .get(b"BitsPerComponent")
            .and_then(Object::as_i64)
            .unwrap_or(8);
        if bpc != 8 {
            continue;
        }
        let cs = stream
            .dict
            .get(b"ColorSpace")
            .and_then(Object::as_name)
            .unwrap_or(b"");
        if cs != b"DeviceRGB" && !(whiten_bg && cs == b"DeviceGray") {
            continue;
        }

        let filters = stream.filters().unwrap_or_default();
        let is_jpeg = filters.iter().any(|f| *f == b"DCTDecode");

        let gray_pixels: Option<Vec<u8>> = if is_jpeg {
            image::load_from_memory(&stream.content)
                .ok()
                .map(|img| img.to_luma8().into_raw())
        } else if let Ok(raw) = stream.decompressed_content() {
            if cs == b"DeviceRGB" && raw.len() >= (w * h * 3) as usize {
                let mut luma = Vec::with_capacity((w * h) as usize);
                for rgb in raw[..(w * h * 3) as usize].chunks_exact(3) {
                    let y = ((77u32 * rgb[0] as u32
                        + 150u32 * rgb[1] as u32
                        + 29u32 * rgb[2] as u32
                        + 128)
                        >> 8) as u8;
                    luma.push(y);
                }
                Some(luma)
            } else if cs == b"DeviceGray" && raw.len() >= (w * h) as usize {
                Some(raw[..(w * h) as usize].to_vec())
            } else {
                None
            }
        } else {
            None
        };

        if let Some(mut gray) = gray_pixels {
            if whiten_bg {
                whiten_gray_pixels(&mut gray);
            }
            let mut dict = stream.dict.clone();
            dict.set("ColorSpace", Object::Name(b"DeviceGray".to_vec()));
            dict.set("BitsPerComponent", Object::Integer(8));
            dict.remove(b"Filter");
            dict.remove(b"DecodeParms");
            let mut new_stream = Stream::new(dict, gray);
            let _ = new_stream.compress();
            doc.objects.insert(id, Object::Stream(new_stream));
        }
    }

    save(&mut doc)
}

// ── normalize page size ──────────────────────────────────────────────────

fn transform_annot_coords(ad: &mut Dictionary, s: f32, dx: f32, dy: f32) {
    if let Ok(arr) = ad.get(b"Rect").and_then(Object::as_array) {
        let v: Vec<f32> = arr
            .iter()
            .map(|o| o.as_float().unwrap_or_else(|_| o.as_i64().unwrap_or(0) as f32))
            .collect();
        if v.len() == 4 {
            ad.set(
                "Rect",
                nums(&[
                    v[0] * s + dx,
                    v[1] * s + dy,
                    v[2] * s + dx,
                    v[3] * s + dy,
                ]),
            );
        }
    }
    if let Ok(arr) = ad.get(b"QuadPoints").and_then(Object::as_array) {
        let v: Vec<f32> = arr
            .iter()
            .map(|o| o.as_float().unwrap_or_else(|_| o.as_i64().unwrap_or(0) as f32))
            .collect();
        if v.len() % 2 == 0 && !v.is_empty() {
            let mut out = Vec::with_capacity(v.len());
            for pair in v.chunks_exact(2) {
                out.push(pair[0] * s + dx);
                out.push(pair[1] * s + dy);
            }
            ad.set("QuadPoints", nums(&out));
        }
    }
    if let Ok(arr) = ad.get(b"L").and_then(Object::as_array) {
        let v: Vec<f32> = arr
            .iter()
            .map(|o| o.as_float().unwrap_or_else(|_| o.as_i64().unwrap_or(0) as f32))
            .collect();
        if v.len() == 4 {
            ad.set(
                "L",
                nums(&[
                    v[0] * s + dx,
                    v[1] * s + dy,
                    v[2] * s + dx,
                    v[3] * s + dy,
                ]),
            );
        }
    }
}

/// Uniformly scale and center every page to `[0, 0, target_w, target_h]` in
/// PDF points while keeping `/Annots` coordinates aligned.
pub fn normalize_page_size(
    pdf: &[u8],
    password: Option<&str>,
    target_w: f32,
    target_h: f32,
) -> R<Vec<u8>> {
    if target_w <= 0.0 || target_h <= 0.0 {
        return Err("目标页面宽高必须大于 0".into());
    }
    let mut doc = load(pdf, password)?;
    let pages = page_ids(&doc);
    if pages.is_empty() {
        return Err("PDF 没有页面".into());
    }

    let mut transformed_annots = std::collections::HashSet::new();

    for page_id in pages {
        let [bx1, by1, bx2, by2] = page_box(&doc, page_id);
        let w = (bx2 - bx1).abs().max(1.0);
        let h = (by2 - by1).abs().max(1.0);
        let s = (target_w / w).min(target_h / h);
        let dx = (target_w - w * s) * 0.5 - bx1 * s;
        let dy = (target_h - h * s) * 0.5 - by1 * s;

        let open = doc.add_object(Stream::new(
            dictionary! {},
            format!("q\n{s} 0 0 {s} {dx} {dy} cm\n").into_bytes(),
        ));
        let close = doc.add_object(Stream::new(dictionary! {}, b"\nQ\n".to_vec()));
        let mut contents = doc.get_page_contents(page_id);
        contents.insert(0, open);
        contents.push(close);

        // Transform annotations on this page
        let annot_items: Vec<Object> = doc
            .get_dictionary(page_id)
            .ok()
            .and_then(|d| d.get(b"Annots").ok().cloned())
            .and_then(|o| match o {
                Object::Array(v) => Some(v),
                Object::Reference(r) => doc.get_object(r).and_then(Object::as_array).ok().cloned(),
                _ => None,
            })
            .unwrap_or_default();

        for item in annot_items {
            if let Object::Reference(aid) = item {
                if transformed_annots.insert(aid) {
                    if let Ok(Object::Dictionary(ad)) = doc.get_object_mut(aid) {
                        transform_annot_coords(ad, s, dx, dy);
                    }
                }
            }
        }

        let d = doc.get_dictionary_mut(page_id).map_err(e("页面结构异常"))?;
        d.set(
            "Contents",
            Object::Array(contents.into_iter().map(Object::Reference).collect()),
        );
        d.set("MediaBox", nums(&[0.0, 0.0, target_w, target_h]));
        d.set("CropBox", nums(&[0.0, 0.0, target_w, target_h]));
    }

    save(&mut doc)
}

pub use crate::crypto_sig::{
    sign_pdf_pkcs12, verify_signatures, CertSignSpec, SignatureInfo,
};

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

    #[test]
    fn arrange_supports_blank_page_and_duplicate_page() {
        let src = sample();
        let orig_sizes = page_sizes(&src, None).unwrap();
        // [1, 0, 1]: page 1, a blank page matching page 1's size, then a cloned page 1
        let out = arrange_pages(&src, None, &[1, 0, 1]).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        let pages: Vec<_> = doc.get_pages().into_values().collect();
        assert_eq!(pages.len(), 3);
        // Distinct ObjectIds so duplicating a page never aliases in /Kids
        assert_ne!(pages[0], pages[1]);
        assert_ne!(pages[0], pages[2]);
        assert_ne!(pages[1], pages[2]);
        let new_sizes = page_sizes(&out, None).unwrap();
        assert_eq!(new_sizes[0], orig_sizes[0]);
        assert_eq!(new_sizes[1], orig_sizes[0], "blank page inherits neighbor size");
        assert!(doc.get_page_content(pages[1]).unwrap().is_empty());
    }

    #[test]
    fn crop_pages_shrinks_boxes_and_honours_odd_even() {
        let src = sample();
        let orig = page_sizes(&src, None).unwrap();
        let spec = CropSpec {
            margins: [20.0, 10.0, 30.0, 15.0],
            odd_margins: Some([40.0, 10.0, 20.0, 10.0]),
            even_margins: Some([10.0, 20.0, 10.0, 30.0]),
            ..Default::default()
        };
        let out = crop_pages(&src, None, &spec).unwrap();
        let cropped = page_sizes(&out, None).unwrap();
        // Page 1 (odd): width - (10+10)=20, height - (40+20)=60
        assert!((cropped[0].0 - (orig[0].0 - 20.0)).abs() < 0.5);
        assert!((cropped[0].1 - (orig[0].1 - 60.0)).abs() < 0.5);
        // Page 2 (even): width - (20+30)=50, height - (10+10)=20
        assert!((cropped[1].0 - (orig[1].0 - 50.0)).abs() < 0.5);
        assert!((cropped[1].1 - (orig[1].1 - 20.0)).abs() < 0.5);
    }

    #[test]
    fn watermark_text_and_tile_and_under_mode() {
        let src = sample();
        let spec = WatermarkSpec {
            text: "机密 CONFIDENTIAL".into(),
            font_size: 36.0,
            opacity: 0.25,
            rotate: 45.0,
            position: "tile".into(),
            tile_spacing: 160.0,
            under: true,
            pages: vec![1, 2],
            ..Default::default()
        };
        let out = watermark_pdf(&src, None, &spec).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        let p1 = *doc.get_pages().get(&1).unwrap();
        let content = String::from_utf8_lossy(&doc.get_page_content(p1).unwrap()).into_owned();
        assert!(content.starts_with("q\n/SoloWm0 Do"), "under=true must prepend watermark: {content}");
    }

    #[test]
    fn page_numbers_and_bates_formatting() {
        assert_eq!(
            format_page_number("第 {n} 页 / 共 {total} 页", 3, 10, 4, 12),
            "第 3 页 / 共 10 页"
        );
        assert_eq!(
            format_page_number("BATES-{n:06}", 42, 100, 42, 100),
            "BATES-000042"
        );
        let src = sample();
        let spec = PageNumberSpec {
            format: "Page {n} of {total}".into(),
            position: "bottom-outside".into(),
            start_number: 1,
            from_page: 2,
            to_page: 3,
            ..Default::default()
        };
        let out = add_page_numbers(&src, None, &spec).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        let p1 = *doc.get_pages().get(&1).unwrap();
        let p2 = *doc.get_pages().get(&2).unwrap();
        assert!(!String::from_utf8_lossy(&doc.get_page_content(p1).unwrap()).contains("/SoloPn"));
        assert!(String::from_utf8_lossy(&doc.get_page_content(p2).unwrap()).contains("/SoloPn2 Do"));
    }

    #[test]
    fn extract_embedded_images_losslessly() {
        let mut png = Vec::new();
        let img = image::RgbImage::from_pixel(80, 60, image::Rgb([40, 120, 200]));
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let pdf = images_to_pdf(&[png], 72.0).unwrap();
        let extracted = extract_images(&pdf, None, 32).unwrap();
        assert_eq!(extracted.len(), 1);
        assert_eq!(extracted[0].width, 80);
        assert_eq!(extracted[0].height, 60);
        assert_eq!(extracted[0].page, 1);
        assert!(!extracted[0].bytes.is_empty());
    }

    #[test]
    fn sanitize_strips_metadata_and_annotations() {
        let annotated = write_annotations(
            &sample(),
            None,
            &[AnnotSpec {
                page: 1,
                kind: "highlight".into(),
                quads: vec![[50.0, 50.0, 120.0, 65.0]],
                color: [1.0, 0.9, 0.2],
                contents: "secret note".into(),
                ..Default::default()
            }],
        )
        .unwrap();
        let (clean, report) = sanitize_pdf(
            &annotated,
            None,
            &SanitizeSpec {
                metadata: true,
                annotations: true,
                attachments: true,
                javascript_actions: true,
                forms: true,
            },
        )
        .unwrap();
        assert!(report.removed_annotations >= 1);
        let doc = Document::load_mem(&clean).unwrap();
        assert!(doc.trailer.get(b"Info").is_err(), "/Info must be gone");
        let p1 = *doc.get_pages().get(&1).unwrap();
        assert!(doc.get_dictionary(p1).unwrap().get(b"Annots").is_err());
    }

    #[test]
    fn flatten_bakes_annotations_and_removes_annots_dict() {
        let annotated = write_annotations(
            &sample(),
            None,
            &[
                AnnotSpec {
                    page: 1,
                    kind: "rect".into(),
                    quads: vec![[100.0, 100.0, 200.0, 180.0]],
                    color: [0.9, 0.1, 0.1],
                    width: 2.0,
                    ..Default::default()
                },
                AnnotSpec {
                    page: 1,
                    kind: "highlight".into(),
                    quads: vec![[100.0, 300.0, 200.0, 315.0]],
                    color: [1.0, 0.9, 0.2],
                    ..Default::default()
                },
            ],
        )
        .unwrap();
        let flat = flatten_pdf(&annotated, None).unwrap();
        let doc = Document::load_mem(&flat).unwrap();
        let p1 = *doc.get_pages().get(&1).unwrap();
        assert!(doc.get_dictionary(p1).unwrap().get(b"Annots").is_err(), "/Annots must be removed after flatten");
        let content = String::from_utf8_lossy(&doc.get_page_content(p1).unwrap()).into_owned();
        assert!(content.contains("/SoloFlatPage"), "flattened layer must be drawn in page content");
    }

    #[test]
    fn redact_strips_underlying_text_and_paints_opaque_box() {
        // Build a synthetic PDF with two text strings at known coordinates:
        // "KEEP_ME" at (72, 700) and "SECRET_42" at (72, 500)
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let ops = vec![
            op("BT", &[]),
            Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), Object::Real(12.0)]),
            op("Td", &[72.0, 700.0]),
            Operation::new("Tj", vec![Object::string_literal("KEEP_ME")]),
            op("Td", &[0.0, -200.0]),
            Operation::new("Tj", vec![Object::string_literal("SECRET_42")]),
            op("ET", &[]),
        ];
        let content_id = doc.add_object(Stream::new(dictionary! {}, Content { operations: ops }.encode().unwrap()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => nums(&[0.0, 0.0, 612.0, 792.0]),
            "Contents" => content_id,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => text_font(true) } },
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
            }),
        );
        let cat_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", cat_id);
        let src = save(&mut doc).unwrap();

        // Redact the box around (72, 500) where SECRET_42 sits
        let out = redact_pdf(
            &src,
            None,
            &[RedactRect {
                page: 1,
                rect: [65.0, 490.0, 200.0, 520.0],
                color: [0.0, 0.0, 0.0],
                label: "REDACTED".into(),
            }],
            true,
        )
        .unwrap();
        let res_doc = Document::load_mem(&out).unwrap();
        let rp1 = *res_doc.get_pages().get(&1).unwrap();
        let raw_after = String::from_utf8_lossy(&res_doc.get_page_content(rp1).unwrap()).into_owned();
        assert!(raw_after.contains("KEEP_ME"), "unredacted text must survive: {raw_after}");
        assert!(!raw_after.contains("SECRET_42"), "redacted text must be stripped from stream: {raw_after}");
        assert!(raw_after.contains("/SoloRedact1 Do"), "opaque redaction layer must be drawn");
    }

    #[test]
    fn outlines_roundtrip_preserves_hierarchy_and_unicode() {
        let src = sample();
        let tree = vec![
            OutlineNode {
                title: "Chapter 1: Introduction".into(),
                page: 1,
                top: Some(720.0),
                children: vec![
                    OutlineNode {
                        title: "1.1 Overview 概述".into(),
                        page: 2,
                        top: Some(500.0),
                        children: vec![],
                    },
                    OutlineNode {
                        title: "1.2 Deep Dive 深入解析".into(),
                        page: 3,
                        top: None,
                        children: vec![],
                    },
                ],
            },
            OutlineNode {
                title: "第二章：附录 Appendix".into(),
                page: 4,
                top: Some(640.0),
                children: vec![],
            },
        ];
        let with_outlines = set_outlines(&src, None, &tree).unwrap();
        let read_back = get_outlines(&with_outlines, None).unwrap();
        assert_eq!(read_back, tree);

        // Clearing outlines removes /Outlines from catalog
        let cleared = set_outlines(&with_outlines, None, &[]).unwrap();
        assert!(get_outlines(&cleared, None).unwrap().is_empty());
    }

    #[test]
    fn nup_4_pages_into_1_sheet_2x2() {
        let four = arrange_pages(&sample(), None, &[1, 2, 3, 4]).unwrap();
        let spec = NupSpec {
            cols: 2,
            rows: 2,
            landscape: Some(false),
            margin: 18.0,
            gap: 12.0,
            border: true,
        };
        let out = nup_pdf(&four, None, &spec).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        assert_eq!(doc.get_pages().len(), 1, "4 pages in 2x2 N-up must produce 1 sheet");
        let p1 = *doc.get_pages().get(&1).unwrap();
        let content = String::from_utf8_lossy(&doc.get_page_content(p1).unwrap()).into_owned();
        for k in 0..4 {
            assert!(content.contains(&format!("/Fm{k} Do")), "missing /Fm{k} Do in {content}");
        }
    }

    #[test]
    fn booklet_5_pages_padded_to_8_produces_4_landscape_sheets() {
        let five = arrange_pages(&sample(), None, &[1, 2, 3, 4, 1]).unwrap();
        assert_eq!(page_count(&five, None).unwrap(), 5);
        let out = booklet_pdf(&five, None, true).unwrap();
        let sizes = page_sizes(&out, None).unwrap();
        assert_eq!(
            sizes.len(),
            4,
            "5-page PDF padded to 8 pages in saddle-stitch booklet must produce 4 landscape sides"
        );
        for (w, h) in sizes {
            assert!(w > h, "booklet sheet must be landscape, got {w}x{h}");
        }
    }

    #[test]
    fn grayscale_converts_rgb_operators_and_images() {
        let mut png = Vec::new();
        let img = image::RgbImage::from_fn(20, 20, |x, _| {
            if x < 10 {
                image::Rgb([230, 230, 230]) // light gray scan background -> whitened to 255
            } else {
                image::Rgb([200, 40, 40])
            }
        });
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let pdf_with_img = images_to_pdf(&[png], 72.0).unwrap();
        // Add a colored annotation/watermark so content stream has `rg`/`RG`
        let colored = watermark_pdf(
            &pdf_with_img,
            None,
            &WatermarkSpec {
                text: "COLOR".into(),
                color: [0.8, 0.2, 0.1],
                ..Default::default()
            },
        )
        .unwrap();

        let gray = grayscale_pdf(&colored, None, true).unwrap();
        let doc = Document::load_mem(&gray).unwrap();
        let mut found_gray_img = false;
        for obj in doc.objects.values() {
            if let Ok(st) = obj.as_stream() {
                if st.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image") {
                    let cs = st.dict.get(b"ColorSpace").and_then(Object::as_name).unwrap();
                    assert_eq!(cs, b"DeviceGray", "image XObject must be converted to DeviceGray");
                    let raw = st.decompressed_content().unwrap();
                    assert_eq!(raw[0], 255, "light background pixel >= 210 must be whitened to 255");
                    found_gray_img = true;
                }
            }
        }
        assert!(found_gray_img);
    }

    #[test]
    fn normalize_page_size_scales_mixed_pages_to_a4() {
        let mut p1_png = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(100, 200, image::Rgb([255, 255, 255])))
            .write_to(&mut std::io::Cursor::new(&mut p1_png), image::ImageFormat::Png)
            .unwrap();
        let mut p2_png = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(400, 300, image::Rgb([255, 255, 255])))
            .write_to(&mut std::io::Cursor::new(&mut p2_png), image::ImageFormat::Png)
            .unwrap();
        let mixed = images_to_pdf(&[p1_png, p2_png], 72.0).unwrap();
        let orig_sizes = page_sizes(&mixed, None).unwrap();
        assert_ne!(orig_sizes[0], orig_sizes[1]);

        let norm = normalize_page_size(&mixed, None, 595.28, 841.89).unwrap();
        let new_sizes = page_sizes(&norm, None).unwrap();
        assert_eq!(new_sizes.len(), 2);
        for (w, h) in new_sizes {
            assert!((w - 595.28).abs() < 0.1);
            assert!((h - 841.89).abs() < 0.1);
        }
    }
}


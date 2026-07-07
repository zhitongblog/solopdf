// Searchable-PDF writer: injects an INVISIBLE text layer (Tr 3) over each
// OCR'd page, tesseract-style. A 573-byte "GlyphLessFont" (Apache-2.0, from
// tesseract) is embedded as CIDFontType2/Identity-H with an identity
// ToUnicode CMap, so copy/search works for CJK without embedding a real
// multi-megabyte font: extraction reads ToUnicode, never glyphs.

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;

static GLYPHLESS_TTF: &[u8] = include_bytes!("../../assets/glyphless.ttf");

/// One line in PDF user-space points; (x, y) is the box's BOTTOM-LEFT
/// corner in PDF coordinates (y-up). The frontend converts from image
/// space via pdf.js viewport math, so rotation is already handled.
#[derive(Deserialize, Clone, Debug)]
pub struct PageLine {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Deserialize, Debug)]
pub struct PageOcr {
    /// 0-based page index
    pub page: u32,
    pub lines: Vec<PageLine>,
}

fn to_unicode_cmap() -> Vec<u8> {
    // identity bfranges over the BMP, 256 ranges of 256 codes each
    let mut s = String::with_capacity(16 * 1024);
    s.push_str(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n\
         /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
         /CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n\
         1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n",
    );
    for block in 0..=255u32 {
        if block % 100 == 0 {
            let n = (256 - block).min(100);
            s.push_str(&format!("{n} beginbfrange\n"));
        }
        s.push_str(&format!("<{b:02x}00> <{b:02x}ff> <{b:02x}00>\n", b = block));
        if block % 100 == 99 || block == 255 {
            s.push_str("endbfrange\n");
        }
    }
    s.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    s.into_bytes()
}

/// Build the shared font object graph; returns the Type0 font's id.
fn add_glyphless_font(doc: &mut Document) -> ObjectId {
    let font_file = doc.add_object(Stream::new(
        dictionary! { "Length1" => GLYPHLESS_TTF.len() as i64 },
        GLYPHLESS_TTF.to_vec(),
    ));
    let descriptor = doc.add_object(dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => "GlyphLessFont",
        "Flags" => 4,
        "FontBBox" => vec![0.into(), (-128).into(), 500.into(), 800.into()],
        "ItalicAngle" => 0,
        "Ascent" => 800,
        "Descent" => -200,
        "CapHeight" => 800,
        "StemV" => 80,
        "FontFile2" => font_file,
    });
    // every CID → glyph 0
    let mut cid2gid_stream = Stream::new(Dictionary::new(), vec![0u8; 131072]);
    cid2gid_stream.compress().ok();
    let cid2gid = doc.add_object(cid2gid_stream);
    let descendant = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType2",
        "BaseFont" => "GlyphLessFont",
        "CIDSystemInfo" => dictionary! {
            "Registry" => Object::string_literal("Adobe"),
            "Ordering" => Object::string_literal("Identity"),
            "Supplement" => 0,
        },
        "FontDescriptor" => descriptor,
        "DW" => 500,
        "CIDToGIDMap" => cid2gid,
    });
    let mut cmap_stream = Stream::new(Dictionary::new(), to_unicode_cmap());
    cmap_stream.compress().ok();
    let to_unicode = doc.add_object(cmap_stream);
    doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "BaseFont" => "GlyphLessFont",
        "Encoding" => "Identity-H",
        "DescendantFonts" => vec![Object::Reference(descendant)],
        "ToUnicode" => to_unicode,
    })
}

const FONT_KEY: &str = "FSoloOCR";

/// Make sure the page's Resources /Font contains FONT_KEY → font_id,
/// preserving inherited resources by cloning them onto the page if needed.
fn ensure_font_resource(
    doc: &mut Document,
    page_id: ObjectId,
    font_id: ObjectId,
) -> Result<(), String> {
    // find Resources: direct on page, or inherited via Parent chain
    let mut owner = page_id;
    let mut resources_obj: Option<Object> = None;
    loop {
        let dict = doc
            .get_object(owner)
            .and_then(|o| o.as_dict())
            .map_err(|e| e.to_string())?;
        if let Ok(r) = dict.get(b"Resources") {
            resources_obj = Some(r.clone());
            break;
        }
        match dict.get(b"Parent") {
            Ok(Object::Reference(p)) => owner = *p,
            _ => break,
        }
    }

    // materialize a mutable resources dict reference on the page itself
    let mut res_dict: Dictionary = match &resources_obj {
        Some(Object::Reference(r)) => doc
            .get_object(*r)
            .and_then(|o| o.as_dict())
            .map_err(|e| e.to_string())?
            .clone(),
        Some(Object::Dictionary(d)) => d.clone(),
        _ => Dictionary::new(),
    };

    // Font may itself be a reference
    let mut font_dict: Dictionary = match res_dict.get(b"Font") {
        Ok(Object::Reference(r)) => doc
            .get_object(*r)
            .and_then(|o| o.as_dict())
            .map_err(|e| e.to_string())?
            .clone(),
        Ok(Object::Dictionary(d)) => d.clone(),
        _ => Dictionary::new(),
    };
    font_dict.set(FONT_KEY, font_id);
    res_dict.set("Font", font_dict);

    // write the (possibly cloned) resources directly onto the page: never
    // mutate a shared /Resources object other pages point at
    let page_dict = doc
        .get_object_mut(page_id)
        .and_then(|o| o.as_dict_mut())
        .map_err(|e| e.to_string())?;
    page_dict.set("Resources", res_dict);
    Ok(())
}

fn fmt(v: f32) -> String {
    format!("{v:.2}")
}

fn line_ops(l: &PageLine) -> Option<String> {
    let units: Vec<u16> = l.text.encode_utf16().collect();
    if units.is_empty() || l.w <= 0.0 || l.h <= 0.0 {
        return None;
    }
    let size = l.h;
    // glyphless font: every CID advances DW=500/1000 em → natural width
    let natural = 0.5 * size * units.len() as f32;
    let tz = (l.w / natural * 100.0).clamp(1.0, 1000.0);
    let baseline = l.y + 0.2 * l.h; // Descent ≈ -200/1000
    let hex: String = units.iter().map(|u| format!("{u:04x}")).collect();
    Some(format!(
        "/{FONT_KEY} {} Tf {} Tz 1 0 0 1 {} {} Tm <{}> Tj\n",
        fmt(size),
        fmt(tz),
        fmt(l.x),
        fmt(baseline),
        hex
    ))
}

/// Append the invisible text layer for the given pages. `pdf` is the
/// original file's bytes; returns the rewritten document's bytes.
pub fn add_text_layer(pdf: &[u8], pages: &[PageOcr]) -> Result<Vec<u8>, String> {
    let mut doc = Document::load_mem(pdf).map_err(|e| format!("PDF 解析失败: {e}"))?;
    if doc.is_encrypted() {
        return Err("加密的 PDF 暂不支持 OCR 覆盖".into());
    }
    let page_ids: Vec<ObjectId> = doc.page_iter().collect();
    let font_id = add_glyphless_font(&mut doc);

    // one shared "q" guard stream, prepended so any unbalanced CTM the
    // original content leaves behind can be restored before our text
    let q_id = doc.add_object(Stream::new(Dictionary::new(), b"q\n".to_vec()));

    for p in pages {
        let Some(&page_id) = page_ids.get(p.page as usize) else {
            continue;
        };
        let mut ops = String::from("Q q BT 3 Tr\n");
        let mut any = false;
        for l in &p.lines {
            if let Some(op) = line_ops(l) {
                ops.push_str(&op);
                any = true;
            }
        }
        if !any {
            continue;
        }
        ops.push_str("ET Q\n");
        let mut text_stream = Stream::new(Dictionary::new(), ops.into_bytes());
        text_stream.compress().ok();
        let text_id = doc.add_object(text_stream);

        ensure_font_resource(&mut doc, page_id, font_id)?;

        let page_dict = doc
            .get_object_mut(page_id)
            .and_then(|o| o.as_dict_mut())
            .map_err(|e| e.to_string())?;
        let new_contents: Object = match page_dict.get(b"Contents") {
            Ok(Object::Reference(r)) => {
                vec![Object::Reference(q_id), Object::Reference(*r), Object::Reference(text_id)]
                    .into()
            }
            Ok(Object::Array(arr)) => {
                let mut v = Vec::with_capacity(arr.len() + 2);
                v.push(Object::Reference(q_id));
                v.extend(arr.iter().cloned());
                v.push(Object::Reference(text_id));
                v.into()
            }
            _ => vec![Object::Reference(q_id), Object::Reference(text_id)].into(),
        };
        page_dict.set("Contents", new_contents);
    }

    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| format!("PDF 保存失败: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal one-page PDF (no content) so the overlay path can be
    /// exercised without a scanner fixture.
    fn tiny_pdf() -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });
        let pages = dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        };
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    #[test]
    fn overlay_roundtrip() {
        let pdf = tiny_pdf();
        let pages = vec![PageOcr {
            page: 0,
            lines: vec![PageLine {
                text: "你好 SoloPDF 世界".into(),
                x: 72.0,
                y: 700.0,
                w: 200.0,
                h: 16.0,
            }],
        }];
        let out = add_text_layer(&pdf, &pages).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        let text = doc.extract_text(&[1]).unwrap();
        assert!(text.contains("你好"), "extracted: {text}");
        assert!(text.contains("SoloPDF"), "extracted: {text}");
    }
}

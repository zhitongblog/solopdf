//! DjVu reading.
//!
//! DjVu is a fixed-page scan format, so SoloPDF treats it the way it treats a
//! comic: an ordered pile of page images, rendered on demand. That reuses the
//! whole page-flipping reader instead of bolting a second document engine
//! onto the PDF view.
//!
//! Decoding is `djvu-rs` — pure Rust, MIT, no C sources. That combination is
//! why DjVu is here at all: the reference implementation (DjVuLibre) is GPL,
//! which cannot ship in the Mac App Store build.
//!
//! Pages come back as PNG rather than raw pixels because the WebView can put
//! a PNG straight into an <img> without a copy through JS.

use djvu_rs::Document;
use serde::Serialize;

type R<T> = Result<T, String>;

#[derive(Serialize)]
pub struct DjvuInfo {
    pub pages: usize,
    /// display size in pixels at the page's own DPI, per page
    pub sizes: Vec<(u32, u32)>,
    pub bookmarks: Vec<DjvuBookmark>,
}

#[derive(Serialize)]
pub struct DjvuBookmark {
    pub title: String,
    /// 1-based; 0 when the target could not be resolved to a page
    pub page: usize,
    pub depth: u32,
}

fn open(path: &str) -> R<Document> {
    Document::open(path).map_err(|e| format!("无法打开 DjVu: {e}"))
}

pub fn info(path: &str) -> R<DjvuInfo> {
    let doc = open(path)?;
    let pages = doc.page_count();
    let mut sizes = Vec::with_capacity(pages);
    for i in 0..pages {
        match doc.page(i) {
            Ok(p) => sizes.push((p.display_width().max(1), p.display_height().max(1))),
            // one unreadable page must not cost the whole document
            Err(_) => sizes.push((1000, 1400)),
        }
    }
    let mut bookmarks = Vec::new();
    if let Ok(list) = doc.bookmarks() {
        flatten_bookmarks(&list, 0, &mut bookmarks);
    }
    Ok(DjvuInfo { pages, sizes, bookmarks })
}

/// DjVu outlines are a tree whose targets are internal URLs — "#12" for a
/// page number, "#name" for a component. Only the numeric form can be
/// resolved without walking the directory, so anything else lands as page 0
/// and the UI shows it as a title-only entry (same as an unresolvable PDF
/// destination).
fn flatten_bookmarks(list: &[djvu_rs::DjVuBookmark], depth: u32, out: &mut Vec<DjvuBookmark>) {
    for b in list {
        let page = b
            .url
            .trim_start_matches('#')
            .trim_start_matches('+')
            .parse::<usize>()
            .unwrap_or(0);
        out.push(DjvuBookmark { title: b.title.clone(), page, depth });
        flatten_bookmarks(&b.children, depth + 1, out);
    }
}

/// Render one page to PNG, fitted to `width` pixels.
pub fn render_page(path: &str, page: usize, width: u32) -> R<Vec<u8>> {
    let doc = open(path)?;
    if page >= doc.page_count() {
        return Err("页码超出范围".into());
    }
    let p = doc.page(page).map_err(|e| format!("读取页面失败: {e}"))?;
    // clamp: a runaway width on a big scan is an easy way to allocate a
    // gigabyte, and nothing on screen needs more than 4000px
    let width = width.clamp(64, 4000);
    // keep the aspect ratio: render_to_size honours the caller's height
    // exactly, so compute it from the page's own display dimensions
    let (dw, dh) = (p.display_width().max(1), p.display_height().max(1));
    let height = ((width as u64 * dh as u64) / dw as u64).max(1) as u32;
    let pixmap = p
        .render_to_size(width, height)
        .map_err(|e| format!("渲染失败: {e}"))?;
    encode_png(pixmap.width, pixmap.height, &pixmap.data)
}

/// The page's text layer, when the file has one (many scans do).
pub fn page_text(path: &str, page: usize) -> R<String> {
    let doc = open(path)?;
    if page >= doc.page_count() {
        return Ok(String::new());
    }
    let p = doc.page(page).map_err(|e| format!("读取页面失败: {e}"))?;
    Ok(p.text().ok().flatten().unwrap_or_default())
}

/// RGBA → PNG via the `image` crate we already carry for OCR.
fn encode_png(width: u32, height: u32, rgba: &[u8]) -> R<Vec<u8>> {
    if width == 0 || height == 0 || rgba.len() < (width as usize * height as usize * 4) {
        return Err("空白页面".into());
    }
    let img = image::RgbaImage::from_raw(width, height, rgba.to_vec())
        .ok_or_else(|| "像素数据长度不符".to_string())?;
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> String {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-fixtures")
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn reads_page_count_and_sizes() {
        let info = info(&fixture("djvu-sample.djvu")).unwrap();
        assert!(info.pages >= 1, "no pages");
        assert_eq!(info.sizes.len(), info.pages);
        let (w, h) = info.sizes[0];
        assert!(w > 10 && h > 10, "implausible page size {w}x{h}");
    }

    #[test]
    fn renders_a_page_to_png_at_the_requested_width() {
        let png = render_page(&fixture("djvu-sample.djvu"), 0, 600).unwrap();
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a], "not a PNG");
        // the IHDR width sits at bytes 16..20, big-endian
        let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
        assert_eq!(width, 600, "render ignored the requested width");
        // and the aspect ratio must survive
        let height = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
        let info = info(&fixture("djvu-sample.djvu")).unwrap();
        let (dw, dh) = info.sizes[0];
        let expected = (600u64 * dh as u64 / dw as u64) as u32;
        assert!(height.abs_diff(expected) <= 2, "height {height}, expected ~{expected}");
    }

    #[test]
    fn out_of_range_pages_are_an_error_not_a_panic() {
        assert!(render_page(&fixture("djvu-sample.djvu"), 9999, 600).is_err());
        assert_eq!(page_text(&fixture("djvu-sample.djvu"), 9999).unwrap(), "");
    }
}

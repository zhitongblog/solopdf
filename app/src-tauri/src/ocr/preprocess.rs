// 歪斜校正(deskew):扫描/拍摄的文档常带 ±几度的旋转,直接喂 OCR 会明显掉点。
// 做法是经典投影剖面法:把二值化后的暗像素按候选角度投影到行,文字行水平时
// 行直方图的方差最大。粗扫 ±15°(步长 0.5°)后在最优角附近细化到 0.1°。
// 角度显著(≥0.4°)才旋转重编码,数字渲染的页面(角度≈0)零开销直通。

use image::{GrayImage, RgbImage};

const MAX_ANGLE: f32 = 15.0;
const APPLY_THRESHOLD: f32 = 0.4;
const DETECT_SIDE: u32 = 800;
const MAX_SAMPLES: usize = 60_000;

/// 估计歪斜角(度,正 = 顺时针歪)。返回 None = 信号不足(空白页/照片)。
fn estimate_skew(gray: &GrayImage) -> Option<f32> {
    let (w, h) = gray.dimensions();
    // 自适应阈值:均值的 75% —— 对白底黑字的扫描件足够稳
    let mean: u64 = gray.pixels().map(|p| p.0[0] as u64).sum::<u64>() / (w as u64 * h as u64);
    let thresh = ((mean as f32) * 0.75) as u8;

    let mut pts: Vec<(f32, f32)> = Vec::new();
    let step = ((w as usize * h as usize / MAX_SAMPLES).max(1) as f32).sqrt().ceil() as u32;
    let mut y = 0;
    while y < h {
        let mut x = 0;
        while x < w {
            if gray.get_pixel(x, y).0[0] < thresh {
                pts.push((x as f32, y as f32));
            }
            x += step;
        }
        y += step;
    }
    if pts.len() < 200 {
        return None; // 页面基本没字
    }

    let score = |deg: f32| -> f64 {
        let rad = deg.to_radians();
        let (sin, cos) = rad.sin_cos();
        let mut rows = vec![0u32; (h + w) as usize * 2];
        let offset = w as f32; // 保证索引非负
        for &(x, y) in &pts {
            let r = (y * cos - x * sin + offset) as usize;
            if r < rows.len() {
                rows[r] += 1;
            }
        }
        // 方差(去掉均值项即 sum of squares)
        rows.iter().map(|&c| (c as f64) * (c as f64)).sum()
    };

    let mut best = (0.0f32, score(0.0));
    let mut deg = -MAX_ANGLE;
    while deg <= MAX_ANGLE {
        let s = score(deg);
        if s > best.1 {
            best = (deg, s);
        }
        deg += 0.5;
    }
    let mut fine = best;
    let mut d = best.0 - 0.4;
    while d <= best.0 + 0.4 {
        let s = score(d);
        if s > fine.1 {
            fine = (d, s);
        }
        d += 0.1;
    }
    Some(fine.0)
}

/// 逆映射双线性旋转,白底填充(文档背景假设)。
fn rotate_rgb(src: &RgbImage, deg: f32) -> RgbImage {
    let (w, h) = src.dimensions();
    let rad = deg.to_radians();
    let (sin, cos) = rad.sin_cos();
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let mut out = RgbImage::from_pixel(w, h, image::Rgb([255, 255, 255]));
    for oy in 0..h {
        for ox in 0..w {
            let dx = ox as f32 - cx;
            let dy = oy as f32 - cy;
            let sx = dx * cos - dy * sin + cx;
            let sy = dx * sin + dy * cos + cy;
            if sx < 0.0 || sy < 0.0 || sx >= (w - 1) as f32 || sy >= (h - 1) as f32 {
                continue;
            }
            let (x0, y0) = (sx as u32, sy as u32);
            let (fx, fy) = (sx - x0 as f32, sy - y0 as f32);
            let mut px = [0f32; 3];
            for c in 0..3 {
                let p00 = src.get_pixel(x0, y0).0[c] as f32;
                let p10 = src.get_pixel(x0 + 1, y0).0[c] as f32;
                let p01 = src.get_pixel(x0, y0 + 1).0[c] as f32;
                let p11 = src.get_pixel(x0 + 1, y0 + 1).0[c] as f32;
                px[c] = p00 * (1.0 - fx) * (1.0 - fy)
                    + p10 * fx * (1.0 - fy)
                    + p01 * (1.0 - fx) * fy
                    + p11 * fx * fy;
            }
            out.put_pixel(ox, oy, image::Rgb([px[0] as u8, px[1] as u8, px[2] as u8]));
        }
    }
    out
}

/// 需要时校正歪斜:返回 Some((新 JPEG 字节, 校正角度)),不需要时 None。
pub fn deskew(bytes: &[u8]) -> Option<(Vec<u8>, f32)> {
    let img = image::load_from_memory(bytes).ok()?;
    let rgb = img.to_rgb8();
    let (w, h) = rgb.dimensions();
    let scale = DETECT_SIDE as f32 / w.max(h) as f32;
    let gray = if scale < 1.0 {
        image::imageops::resize(
            &image::imageops::grayscale(&rgb),
            ((w as f32 * scale) as u32).max(1),
            ((h as f32 * scale) as u32).max(1),
            image::imageops::FilterType::Triangle,
        )
    } else {
        image::imageops::grayscale(&rgb)
    };
    let angle = estimate_skew(&gray)?;
    if angle.abs() < APPLY_THRESHOLD || angle.abs() > MAX_ANGLE {
        return None;
    }
    let rotated = rotate_rgb(&rgb, angle);
    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
    enc.encode_image(&rotated).ok()?;
    Some((out, angle))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一页“文字行”:横条纹,再旋转 5°,验证 deskew 能校正回来
    #[test]
    fn detects_and_corrects_5_degree_skew() {
        let mut img = RgbImage::from_pixel(1000, 1400, image::Rgb([255, 255, 255]));
        for band in 0..20 {
            let y0 = 100 + band * 60;
            for y in y0..y0 + 18 {
                for x in 100..900 {
                    img.put_pixel(x, y, image::Rgb([20, 20, 20]));
                }
            }
        }
        let skewed = rotate_rgb(&img, -5.0);
        let mut jpg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 90)
            .encode_image(&skewed)
            .unwrap();
        // estimate 返回“校正角”,与施加的歪斜相反(rotate_rgb(-5°) → 校正 +5°)
        let (fixed, angle) = deskew(&jpg).expect("should detect skew");
        assert!((angle - 5.0).abs() < 0.6, "estimated {angle}");
        // 校正后的图不应再检出显著歪斜
        assert!(deskew(&fixed).is_none() || deskew(&fixed).unwrap().1.abs() < 1.0);
    }

    #[test]
    fn straight_page_is_left_alone() {
        let mut img = RgbImage::from_pixel(800, 1000, image::Rgb([255, 255, 255]));
        for band in 0..15 {
            let y0 = 80 + band * 55;
            for y in y0..y0 + 16 {
                for x in 80..720 {
                    img.put_pixel(x, y, image::Rgb([30, 30, 30]));
                }
            }
        }
        let mut jpg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 90)
            .encode_image(&img)
            .unwrap();
        assert!(deskew(&jpg).is_none());
    }
}

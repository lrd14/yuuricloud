//! Pick an accent color from an album cover.
//!
//! The cover is shrunk to a thumbnail and its pixels are grouped by hue. The hue group with the
//! most vivid, mid-brightness pixels wins, and its average color is nudged into a range that
//! reads well as an accent on the dark UI. Black-and-white covers give `None`.

use std::path::Path;

use image::ImageReader;

const HUE_BUCKETS: usize = 24;

pub fn accent_from_cover(path: &Path) -> Option<String> {
    // Embedded covers are cached as ".img", so detect the format from the bytes, not the name.
    let img = ImageReader::open(path).ok()?.with_guessed_format().ok()?.decode().ok()?;
    let thumb = img.thumbnail(48, 48).to_rgb8();

    let mut weight = [0f32; HUE_BUCKETS];
    let mut sums = [[0f32; 3]; HUE_BUCKETS];
    let mut total = 0f32;
    for px in thumb.pixels() {
        let [r, g, b] = px.0.map(|c| c as f32 / 255.0);
        let (h, s, v) = rgb_to_hsv(r, g, b);
        total += 1.0;
        if s < 0.2 || v < 0.18 {
            continue; // greys, blacks and near-whites say nothing about the cover's color
        }
        let w = s * (1.0 - (v - 0.7).abs());
        let i = ((h / 360.0) * HUE_BUCKETS as f32) as usize % HUE_BUCKETS;
        weight[i] += w;
        sums[i][0] += r * w;
        sums[i][1] += g * w;
        sums[i][2] += b * w;
    }

    // Let neighbouring hues help each other so one color split over two buckets still wins.
    let score = |i: usize| weight[i] + 0.5 * (weight[(i + 1) % HUE_BUCKETS] + weight[(i + HUE_BUCKETS - 1) % HUE_BUCKETS]);
    let best = (0..HUE_BUCKETS).max_by(|&a, &b| score(a).total_cmp(&score(b)))?;
    if weight[best] < total * 0.02 {
        return None; // too little color to go on
    }
    let [r, g, b] = sums[best].map(|c| c / weight[best]);

    // Readable on dark glass: fairly saturated, not too dark or too pale.
    let (h, s, l) = rgb_to_hsl(r, g, b);
    let (r, g, b) = hsl_to_rgb(h, s.clamp(0.5, 0.9), l.clamp(0.52, 0.68));
    Some(format!("#{:02x}{:02x}{:02x}", (r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8))
}

fn rgb_to_hsv(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let s = if max > 0.0 { d / max } else { 0.0 };
    (hue(r, g, b, max, d), s, max)
}

fn rgb_to_hsl(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let l = (max + min) / 2.0;
    let s = if d == 0.0 { 0.0 } else { d / (1.0 - (2.0 * l - 1.0).abs()) };
    (hue(r, g, b, max, d), s, l)
}

fn hue(r: f32, g: f32, b: f32, max: f32, d: f32) -> f32 {
    if d == 0.0 {
        return 0.0;
    }
    let h = if max == r {
        (g - b) / d % 6.0
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h * 60.0 + 360.0) % 360.0
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match h as u32 {
        0..=59 => (c, x, 0.0),
        60..=119 => (x, c, 0.0),
        120..=179 => (0.0, c, x),
        180..=239 => (0.0, x, c),
        240..=299 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    (r + m, g + m, b + m)
}

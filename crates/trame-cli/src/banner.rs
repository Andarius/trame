use base64::Engine;
use std::io::Cursor;

const WIDTH: u32 = 1200;
const HEIGHT: u32 = 120;
const ICON: u32 = 96;

/// A project's `data:image/png;base64,…` icon as a short, wide PNG strip (icon on
/// the left of white space): rich photo blocks fill the message width, so a
/// square icon would fill the screen. None for SVG or unreadable icons.
pub fn from_icon(icon: &str) -> Option<Vec<u8>> {
    let data = icon.strip_prefix("data:image/png;base64,")?;
    let png = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    let (w, h, rgba) = decode(&png)?;
    let mut canvas = vec![255u8; (WIDTH * HEIGHT * 3) as usize];
    let offset = (HEIGHT - ICON) / 2;
    for y in 0..ICON {
        for x in 0..ICON {
            // nearest source pixel; icons are small flat logos
            let sx = (x * w / ICON).min(w - 1);
            let sy = (y * h / ICON).min(h - 1);
            let s = ((sy * w + sx) * 4) as usize;
            let alpha = u32::from(rgba[s + 3]);
            let d = (((y + offset) * WIDTH + x + offset) * 3) as usize;
            for c in 0..3 {
                let over = u32::from(rgba[s + c]) * alpha + 255 * (255 - alpha);
                canvas[d + c] = u8::try_from(over / 255).unwrap_or(u8::MAX);
            }
        }
    }
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, WIDTH, HEIGHT);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().ok()?;
    writer.write_image_data(&canvas).ok()?;
    writer.finish().ok()?;
    Some(out)
}

/// Any 8-bit PNG as RGBA.
fn decode(png: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let mut decoder = png::Decoder::new(Cursor::new(png));
    decoder.set_transformations(
        png::Transformations::normalize_to_color8() | png::Transformations::ALPHA,
    );
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;
    let pixels = &buf[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => pixels.to_vec(),
        png::ColorType::GrayscaleAlpha => pixels
            .chunks(2)
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        _ => return None,
    };
    (info.width > 0 && info.height > 0).then_some((info.width, info.height, rgba))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn icon(w: u32, h: u32, rgba: [u8; 4]) -> String {
        let mut png = Vec::new();
        let mut encoder = png::Encoder::new(&mut png, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_image_data(&rgba.repeat((w * h) as usize))
            .unwrap();
        writer.finish().unwrap();
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        )
    }

    #[test]
    fn banner_is_a_wide_strip_with_the_icon_on_the_left() {
        let banner = from_icon(&icon(64, 64, [200, 0, 0, 255])).unwrap();
        let (w, h, px) = decode(&banner).unwrap();
        assert_eq!((w, h), (WIDTH, HEIGHT));
        let at = |x: u32, y: u32| px[((y * w + x) * 4) as usize..][..3].to_vec();
        assert_eq!(at(60, 60), [200, 0, 0]);
        assert_eq!(at(600, 60), [255, 255, 255]);
        // transparency blends onto white
        let faded = from_icon(&icon(8, 8, [0, 0, 0, 0])).unwrap();
        let (_, _, px) = decode(&faded).unwrap();
        assert_eq!(px[((60 * WIDTH + 60) * 4) as usize], 255);
        assert_eq!(from_icon("data:image/svg+xml;base64,PHN2Zy8+"), None);
        assert_eq!(from_icon("data:image/png;base64,not-base64!"), None);
    }
}

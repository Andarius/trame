use serde_json::{Value, json};
use std::{fs, path::Path};

const DEFAULT: (f64, f64) = (1360.0, 880.0);
const MIN: (f64, f64) = (400.0, 300.0);

/// Window geometry in logical pixels, so it survives moving between displays of different scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Geometry {
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) position: Option<(f64, f64)>,
    pub(crate) maximized: bool,
}

impl Default for Geometry {
    fn default() -> Self {
        Self {
            width: DEFAULT.0,
            height: DEFAULT.1,
            position: None,
            maximized: false,
        }
    }
}

/// Reads `window.json` (the legacy Deno app's format, plus `maximized`); missing or unusable sizes fall back to the default.
pub(crate) fn load(path: &Path) -> Geometry {
    let Some(value) = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return Geometry::default();
    };
    let size = value["width"]
        .as_f64()
        .zip(value["height"].as_f64())
        .filter(|(w, h)| *w >= MIN.0 && *h >= MIN.1);
    Geometry {
        width: size.map_or(DEFAULT.0, |s| s.0),
        height: size.map_or(DEFAULT.1, |s| s.1),
        position: value["x"].as_f64().zip(value["y"].as_f64()),
        maximized: value["maximized"].as_bool().unwrap_or(false),
    }
}

/// Writes atomically so a kill mid-write never leaves a truncated file.
pub(crate) fn save(path: &Path, geometry: Geometry) -> std::io::Result<()> {
    let mut value = json!({"width": geometry.width, "height": geometry.height, "maximized": geometry.maximized});
    if let Some((x, y)) = geometry.position {
        value["x"] = json!(x);
        value["y"] = json!(y);
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, value.to_string())?;
    fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_reads_legacy_format_and_rejects_unusable_sizes() {
        let dir = std::env::temp_dir().join(format!("trame-geometry-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("window.json");
        for (content, expected) in [
            (
                r#"{"width":1915,"height":880,"x":0,"y":0}"#,
                Geometry {
                    width: 1915.0,
                    height: 880.0,
                    position: Some((0.0, 0.0)),
                    maximized: false,
                },
            ),
            (r#"{"width":10,"height":10}"#, Geometry::default()),
            ("not json", Geometry::default()),
        ] {
            fs::write(&path, content).unwrap();
            assert_eq!(load(&path), expected, "{content}");
        }
        let saved = Geometry {
            width: 1111.0,
            height: 777.0,
            position: None,
            maximized: true,
        };
        save(&path, saved).unwrap();
        assert_eq!(load(&path), saved);
        fs::remove_dir_all(dir).unwrap();
    }
}

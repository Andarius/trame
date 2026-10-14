use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::{JS_SPACE, js_string, trim, truthy};

static FOLDER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^{JS_SPACE}*\{{\{{trame:folder=([^{{}}\n]*)\}}\}}(?:[ \t]*\{{\{{trame:view=([^{{}}\n]*)\}}\}})?{JS_SPACE}*$")).unwrap()
});
static EMBED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^{JS_SPACE}*\{{\{{trame:embed=([^{{}}\n]*)\}}\}}(?:[ \t]*\{{\{{trame:height=([^{{}}\n]*)\}}\}})?{JS_SPACE}*$")).unwrap()
});
static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(JS_SPACE).unwrap());
static HEIGHT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{1,4}$").unwrap());
static HEADING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^(#{{1,6}}){JS_SPACE}+([^\r\n\u{{2028}}\u{{2029}}]+?){JS_SPACE}*#*{JS_SPACE}*$"
    ))
    .unwrap()
});
static TODO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^({JS_SPACE}*)[-*+]{JS_SPACE}+\[([ xX])\]{JS_SPACE}+([^\r\n\u{{2028}}\u{{2029}}]*)$"
    ))
    .unwrap()
});
static FENCE_START: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^{JS_SPACE}*```")).unwrap());
static FENCE_END: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^{JS_SPACE}*```{JS_SPACE}*$")).unwrap());

pub fn is_folder_block(block: &Value) -> bool {
    block.get("type").and_then(Value::as_str) == Some("folder")
}

pub fn folder_markup(block: &Value) -> String {
    let path = block
        .get("path")
        .map(js_string)
        .unwrap_or_else(|| "undefined".into());
    let view = block
        .get("view")
        .filter(|v| truthy(v) && v.as_str() != Some("list"));
    format!(
        "{{{{trame:folder={path}}}}}{}",
        view.map(|v| format!(" {{{{trame:view={}}}}}", js_string(v)))
            .unwrap_or_default()
    )
}

pub const EMBED_DEFAULT_HEIGHT: u64 = 600;

pub fn is_embed_block(block: &Value) -> bool {
    block.get("type").and_then(Value::as_str) == Some("embed")
}

pub fn embed_markup(block: &Value) -> String {
    let url = block
        .get("url")
        .map(js_string)
        .unwrap_or_else(|| "undefined".into());
    let height = block
        .get("height")
        .and_then(Value::as_u64)
        .filter(|h| *h > 0 && *h != EMBED_DEFAULT_HEIGHT);
    format!(
        "{{{{trame:embed={url}}}}}{}",
        height
            .map(|h| format!(" {{{{trame:height={h}}}}}"))
            .unwrap_or_default()
    )
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(
    inline_js = "export function random_uuid() { return globalThis.crypto.randomUUID(); }"
)]
extern "C" {
    fn random_uuid() -> String;
}

fn uuid() -> Result<String, String> {
    #[cfg(target_arch = "wasm32")]
    {
        Ok(random_uuid())
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::fmt::Write as _;
        use std::io::Read;
        let mut bytes = [0u8; 16];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut bytes))
            .map_err(|e| e.to_string())?;
        bytes[6] = bytes[6] & 0x0f | 0x40;
        bytes[8] = bytes[8] & 0x3f | 0x80;
        let hex = bytes.iter().fold(String::new(), |mut acc, v| {
            let _ = write!(acc, "{v:02x}");
            acc
        });
        Ok(format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        ))
    }
}

fn flush(buf: &mut Vec<String>, out: &mut Vec<Value>) {
    let start = buf.iter().position(|v| !trim(v).is_empty());
    if let Some(start) = start {
        let end = buf.iter().rposition(|v| !trim(v).is_empty()).unwrap();
        let mut block = Map::new();
        block.insert("type".into(), Value::String("text".into()));
        block.insert("text".into(), Value::String(buf[start..=end].join("\n")));
        out.push(Value::Object(block));
    }
    buf.clear();
}

pub fn markdown_to_page_blocks(
    markdown: &str,
    title: &str,
    ids: Option<&Vec<Value>>,
) -> Result<Vec<Value>, String> {
    let normalized = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = Vec::new();
    let mut buf = Vec::new();
    let mut in_fence = false;
    let mut first_content = true;
    for line in normalized.split('\n') {
        if in_fence {
            buf.push(line.to_owned());
            if FENCE_END.is_match(line) {
                in_fence = false;
            }
            continue;
        }
        if FENCE_START.is_match(line) {
            flush(&mut buf, &mut out);
            buf.push(line.to_owned());
            in_fence = true;
            first_content = false;
            continue;
        }
        if let Some(m) = FOLDER.captures(line).filter(|m| !trim(&m[1]).is_empty()) {
            flush(&mut buf, &mut out);
            let mut block = Map::new();
            block.insert("type".into(), Value::String("folder".into()));
            block.insert("path".into(), Value::String(trim(&m[1]).to_owned()));
            let view = m
                .get(2)
                .map(|m| trim(m.as_str()))
                .filter(|v| *v == "gallery")
                .unwrap_or("list");
            block.insert("view".into(), Value::String(view.into()));
            out.push(Value::Object(block));
            first_content = false;
            continue;
        }
        if let Some(m) = EMBED
            .captures(line)
            .filter(|m| trim(&m[1]).starts_with("https://") && !SPACE.is_match(trim(&m[1])))
        {
            flush(&mut buf, &mut out);
            let mut block = Map::new();
            block.insert("type".into(), Value::String("embed".into()));
            block.insert("url".into(), Value::String(trim(&m[1]).to_owned()));
            let height = m
                .get(2)
                .map(|m| trim(m.as_str()))
                .filter(|h| HEIGHT.is_match(h))
                .and_then(|h| h.parse::<u64>().ok())
                .filter(|h| *h > 0 && *h != EMBED_DEFAULT_HEIGHT);
            if let Some(height) = height {
                block.insert("height".into(), Value::from(height));
            }
            out.push(Value::Object(block));
            first_content = false;
            continue;
        }
        if let Some(m) = HEADING.captures(line) {
            flush(&mut buf, &mut out);
            let text = trim(&m[2]);
            if !(first_content && m[1].len() == 1 && text == trim(title)) {
                let mut block = Map::new();
                block.insert("type".into(), Value::String("heading".into()));
                block.insert("text".into(), Value::String(text.to_owned()));
                out.push(Value::Object(block));
            }
            first_content = false;
            continue;
        }
        if let Some(m) = TODO.captures(line) {
            flush(&mut buf, &mut out);
            let indent = (m[1].replace('\t', "  ").encode_utf16().count() / 2).min(4);
            let mut block = Map::new();
            block.insert("type".into(), Value::String("todo".into()));
            block.insert("text".into(), Value::String(m[3].to_owned()));
            block.insert("done".into(), Value::Bool(m[2].eq_ignore_ascii_case("x")));
            if indent != 0 {
                block.insert("indent".into(), Value::from(indent));
            }
            out.push(Value::Object(block));
            first_content = false;
            continue;
        }
        if trim(line).is_empty() {
            flush(&mut buf, &mut out);
            continue;
        }
        buf.push(line.to_owned());
        first_content = false;
    }
    flush(&mut buf, &mut out);
    if ids.is_some_and(|ids| ids.len() != out.len()) {
        return Err("ids count must equal parsed block count".into());
    }
    for (index, block) in out.iter_mut().enumerate() {
        let id = match ids {
            Some(ids) => ids[index].as_str().ok_or("ids must be strings")?.to_owned(),
            None => uuid()?,
        };
        block["id"] = Value::String(id);
    }
    Ok(out)
}

pub fn page_blocks_to_markdown(blocks: &[Value]) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    let mut prev_todo = false;
    for b in blocks {
        if b.is_null() {
            return Err("cannot read properties of null".into());
        }
        if is_folder_block(b) {
            prev_todo = false;
            if b.get("path").is_some_and(truthy) {
                parts.push(folder_markup(b));
            }
            continue;
        }
        if is_embed_block(b) {
            prev_todo = false;
            if b.get("url").is_some_and(truthy) {
                parts.push(embed_markup(b));
            }
            continue;
        }
        let text = || {
            b.get("text")
                .filter(|v| !v.is_null())
                .map(js_string)
                .unwrap_or_default()
        };
        if b.get("type").and_then(Value::as_str) == Some("todo") {
            let indent = b
                .get("indent")
                .filter(|v| !v.is_null())
                .map(|v| {
                    v.as_f64()
                        .or_else(|| v.as_str().and_then(|v| trim(v).parse().ok()))
                        .unwrap_or(0.0)
                })
                .unwrap_or(0.0);
            if indent < 0.0 || !indent.is_finite() || indent > 1_000_000.0 {
                return Err("invalid indentation repeat count".into());
            }
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "range-checked to 0..=1_000_000 above"
            )]
            let indent_count = indent as usize;
            let line = format!(
                "{}- [{}] {}",
                "  ".repeat(indent_count),
                if b.get("done").is_some_and(truthy) {
                    "x"
                } else {
                    " "
                },
                text()
            );
            if prev_todo {
                let last = parts.last_mut().unwrap();
                last.push('\n');
                last.push_str(&line);
            } else {
                parts.push(line);
            }
            prev_todo = true;
            continue;
        }
        prev_todo = false;
        if b.get("type").and_then(Value::as_str) == Some("heading") {
            parts.push(format!("## {}", text()));
        } else if b.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = b.get("text").and_then(Value::as_str) {
                parts.push(text.to_owned());
            }
        }
    }
    Ok(if parts.is_empty() {
        String::new()
    } else {
        format!("{}\n", parts.join("\n\n"))
    })
}

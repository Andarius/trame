use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::{trim, truthy, whitespace};

const MARK: &str = r"\{\{trame:([a-z_][a-z0-9_]*)=([^{}\n]*)\}\}";
const ORDER: [&str; 4] = ["due", "created_at", "updated_at", "completed_at"];
pub const UPDATED_CAP: usize = 5;
static READ: LazyLock<Regex> = LazyLock::new(|| Regex::new(MARK).unwrap());
static STRIP: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("[ \\t]*{MARK}")).unwrap());

fn inherited(key: &str) -> bool {
    matches!(
        key,
        "constructor"
            | "__proto__"
            | "toString"
            | "toLocaleString"
            | "valueOf"
            | "hasOwnProperty"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "__defineGetter__"
            | "__defineSetter__"
            | "__lookupGetter__"
            | "__lookupSetter__"
    )
}

pub fn read_marks(text: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for m in READ.captures_iter(text) {
        // Deno's disabled prototype getter returns undefined, so reading creates an own mark.
        let absent = !inherited(&m[1]) || (!cfg!(target_arch = "wasm32") && &m[1] == "__proto__");
        if absent && !out.contains_key(&m[1]) {
            out.insert(m[1].to_owned(), Value::String(trim(&m[2]).to_owned()));
        }
    }
    out
}

pub fn strip_marks(text: &str) -> String {
    STRIP.replace_all(text, "").into_owned()
}

pub fn set_mark(text: &str, key: &str, value: &str) -> String {
    if inherited(key) || read_marks(text).contains_key(key) {
        return text.to_owned();
    }
    let space = if text.is_empty() || text.chars().last().is_some_and(whitespace) {
        ""
    } else {
        " "
    };
    format!("{text}{space}{{{{trame:{key}={value}}}}}")
}

pub fn read_list(text: &str, key: &str) -> Vec<String> {
    read_marks(text)
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .split(',')
        .map(trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect()
}

pub fn remove_mark(text: &str, key: &str) -> String {
    let pattern = format!(r"[ \t]*\{{\{{trame:{key}=[^{{}}\n]*\}}\}}");
    Regex::new(&pattern)
        .expect("mark key must be a valid regular expression")
        .replace_all(text, "")
        .into_owned()
}

pub fn write_mark(text: &str, key: &str, value: &str) -> String {
    let stripped = remove_mark(text, key);
    if value.is_empty() {
        stripped
    } else {
        set_mark(&stripped, key, value)
    }
}

fn merge_days(mut days: Vec<String>) -> String {
    days.sort_by_cached_key(|s| s.encode_utf16().collect::<Vec<_>>());
    days.dedup();
    days[days.len().saturating_sub(UPDATED_CAP)..].join(",")
}

pub fn touch_todo(text: &str, day: &str) -> String {
    if read_marks(text).get("created_at").and_then(Value::as_str) == Some(day) {
        return text.to_owned();
    }
    let mut days = read_list(text, "updated_at");
    days.push(day.to_owned());
    write_mark(text, "updated_at", &merge_days(days))
}

pub fn carry_marks(from: &str, to: &str) -> String {
    let mut out = to.to_owned();
    let have = read_marks(to);
    for (key, value) in read_marks(from) {
        let value = value.as_str().unwrap();
        if key == "updated_at" {
            let mut days = value
                .split(',')
                .map(trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>();
            days.extend(read_list(&out, &key));
            out = write_mark(&out, &key, &merge_days(days));
        } else if !have.contains_key(&key) && !inherited(&key) {
            out = set_mark(&out, &key, value);
        }
    }
    out
}

pub fn normalize_marks(text: &str) -> String {
    let marks = read_marks(text);
    if marks.is_empty() {
        return text.to_owned();
    }
    let stripped = strip_marks(text);
    let mut out = stripped.trim_end_matches(whitespace).to_owned();
    for key in ORDER
        .into_iter()
        .filter(|key| marks.contains_key(*key))
        .chain(
            marks
                .keys()
                .map(String::as_str)
                .filter(|key| !ORDER.contains(key)),
        )
    {
        out = set_mark(&out, key, marks[key].as_str().unwrap());
    }
    out
}

pub fn stamp_todo_marks(blocks: &[Value], day: &str) -> Vec<Value> {
    blocks
        .iter()
        .map(|b| {
            let Some(text) = b
                .get("text")
                .and_then(Value::as_str)
                .filter(|_| b.get("type").and_then(Value::as_str) == Some("todo"))
            else {
                return b.clone();
            };
            let next = set_mark(text, "created_at", day);
            let next = if b.get("done").is_some_and(truthy) {
                set_mark(&next, "completed_at", day)
            } else {
                remove_mark(&next, "completed_at")
            };
            let mut out = b.clone();
            out["text"] = Value::String(normalize_marks(&next));
            out
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_order_and_whitespace() {
        assert_eq!(
            normalize_marks("a {{trame:z=1}}\u{feff}{{trame:due=2}} {{trame:a=3}}"),
            "a {{trame:due=2}} {{trame:z=1}} {{trame:a=3}}"
        );
        assert_eq!(trim("\u{0085}x\u{feff}"), "\u{0085}x");
        assert!(read_marks("{{trame:constructor=x}}").is_empty());
        assert_eq!(
            read_marks("{{trame:__proto__=y}}").contains_key("__proto__"),
            !cfg!(target_arch = "wasm32")
        );
    }
}

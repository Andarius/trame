pub mod page_markdown;
pub mod page_merge;
pub mod todo_marks;

use serde_json::Value;
use wasm_bindgen::prelude::*;

// JavaScript whitespace excludes NEL and includes the byte-order mark.
pub const JS_SPACE: &str = r"[\x09-\x0d\x20\u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";

pub fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn trim(text: &str) -> &str {
    text.trim_matches(whitespace)
}

pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|v| v != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}

pub fn js_string(value: &Value) -> String {
    match value {
        Value::String(v) => v.clone(),
        Value::Null => "null".into(),
        Value::Array(v) => v
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => value.to_string(),
    }
}

pub fn evaluate_value(request: &Value) -> Result<Value, String> {
    let op = request["op"].as_str().ok_or("op must be a string")?;
    let args = request["args"].as_array().ok_or("args must be an array")?;
    let string = |i: usize| {
        args.get(i)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("argument {i} must be a string"))
    };
    let array = |i: usize| {
        args.get(i)
            .and_then(Value::as_array)
            .ok_or_else(|| format!("argument {i} must be an array"))
    };
    if matches!(op, "removeMark" | "writeMark") {
        regex::Regex::new(&format!(
            r"[ \t]*\{{\{{trame:{}=[^{{}}\n]*\}}\}}",
            string(1)?
        ))
        .map_err(|e| e.to_string())?;
    }
    Ok(match op {
        "markdownToPageBlocks" => Value::Array(page_markdown::markdown_to_page_blocks(
            string(0)?,
            args.get(1).and_then(Value::as_str).unwrap_or(""),
            request.get("ids").and_then(Value::as_array),
        )?),
        "pageBlocksToMarkdown" => Value::String(page_markdown::page_blocks_to_markdown(array(0)?)?),
        "isFolderBlock" => Value::Bool(page_markdown::is_folder_block(
            args.first().ok_or("missing argument")?,
        )),
        "folderMarkup" => Value::String(page_markdown::folder_markup(
            args.first().ok_or("missing argument")?,
        )),
        "isEmbedBlock" => Value::Bool(page_markdown::is_embed_block(
            args.first().ok_or("missing argument")?,
        )),
        "embedMarkup" => Value::String(page_markdown::embed_markup(
            args.first().ok_or("missing argument")?,
        )),
        "mergePageBlocks" => Value::Array(page_merge::merge_page_blocks(array(0)?, array(1)?)),
        "readMarks" => Value::Object(todo_marks::read_marks(string(0)?)),
        "stripMarks" => Value::String(todo_marks::strip_marks(string(0)?)),
        "setMark" => Value::String(todo_marks::set_mark(string(0)?, string(1)?, string(2)?)),
        "readList" => serde_json::json!(todo_marks::read_list(string(0)?, string(1)?)),
        "writeMark" => Value::String(todo_marks::write_mark(string(0)?, string(1)?, string(2)?)),
        "touchTodo" => Value::String(todo_marks::touch_todo(string(0)?, string(1)?)),
        "removeMark" => Value::String(todo_marks::remove_mark(string(0)?, string(1)?)),
        "carryMarks" => Value::String(todo_marks::carry_marks(string(0)?, string(1)?)),
        "normalizeMarks" => Value::String(todo_marks::normalize_marks(string(0)?)),
        "stampTodoMarks" => Value::Array(todo_marks::stamp_todo_marks(array(0)?, string(1)?)),
        "todayMark" => {
            let n = |i: usize| {
                args.get(i)
                    .and_then(Value::as_i64)
                    .ok_or("date components must be integers")
            };
            Value::String(format!("{}-{:02}-{:02}", n(0)?, n(1)?, n(2)?))
        }
        _ => return Err(format!("unknown operation: {op}")),
    })
}

#[wasm_bindgen]
pub fn evaluate(input: &str) -> Result<String, JsValue> {
    let request = serde_json::from_str(input).map_err(|e| JsValue::from_str(&e.to_string()))?;
    evaluate_value(&request)
        .map(|value| value.to_string())
        .map_err(|e| JsValue::from_str(&e))
}

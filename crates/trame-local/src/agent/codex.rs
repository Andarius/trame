use serde_json::{Value, json};
use std::fmt::Write;

/// One decoded line of `codex app-server` (JSON-RPC without the `jsonrpc` field).
#[derive(Debug, PartialEq)]
pub(crate) enum Msg {
    /// the answer to one of our requests
    Response {
        id: Value,
        result: Value,
        error: Option<String>,
    },
    /// a request Codex blocks on: approvals and questions
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

pub(crate) fn decode(line: &str) -> Option<Msg> {
    let v: Value = serde_json::from_str(line).ok()?;
    let obj = v.as_object()?;
    let method = obj.get("method").and_then(Value::as_str).map(str::to_owned);
    Some(match (obj.get("id"), method) {
        (Some(id), Some(method)) => Msg::Request {
            id: id.clone(),
            method,
            params: v["params"].clone(),
        },
        (None, Some(method)) => Msg::Notification {
            method,
            params: v["params"].clone(),
        },
        (Some(id), None) => Msg::Response {
            id: id.clone(),
            result: v["result"].clone(),
            error: obj.get("error").map(|e| {
                e["message"]
                    .as_str()
                    .map_or_else(|| e.to_string(), str::to_owned)
            }),
        },
        (None, None) => return None,
    })
}

pub(crate) fn request(id: u64, method: &str, params: &Value) -> Value {
    json!({"id":id,"method":method,"params":params})
}

pub(crate) fn notify(method: &str) -> Value {
    json!({"method":method})
}

pub(crate) fn respond(id: &Value, result: &Value) -> Value {
    json!({"id":id,"result":result})
}

pub(crate) fn refuse(id: &Value, message: &str) -> Value {
    json!({"id":id,"error":{"code":-32601,"message":message}})
}

pub(crate) fn initialize() -> Value {
    json!({"clientInfo":{"name":"trame","title":"Trame","version":env!("CARGO_PKG_VERSION")},"capabilities":null})
}

/// `thread/start` in `cwd`, or `thread/resume` of `resume`; Codex asks before leaving the workspace.
pub(crate) fn thread(cwd: &str, resume: Option<&str>) -> (&'static str, Value) {
    let mut params = json!({"cwd":cwd,"approvalPolicy":"on-request","sandbox":"workspace-write"});
    match resume {
        Some(id) => {
            params["threadId"] = id.into();
            ("thread/resume", params)
        }
        None => ("thread/start", params),
    }
}

pub(crate) fn user_input(text: &str) -> Value {
    json!([{"type":"text","text":text,"text_elements":[]}])
}

/// A file change as the patch text `apply_patch` items carry, so it renders as a diff.
pub(crate) fn patch(changes: &Value) -> String {
    let mut out = String::new();
    for c in changes.as_array().into_iter().flatten() {
        let _ = writeln!(
            out,
            "*** Update File: {}",
            c["path"].as_str().unwrap_or_default()
        );
        for line in c["diff"].as_str().unwrap_or_default().lines() {
            if (line.starts_with('+') && !line.starts_with("+++"))
                || (line.starts_with('-') && !line.starts_with("---"))
            {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    out
}

/// A completed thread item as history items: the same shapes the Claude transcript reader produces.
pub(crate) fn items(item: &Value) -> Vec<Value> {
    let id = item["id"].as_str().unwrap_or_default();
    let s = |k: &str| item[k].as_str().unwrap_or_default().to_owned();
    match item["type"].as_str() {
        Some("agentMessage") if !s("text").trim().is_empty() => {
            vec![json!({"kind":"assistant","text":s("text"),"truncated":false})]
        }
        Some("reasoning") => {
            let text = item["summary"]
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![json!({"kind":"thinking","text":text,"truncated":false})]
            }
        }
        Some("commandExecution") => {
            let failed = item["exitCode"].as_i64().is_some_and(|c| c != 0)
                || matches!(item["status"].as_str(), Some("failed" | "declined"));
            vec![
                json!({"kind":"tool","id":id,"name":"exec_command","input":{"cmd":s("command")}}),
                json!({"kind":"result","toolId":id,"text":s("aggregatedOutput"),"error":failed,"truncated":false}),
            ]
        }
        Some("fileChange") => vec![
            json!({"kind":"tool","id":id,"name":"apply_patch","input":{"input":patch(&item["changes"])}}),
            json!({"kind":"result","toolId":id,"text":s("status"),"error":item["status"] != "completed","truncated":false}),
        ],
        Some("mcpToolCall") => vec![
            json!({"kind":"tool","id":id,"name":s("tool"),"input":item["arguments"]}),
            json!({"kind":"result","toolId":id,"text":s("status"),"error":item["status"] == "failed","truncated":false}),
        ],
        Some("webSearch") => {
            vec![json!({"kind":"tool","id":id,"name":"web_search","input":{"query":s("query")}})]
        }
        Some("contextCompaction") => vec![json!({"kind":"note","text":"context compacted"})],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_tells_responses_requests_and_notifications_apart() {
        for (line, want) in [
            (
                r#"{"id":1,"result":{"ok":true}}"#,
                Some(Msg::Response {
                    id: json!(1),
                    result: json!({"ok":true}),
                    error: None,
                }),
            ),
            (
                r#"{"id":3,"error":{"code":-1,"message":"no turn"}}"#,
                Some(Msg::Response {
                    id: json!(3),
                    result: Value::Null,
                    error: Some("no turn".into()),
                }),
            ),
            (
                r#"{"id":"r9","method":"item/fileChange/requestApproval","params":{"itemId":"i"}}"#,
                Some(Msg::Request {
                    id: json!("r9"),
                    method: "item/fileChange/requestApproval".into(),
                    params: json!({"itemId":"i"}),
                }),
            ),
            (
                r#"{"method":"turn/started","params":{"turn":{"id":"t"}},"emittedAtMs":1}"#,
                Some(Msg::Notification {
                    method: "turn/started".into(),
                    params: json!({"turn":{"id":"t"}}),
                }),
            ),
            ("{}", None),
            ("nope", None),
        ] {
            assert_eq!(decode(line), want, "{line}");
        }
    }

    #[test]
    fn items_map_codex_work_to_history_items() {
        let cmd = json!({"type":"commandExecution","id":"c1","command":"npm test","aggregatedOutput":"1 failed","exitCode":1,"status":"completed"});
        let out = items(&cmd);
        assert_eq!(out[0]["input"]["cmd"], "npm test");
        assert_eq!(
            (out[1]["text"].clone(), out[1]["error"].clone()),
            (json!("1 failed"), json!(true))
        );
        let change = json!({"type":"fileChange","id":"f1","status":"completed","changes":[
            {"path":"src/a.ts","kind":{"type":"update"},"diff":"--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n"}
        ]});
        assert_eq!(
            items(&change)[0]["input"]["input"],
            "*** Update File: src/a.ts\n-old\n+new\n"
        );
        let said = json!({"type":"agentMessage","id":"m","text":"done"});
        assert_eq!(items(&said)[0]["kind"], "assistant");
        assert_eq!(
            items(&json!({"type":"userMessage","id":"u"})),
            Vec::<Value>::new()
        );
    }
}

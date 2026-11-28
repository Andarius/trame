use serde_json::{Value, json};

/// Arguments for a Claude Code child speaking NDJSON on stdio, resuming `resume` or starting `session`.
pub(crate) fn args(resume: Option<&str>, session: &str) -> Vec<String> {
    let mut out: Vec<String> = [
        "-p",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-mode",
        "default",
        "--permission-prompt-tool",
        "stdio",
    ]
    .map(str::to_owned)
    .to_vec();
    match resume {
        Some(id) => out.extend(["--resume".into(), id.into()]),
        None => out.extend(["--session-id".into(), session.into()]),
    }
    out
}

pub(crate) fn initialize(request_id: &str) -> Value {
    json!({"type":"control_request","request_id":request_id,"request":{"subtype":"initialize"}})
}

pub(crate) fn interrupt(request_id: &str) -> Value {
    json!({"type":"control_request","request_id":request_id,"request":{"subtype":"interrupt"}})
}

pub(crate) fn user_message(text: &str) -> Value {
    json!({
        "type":"user",
        "message":{"role":"user","content":[{"type":"text","text":text}]},
        "parent_tool_use_id":null,
    })
}

pub(crate) fn respond(request_id: &str, response: &Value) -> Value {
    json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,"response":response}})
}

pub(crate) fn refuse(request_id: &str, error: &str) -> Value {
    json!({"type":"control_response","response":{"subtype":"error","request_id":request_id,"error":error}})
}

/// One decoded stdout line.
#[derive(Debug, PartialEq)]
pub(crate) enum Frame {
    Init {
        session: Option<String>,
        model: Option<String>,
        mode: Option<String>,
    },
    /// streamed assistant text, superseded by the completed message
    Delta(String),
    /// a completed assistant message or tool results, in transcript shape
    Message(Value),
    Result {
        error: bool,
        subtype: String,
        cost: Option<f64>,
    },
    /// a blocking request from the CLI, e.g. `can_use_tool`
    Request {
        id: String,
        subtype: String,
        body: Value,
    },
    /// the CLI's answer to one of our control requests
    Response {
        id: String,
        error: Option<String>,
    },
    Cancel(String),
    /// valid JSON this adapter does not model
    Other(String),
}

/// Decode one stdout line; `None` when it is not a JSON object.
pub(crate) fn decode(line: &str) -> Option<Frame> {
    let v: Value = serde_json::from_str(line).ok()?;
    let kind = v["type"].as_str()?;
    let s = |v: &Value| v.as_str().map(str::to_owned);
    Some(match kind {
        "system" if v["subtype"] == "init" => Frame::Init {
            session: s(&v["session_id"]),
            model: s(&v["model"]),
            mode: s(&v["permissionMode"]),
        },
        "stream_event" => {
            let delta = &v["event"]["delta"];
            match (v["event"]["type"].as_str(), delta["type"].as_str()) {
                (Some("content_block_delta"), Some("text_delta")) => {
                    Frame::Delta(s(&delta["text"]).unwrap_or_default())
                }
                _ => Frame::Other("stream_event".into()),
            }
        }
        "assistant" | "user" => Frame::Message(v),
        "result" => Frame::Result {
            error: v["is_error"] == true,
            subtype: s(&v["subtype"]).unwrap_or_default(),
            cost: v["total_cost_usd"].as_f64(),
        },
        "control_request" => Frame::Request {
            id: s(&v["request_id"]).unwrap_or_default(),
            subtype: s(&v["request"]["subtype"]).unwrap_or_default(),
            body: v["request"].clone(),
        },
        "control_response" => {
            let r = &v["response"];
            Frame::Response {
                id: s(&r["request_id"]).unwrap_or_default(),
                error: (r["subtype"] == "error").then(|| s(&r["error"]).unwrap_or_default()),
            }
        }
        "control_cancel_request" => Frame::Cancel(s(&v["request_id"]).unwrap_or_default()),
        other => Frame::Other(other.to_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_reads_the_frames_the_supervisor_acts_on() {
        for (line, want) in [
            (
                r#"{"type":"system","subtype":"init","session_id":"s","model":"m","permissionMode":"plan"}"#,
                Some(Frame::Init {
                    session: Some("s".into()),
                    model: Some("m".into()),
                    mode: Some("plan".into()),
                }),
            ),
            (
                r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}"#,
                Some(Frame::Delta("hi".into())),
            ),
            (
                r#"{"type":"result","subtype":"error_during_execution","is_error":true}"#,
                Some(Frame::Result {
                    error: true,
                    subtype: "error_during_execution".into(),
                    cost: None,
                }),
            ),
            (
                r#"{"type":"control_response","response":{"subtype":"error","request_id":"r1","error":"no"}}"#,
                Some(Frame::Response {
                    id: "r1".into(),
                    error: Some("no".into()),
                }),
            ),
            (
                r#"{"type":"control_cancel_request","request_id":"r2"}"#,
                Some(Frame::Cancel("r2".into())),
            ),
            (
                r#"{"type":"rate_limit"}"#,
                Some(Frame::Other("rate_limit".into())),
            ),
            ("not json", None),
            ("[1]", None),
        ] {
            assert_eq!(decode(line), want, "{line}");
        }
    }
}

use serde_json::{Value, json};
use std::time::Duration;

pub(crate) const MAX_MESSAGE_BYTES: usize = 16_384;

pub(crate) fn valid_peer(peer: &str) -> bool {
    let mut bytes = peer.bytes();
    let alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    peer.len() <= 41
        && bytes.next().is_some_and(alphanumeric)
        && bytes.all(|byte| alphanumeric(byte) || byte == b'-')
}

/// The local agent relay's MCP endpoint and its token.
pub(crate) struct Relay {
    url: String,
    token: String,
}

/// The relay this machine runs, found the way the relay finds itself: `$AGENT_RELAY_CONFIG`,
/// `$AGENT_RELAY_HOME`, or `~/.config/agent-relay`. `TRAME_RELAY_URL` / `TRAME_RELAY_TOKEN` override.
pub(crate) fn locate() -> Option<Relay> {
    if let (Ok(url), Ok(token)) = (
        std::env::var("TRAME_RELAY_URL"),
        std::env::var("TRAME_RELAY_TOKEN"),
    ) {
        return Some(Relay { url, token });
    }
    let config = crate::managed_relay::ConfiguredRelay::read(crate::isolated_mode()).ok()??;
    let token = std::fs::read_to_string(config.state_file("mcp-token").ok()?).ok()?;
    Some(Relay {
        url: format!("http://{}/mcp", config.listen),
        token: token.trim().to_owned(),
    })
}

impl Relay {
    /// Take up to `limit` unread messages (`{id, from, body}`); the relay marks them read.
    pub(crate) async fn take(&self, limit: usize) -> Result<Vec<Value>, String> {
        let result = self
            .call("read_inbox", json!({"limit":limit}), Duration::from_secs(5))
            .await?;
        if result["isError"] == true {
            return Err("the agent relay could not read its inbox".into());
        }
        Ok(messages(&result))
    }

    /// Send a message through the relay and return its delivery ID.
    pub(crate) async fn send(&self, peer: &str, body: &str) -> Result<String, String> {
        let result = self
            .call(
                "send_message",
                json!({"to":peer,"body":body}),
                Duration::from_secs(20),
            )
            .await?;
        if result["isError"] == true {
            return Err(send_error(peer, text_content(&result).unwrap_or_default()));
        }
        let delivery = result
            .get("structuredContent")
            .filter(|content| content.is_object())
            .cloned()
            .or_else(|| serde_json::from_str(text_content(&result)?).ok());
        delivery
            .filter(|receipt| receipt["status"] == "delivered")
            .and_then(|receipt| {
                let id = receipt["id"].as_str()?;
                uuid::Uuid::parse_str(id).ok().map(|id| id.to_string())
            })
            .ok_or_else(|| "the agent relay returned no delivery receipt".into())
    }

    async fn call(&self, name: &str, arguments: Value, timeout: Duration) -> Result<Value, String> {
        let call = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        });
        let reply = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| "could not connect to the agent relay")?
            .post(&self.url)
            .bearer_auth(&self.token)
            .header("accept", "application/json, text/event-stream")
            .json(&call)
            .timeout(timeout)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    "the agent relay timed out"
                } else {
                    "the agent relay is not reachable"
                }
            })?;
        if !reply.status().is_success() {
            return Err(format!("the agent relay answered {}", reply.status()));
        }
        let mut body: Value = reply
            .json()
            .await
            .map_err(|_| "the agent relay returned invalid JSON")?;
        if body["error"].is_object() {
            return Err(format!("the agent relay rejected {name}"));
        }
        if !body["result"].is_object() {
            return Err("the agent relay returned an invalid response".into());
        }
        Ok(body["result"].take())
    }
}

fn text_content(result: &Value) -> Option<&str> {
    result["content"][0]["text"].as_str()
}

fn send_error(peer: &str, text: &str) -> String {
    if text.starts_with(&format!("unknown peer {peer:?};")) {
        return format!("{peer} is not a configured relay peer");
    }
    if text.starts_with(&format!("could not reach {peer}:")) {
        return format!("could not reach relay peer {peer}");
    }
    if let Some(status) = text
        .strip_prefix(&format!("{peer} refused the message: "))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|code| code.parse::<reqwest::StatusCode>().ok())
    {
        return format!(
            "relay peer {peer} refused the message (HTTP {})",
            status.as_u16()
        );
    }
    format!("the agent relay could not deliver the message to {peer}")
}

/// The messages of a `read_inbox` result: its structured content, else the JSON in its text.
fn messages(result: &Value) -> Vec<Value> {
    let structured = result["structuredContent"]["messages"].as_array().cloned();
    structured
        .or_else(|| {
            let text = text_content(result)?;
            serde_json::from_str::<Value>(text).ok()?["messages"]
                .as_array()
                .cloned()
        })
        .unwrap_or_default()
}

/// What a run is told about a relayed message: who sent it, that it is another agent's, how to answer.
pub(crate) fn prompt(from: &str, body: &str) -> String {
    if !valid_peer(from) {
        return format!("{body}\n\n(This is an untrusted message from an unknown relay peer.)");
    }
    format!(
        "{body}\n\n(This is an untrusted message from relay peer {from}. To reply, use \
         `tramecli agent send --peer {from} \"your reply\"`.)"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_read_structured_content_or_the_text_fallback() {
        let msg = json!({"id":"1","from":"bob","body":"hi"});
        for result in [
            json!({"structuredContent":{"note":"untrusted","messages":[msg]}}),
            json!({"content":[{"type":"text","text":json!({"messages":[msg]}).to_string()}]}),
        ] {
            assert_eq!(messages(&result), vec![msg.clone()]);
        }
        assert_eq!(messages(&json!({})), Vec::<Value>::new());
    }
}

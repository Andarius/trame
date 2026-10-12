use crate::{
    comment::add_comment,
    page::{resolve_by_title, write_page},
    refs::{RefKind, parse_session_ref},
    target::{Target, resolve_target},
};
use anyhow::{Result, bail};
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    transport::stdio,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;

#[derive(Clone)]
pub struct TrameMcp;
static MCP_CONTRACTS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("mcp-contracts.json")).expect("generated MCP contracts")
});
fn tool(name: &'static str, fields: &[(&str, &str, bool)]) -> Tool {
    let mut properties = Map::new();
    let mut required = Vec::new();
    for (field, kind, mandatory) in fields {
        properties.insert((*field).into(), json!({"type":kind}));
        if *mandatory {
            required.push(*field);
        }
    }
    if matches!(name, "trame_track" | "trame_set_status") {
        properties.insert(
            "status".into(),
            json!({"type":"string","enum":["todo","active","paused","blocked","done"]}),
        );
    }
    if name == "trame_track" {
        properties.insert(
            "tags".into(),
            json!({"type":"array","items":{"type":"string","minLength":1}}),
        );
        properties.insert("links".into(), json!({"type":"array","items":{"type":"object","properties":{"page_id":{"type":"string"},"block_id":{"type":"string"},"anchor":{"type":"string"}},"required":["page_id"]}}));
    }
    if name == "trame_move_page" {
        properties.insert("parent_id".into(), json!({"type":["string","null"]}));
    }
    if name == "trame_add_comment" {
        properties.insert("meta".into(), json!({"type":"object","properties":{"model":{"type":"string"},"in":{"type":"number"},"out":{"type":"number"},"ms":{"type":"number"}},"required":["model"]}));
    }
    for (field, description) in MCP_CONTRACTS["fieldDescriptions"][name]
        .as_object()
        .into_iter()
        .flat_map(|fields| fields.iter())
    {
        if let Some(property) = properties.get_mut(field).and_then(Value::as_object_mut) {
            property.insert("description".into(), description.clone());
        }
    }
    let schema = json!({"type":"object","properties":properties,"required":required});
    let description = MCP_CONTRACTS["descriptions"][name]
        .as_str()
        .expect("generated MCP tool description")
        .to_owned();
    Tool::new(name, description, schema.as_object().unwrap().clone())
}
fn tools() -> Vec<Tool> {
    vec![
        tool("trame_capabilities", &[]),
        tool("trame_board", &[]),
        tool(
            "trame_session",
            &[("session", "string", true), ("events", "number", false)],
        ),
        tool(
            "trame_track",
            &[
                ("title", "string", true),
                ("status", "string", false),
                ("client", "string", false),
                ("story", "string", false),
                ("tags", "array", false),
                ("repo_path", "string", false),
                ("branch", "string", false),
                ("next_step", "string", false),
                ("links", "array", false),
                ("pr_url", "string", false),
                ("summary", "string", false),
                ("model", "string", false),
                ("tokens", "number", false),
                ("cost_usd", "number", false),
                ("agent_name", "string", false),
            ],
        ),
        tool(
            "trame_set_status",
            &[("id", "string", true), ("status", "string", true)],
        ),
        tool(
            "trame_new_story",
            &[
                ("title", "string", true),
                ("brief", "string", false),
                ("client", "string", false),
            ],
        ),
        tool(
            "trame_create_page",
            &[
                ("title", "string", true),
                ("markdown", "string", false),
                ("parent_id", "string", false),
                ("repo_path", "string", false),
                ("icon", "string", false),
            ],
        ),
        tool(
            "trame_update_page",
            &[
                ("page_id", "string", false),
                ("page_title", "string", false),
                ("session_id", "string", false),
                ("markdown", "string", true),
                ("title", "string", false),
            ],
        ),
        tool(
            "trame_move_page",
            &[
                ("page_id", "string", false),
                ("page_title", "string", false),
                ("parent_id", "string", false),
                ("before_id", "string", false),
                ("after_id", "string", false),
            ],
        ),
        tool(
            "trame_add_comment",
            &[
                ("page_id", "string", false),
                ("page_title", "string", false),
                ("block_id", "string", false),
                ("block_text", "string", false),
                ("body", "string", true),
                ("agent", "string", true),
                ("meta", "object", true),
            ],
        ),
        tool(
            "trame_html",
            &[
                ("html", "string", true),
                ("page_id", "string", false),
                ("page_title", "string", false),
                ("block_id", "string", false),
                ("new_page_title", "string", false),
                ("parent_id", "string", false),
            ],
        ),
        tool(
            "trame_html_data",
            &[
                ("page_id", "string", false),
                ("page_title", "string", false),
                ("block_id", "string", false),
            ],
        ),
        tool(
            "trame_report",
            &[
                ("title", "string", true),
                ("html", "string", true),
                ("client", "string", false),
                ("story", "string", false),
            ],
        ),
        tool("trame_reports", &[]),
        tool("trame_sync", &[]),
    ]
}
fn text(value: &Value) -> CallToolResponse {
    let mut bytes = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b" ");
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, formatter);
    let rendered = value
        .serialize(&mut serializer)
        .ok()
        .and_then(|_| String::from_utf8(bytes).ok())
        .unwrap_or_else(|| "null".into());
    CallToolResult::success(vec![ContentBlock::text(rendered)]).into()
}
fn error(message: &str) -> CallToolResponse {
    CallToolResult::error(vec![ContentBlock::text(message.to_owned())]).into()
}
fn validate(args: &Value, tool: &Tool) -> Result<()> {
    for key in tool
        .input_schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(key) = key.as_str() else { continue };
        if args.get(key).is_none() || args[key].is_null() {
            bail!("{key} is required");
        }
    }
    for (key, field) in tool
        .input_schema
        .get("properties")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|m| m.iter())
    {
        let Some(value) = args.get(key) else { continue };
        let valid = match field["type"].as_str() {
            Some("string") => value.is_string(),
            Some("number") => value.is_number(),
            Some("array") => value.is_array(),
            Some("object") => value.is_object(),
            _ => field["type"].as_array().is_some_and(|types| {
                types
                    .iter()
                    .any(|t| t == "null" && value.is_null() || t == "string" && value.is_string())
            }),
        };
        if !valid {
            bail!("{key} has the wrong type");
        }
        if field["enum"].is_array() && !field["enum"].as_array().unwrap().contains(value) {
            bail!("{key} is invalid");
        }
    }
    Ok(())
}
fn required<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("{key} is required"))
}
async fn page_id(args: &Value, target: &Target) -> Result<String> {
    match (
        args["page_id"].as_str().filter(|s| !s.is_empty()),
        args["page_title"].as_str().filter(|s| !s.is_empty()),
    ) {
        (Some(id), None) => Ok(id.into()),
        (None, Some(title)) => resolve_by_title(target, title, "page").await,
        _ => bail!("use exactly one of page_id or page_title"),
    }
}
pub async fn execute(name: &str, args: &Value) -> Result<Value> {
    if name == "trame_capabilities" {
        return Ok(json!(include_str!("capabilities.txt")));
    }
    let target = resolve_target().await?;
    match name {
        "trame_board" => target.get("/api/board").await,
        "trame_session" => {
            let input = required(args, "session")?;
            let Some(reference) = parse_session_ref(input) else {
                return Ok(
                    json!({"error":format!("not a session id or Trame URL: {input} — pass a uuid, or a link containing ?session=<uuid> or ?page=<uuid>")}),
                );
            };
            if reference.kind == RefKind::Page {
                let page = target.get(&format!("/api/pages/{}", reference.id)).await?;
                return Ok(
                    json!({"note":"URL had no ?session= — returning the page and the sessions anchored to it",
                    "page":{"id":page["id"],"title":page["title"],"kind":page["kind"]},"sessions":page.get("sessions").cloned().unwrap_or_else(||json!([]))}),
                );
            }
            let suffix = args["events"]
                .as_f64()
                .filter(|n| *n != 0.0)
                .map(|n| format!("?events={n}"))
                .unwrap_or_default();
            let mut card = target
                .get(&format!("/api/sessions/{}{suffix}", reference.id))
                .await?;
            card["url"] = target.app_url(&format!("view=card&card={}", reference.id));
            Ok(card)
        }
        "trame_track" => {
            let mut body = args.clone();
            if let Some(id) = std::env::var("CODEX_THREAD_ID")
                .ok()
                .filter(|s| !s.is_empty())
            {
                body["agent"] = json!("codex");
                body["agent_id"] = json!(id);
            } else if let Some(id) = std::env::var("CLAUDE_CODE_SESSION_ID")
                .ok()
                .filter(|s| !s.is_empty())
            {
                body["agent"] = json!("claude");
                body["agent_id"] = json!(id);
            }
            target.post("/api/sessions", &body).await
        }
        "trame_set_status" => {
            target
                .post(
                    &format!("/api/sessions/{}/status", required(args, "id")?),
                    &json!({"status":required(args,"status")?}),
                )
                .await
        }
        "trame_new_story" => target.post("/api/stories", args).await,
        "trame_create_page" => {
            let page = write_page(args, &target).await?;
            if page["action"] != "created" {
                bail!("expected a page creation");
            }
            Ok(json!({"id":page["id"],"filed_under":page["parent"]}))
        }
        "trame_update_page" => {
            if args["session_id"].as_str().is_none_or(str::is_empty)
                && args["page_id"].as_str().is_none_or(str::is_empty)
                && args["page_title"].as_str().is_none_or(str::is_empty)
            {
                bail!("use page_id, page_title, or session_id");
            }
            let page = write_page(args, &target).await?;
            Ok(json!({"page_id":page["id"]}))
        }
        "trame_move_page" => {
            if args["before_id"].is_string() && args["after_id"].is_string() {
                bail!("use before_id or after_id, not both");
            }
            let id = page_id(args, &target).await?;
            let mut body = Map::new();
            for key in ["parent_id", "before_id", "after_id"] {
                if let Some(value) = args.get(key) {
                    body.insert(key.into(), value.clone());
                }
            }
            target
                .post(&format!("/api/pages/{id}/move"), &Value::Object(body))
                .await?;
            Ok(json!({"ok":true}))
        }
        "trame_add_comment" => {
            let res = add_comment(args, &target).await?;
            Ok(json!({"id":res["id"]}))
        }
        "trame_html" => html(args, &target).await,
        "trame_html_data" => html_data(args, &target).await,
        "trame_report" => target.post("/api/reports", args).await,
        "trame_reports" => target.get("/api/reports").await,
        "trame_sync" => target.post("/api/sync", &json!({})).await,
        _ => bail!("unknown tool: {name}"),
    }
}
async fn html(args: &Value, target: &Target) -> Result<Value> {
    let html = required(args, "html")?;
    if html.len()
        > MCP_CONTRACTS["htmlBlockMaxBytes"]
            .as_u64()
            .expect("generated HTML limit") as usize
    {
        bail!("html is over 512 KB");
    }
    if let Some(title) = args["new_page_title"].as_str().filter(|s| !s.is_empty()) {
        let block = uuid::Uuid::new_v4().to_string()[..8].to_owned();
        let page = target
            .post(
                "/api/pages",
                &json!({"title":title,"kind":"page",
            "parent_id":args["parent_id"],"content":[{"type":"html","html":html,"id":block}]}),
            )
            .await?;
        return Ok(json!({"page_id":page["id"],"block_id":block}));
    }
    let id = page_id(args, target).await?;
    let page = target.get(&format!("/api/pages/{id}")).await?;
    let mut content = page["content"].as_array().cloned().unwrap_or_default();
    let block = if let Some(block) = args["block_id"].as_str().filter(|s| !s.is_empty()) {
        let Some(existing) = content
            .iter_mut()
            .find(|b| b["id"] == block && b["type"] == "html")
        else {
            bail!("no html block \"{block}\" on that page");
        };
        existing["html"] = json!(html);
        block.into()
    } else {
        let block = uuid::Uuid::new_v4().to_string()[..8].to_owned();
        content.push(json!({"type":"html","html":html,"id":block}));
        block
    };
    target
        .post(&format!("/api/pages/{id}"), &json!({"content":content}))
        .await?;
    Ok(json!({"page_id":id,"block_id":block}))
}
async fn html_data(args: &Value, target: &Target) -> Result<Value> {
    let id = page_id(args, target).await?;
    let page = target.get(&format!("/api/pages/{id}")).await?;
    let blocks = page["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "html")
        .collect::<Vec<_>>();
    let selected = if let Some(block) = args["block_id"].as_str() {
        blocks.iter().find(|b| b["id"] == block).copied()
    } else if blocks.len() == 1 {
        Some(blocks[0])
    } else {
        None
    };
    let Some(selected) = selected else {
        if let Some(block) = args["block_id"].as_str() {
            bail!("no html block \"{block}\" on that page");
        }
        bail!("page has {} html blocks — pass block_id", blocks.len());
    };
    Ok(json!({"block_id":selected["id"],"data":selected.get("data").unwrap_or(&Value::Null)}))
}
impl ServerHandler for TrameMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("trame", "0.1.0"))
    }
    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(tools()))
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let name = request.name.to_string();
        let Some(tool) = tools().into_iter().find(|tool| tool.name == name) else {
            return Err(ErrorData::method_not_found::<
                rmcp::model::CallToolRequestMethod,
            >());
        };
        let args = Value::Object(request.arguments.unwrap_or_default());
        let result = match validate(&args, &tool) {
            Ok(()) => execute(&name, &args).await,
            Err(error) => Err(error),
        };
        Ok(match result {
            Ok(value) if name == "trame_capabilities" => {
                CallToolResult::success(vec![ContentBlock::text(value.as_str().unwrap_or(""))])
                    .into()
            }
            Ok(value) => text(&value),
            Err(cause) => error(&cause.to_string()),
        })
    }
}
pub async fn serve() -> Result<()> {
    let service = TrameMcp.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

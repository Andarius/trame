// The contract every backend plugin implements; the registry in `plugins.rs` owns the
// manifest list, `/enable`, `/settings` and the enabled gate, and calls the rest.
// the surface an out-of-tree plugin reaches Trame through, besides this trait
#[allow(unused_imports, reason = "re-exported for composed plugins")]
pub(crate) use crate::{
    blocking::spawn as blocking, db::Db, routes::Native, routes::json_response, settings,
};
// a test's scratch directory, confined like the app's own
#[cfg(test)]
#[allow(unused_imports, reason = "re-exported for composed plugins")]
pub(crate) use crate::{scratch_root, workspace};
// core helpers for plugins that write pages, sessions, tags and marks; a new write capability
// becomes a `Write` variant below, not another re-export, so the contract stays a plan of writes
#[allow(unused_imports, reason = "re-exported for composed plugins")]
pub(crate) use crate::{
    pages::{
        MarkRule, add_mark_roles, create as create_page, delete as delete_page, get as get_page,
        project_above, update as update_page,
    },
    sessions::{
        ensure_specs_page, ensure_tag, set_status as set_session_status, tag_key,
        upsert as upsert_session,
    },
};
use axum::{body::Body, http::Request, response::Response};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin};
#[allow(unused_imports, reason = "re-exported for composed plugins")]
pub(crate) use trame_core::{
    JS_SPACE, js_string,
    page_markdown::{is_folder_block, markdown_to_page_blocks},
    page_merge::merge_page_blocks,
    todo_marks::{read_marks, strip_marks, write_mark},
    trim as js_trim, truthy,
};

pub type RouteFuture = Pin<Box<dyn Future<Output = Response> + Send + 'static>>;
pub type CliFuture = Pin<Box<dyn Future<Output = CliReply> + Send + 'static>>;

/// A `tramecli <plugin id> <name> …` subcommand, listed in the manifest and the plugin's help.
#[derive(Debug, Clone, Copy)]
pub struct CliCommand {
    pub name: &'static str,
    /// Arguments after the name, e.g. `<context> [--all]`.
    pub usage: &'static str,
    pub summary: &'static str,
}

/// What a plugin command prints: `text` on stdout (stderr when `code` is not 0), `json` under `--json`.
#[derive(Debug, Clone, PartialEq)]
pub struct CliReply {
    pub code: i32,
    pub text: String,
    pub json: Value,
}
impl CliReply {
    pub fn ok(text: impl Into<String>, json: Value) -> Self {
        Self {
            code: 0,
            text: text.into(),
            json,
        }
    }
    pub fn fail(text: impl Into<String>) -> Self {
        let text = text.into();
        Self {
            code: 1,
            json: json!({"error": text}),
            text,
        }
    }
}

/// One write in a plan for [`apply`].
#[derive(Debug, Clone, PartialEq)]
pub enum Write {
    /// `create_page`'s fields; yields the new page id.
    CreatePage(Value),
    UpdatePage {
        id: String,
        patch: Value,
    },
    DeletePage(String),
    /// `upsert_session`'s card; yields the stored card.
    UpsertSession(Value),
    SetSessionStatus {
        id: String,
        status: Value,
    },
    /// A tag label (and optional color); yields the tag.
    EnsureTag {
        label: String,
        color: Option<Value>,
    },
}

/// Applies `plan` in one transaction, in order: a failure leaves nothing written.
/// Returns one value per write (`null` for writes that yield nothing).
pub fn apply(db: &mut Db, plan: &[Write]) -> anyhow::Result<Vec<Value>> {
    db.transaction(|db| {
        plan.iter()
            .map(|write| {
                Ok(match write {
                    Write::CreatePage(fields) => create_page(db, fields)?,
                    Write::UpdatePage { id, patch } => {
                        update_page(db, id, patch)?;
                        Value::Null
                    }
                    Write::DeletePage(id) => {
                        delete_page(db, id)?;
                        Value::Null
                    }
                    Write::UpsertSession(card) => upsert_session(db, card, None)?,
                    Write::SetSessionStatus { id, status } => {
                        set_session_status(db, id, status)?;
                        Value::Null
                    }
                    Write::EnsureTag { label, color } => ensure_tag(db, label, color.as_ref())?,
                })
            })
            .collect()
    })
}

pub trait Plugin: Send + Sync + 'static {
    /// URL slug and settings key (`plugins.<id>` in settings.json).
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    fn glyph(&self) -> &'static str;
    /// One line, shown in the plugins manager.
    fn description(&self) -> &'static str;
    /// Semver of this build and its GitHub `owner/name`, for the update check.
    fn version(&self) -> Option<(&'static str, &'static str)> {
        None
    }
    /// Sub path answering `{session id: {name, avatar}}` for tramecli's `assigner:` query.
    fn card_faces(&self) -> Option<&'static str> {
        None
    }
    /// Nav badge from in-memory state or the settings slice already read; no other I/O.
    fn badge(&self, _slice: &Value) -> Option<u64> {
        None
    }
    /// Sub paths reachable while the plugin is disabled (a connection test before enabling).
    fn ungated(&self, _sub: &str) -> bool {
        false
    }
    /// Allowlist and coerce a settings patch; what it returns is merged into the slice.
    fn sanitize(&self, _raw: &Value, _current: &Value) -> Value {
        json!({})
    }
    /// The slice as the UI may see it: never a token, `hasToken` booleans instead.
    fn settings_view(&self, slice: &Value) -> Value {
        slice.clone()
    }
    /// `/api/plugins/<id><sub>` (`sub` starts with "/"), after the registry gated it.
    fn route(&'static self, native: Native, sub: String, req: Request<Body>) -> RouteFuture;
    /// Runs once at boot whether enabled or not; own the loop and check the slice each tick.
    fn start(&'static self, _native: Native) -> Option<tokio::task::JoinHandle<()>> {
        None
    }
    /// tramecli subcommands this plugin answers in `command`.
    fn commands(&self) -> &'static [CliCommand] {
        &[]
    }
    /// Runs `tramecli <id> <name> <args…>` once the registry checked the gate and the name.
    fn command(&'static self, _native: Native, _name: String, _args: Vec<String>) -> CliFuture {
        Box::pin(async { CliReply::fail("this plugin has no commands") })
    }
    /// Just switched on: refresh now instead of waiting a tick.
    fn on_enabled(&'static self, _native: &Native) {}
    /// Trame is exiting: stop what the plugin spawned.
    fn stop(&'static self) {}
}

/// `GET /api/plugins` entry for a plugin.
pub fn manifest(plugin: &dyn Plugin, settings_path: &std::path::Path) -> Value {
    let slice = settings::plugin(settings_path, plugin.id());
    let mut m = json!({
        "id": plugin.id(),
        "label": plugin.label(),
        "glyph": plugin.glyph(),
        "description": plugin.description(),
        "enabled": slice["enabled"] == true,
        "badge": plugin.badge(&slice),
    });
    if let Some(route) = plugin.card_faces() {
        m["cardFaces"] = json!(route);
    }
    if let Some((version, repo)) = plugin.version() {
        m["version"] = json!(version);
        m["repo"] = json!(repo);
    }
    let commands = plugin.commands();
    if !commands.is_empty() {
        m["commands"] = commands
            .iter()
            .map(|c| json!({"name": c.name, "usage": c.usage, "summary": c.summary}))
            .collect();
    }
    m
}

/// The command a `/cli` body names, with its args, if the plugin declares it.
pub(crate) fn cli_call(plugin: &dyn Plugin, body: &Value) -> Result<(String, Vec<String>), String> {
    let name = body["name"].as_str().unwrap_or("");
    if !plugin.commands().iter().any(|c| c.name == name) {
        return Err(format!("{} has no command {name:?}", plugin.id()));
    }
    let args = body["args"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| a.as_str().map(str::to_owned).ok_or("args must be strings"))
        .collect::<Result<_, _>>()?;
    Ok((name.to_owned(), args))
}

/// What the registry answers itself for `/api/plugins/<id><sub>`; everything else is the plugin's.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Owned {
    Enable,
    Settings,
    Gated,
    Cli,
    Route,
}

pub(crate) fn classify(plugin: &dyn Plugin, sub: &str, method: &str, enabled: bool) -> Owned {
    match (sub, method) {
        ("/enable", "POST") => Owned::Enable,
        ("/settings", _) => Owned::Settings,
        _ if !enabled && !plugin.ungated(sub) => Owned::Gated,
        ("/cli", "POST") => Owned::Cli,
        _ => Owned::Route,
    }
}

/// The registry's share of a synchronous entry (tests, blocking handlers): `Some(answer)` for
/// `/enable`, `/settings` and a gated route, `None` when the plugin's own route should run.
pub fn handle_sync(
    plugin: &dyn Plugin,
    settings_path: &std::path::Path,
    method: &str,
    sub: &str,
    body: &Value,
) -> anyhow::Result<Option<(u16, Value)>> {
    let slice = settings::plugin(settings_path, plugin.id());
    Ok(
        match classify(plugin, sub, method, slice["enabled"] == true) {
            Owned::Enable => {
                let enabled = body["enabled"] == true;
                settings::save_plugin(settings_path, plugin.id(), &json!({"enabled": enabled}))?;
                Some((200, json!({"enabled": enabled})))
            }
            Owned::Settings => {
                if method == "POST" {
                    settings::save_plugin(
                        settings_path,
                        plugin.id(),
                        &plugin.sanitize(body, &slice),
                    )?;
                }
                let slice = settings::plugin(settings_path, plugin.id());
                let mut view = plugin.settings_view(&slice);
                view["enabled"] = json!(slice["enabled"] == true);
                Some((200, view))
            }
            Owned::Gated => Some((403, json!({"error": "plugin disabled"}))),
            Owned::Cli | Owned::Route => None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake;
    impl Plugin for Fake {
        fn id(&self) -> &'static str {
            "fake"
        }
        fn label(&self) -> &'static str {
            "Fake"
        }
        fn glyph(&self) -> &'static str {
            "f"
        }
        fn description(&self) -> &'static str {
            ""
        }
        fn commands(&self) -> &'static [CliCommand] {
            &[CliCommand {
                name: "pods",
                usage: "<context>",
                summary: "list pods",
            }]
        }
        fn route(&'static self, _: Native, _: String, _: Request<Body>) -> RouteFuture {
            unreachable!()
        }
    }

    #[test]
    fn cli_runs_only_declared_commands_of_an_enabled_plugin() {
        assert_eq!(classify(&Fake, "/cli", "POST", true), Owned::Cli);
        assert_eq!(classify(&Fake, "/cli", "POST", false), Owned::Gated);
        assert_eq!(
            cli_call(&Fake, &json!({"name":"pods","args":["prod"]})),
            Ok(("pods".to_owned(), vec!["prod".to_owned()]))
        );
        for body in [
            json!({"name":"rm","args":[]}),
            json!({"args":["pods"]}),
            json!({"name":"pods","args":[1]}),
        ] {
            assert!(cli_call(&Fake, &body).is_err(), "{body}");
        }
    }
}

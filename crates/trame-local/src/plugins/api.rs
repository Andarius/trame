// The contract every backend plugin implements; the registry in `plugins.rs` owns the
// manifest list, `/enable`, `/settings` and the enabled gate, and calls the rest.
// the surface an out-of-tree plugin reaches Trame through, besides this trait
#[allow(unused_imports, reason = "re-exported for composed plugins")]
pub(crate) use crate::{
    blocking::spawn as blocking, db::Db, routes::Native, routes::json_response, settings,
};
use axum::{body::Body, http::Request, response::Response};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin};

pub type RouteFuture = Pin<Box<dyn Future<Output = Response> + Send + 'static>>;

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
    if let Some((version, repo)) = plugin.version() {
        m["version"] = json!(version);
        m["repo"] = json!(repo);
    }
    m
}

/// What the registry answers itself for `/api/plugins/<id><sub>`; everything else is the plugin's.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Owned {
    Enable,
    Settings,
    Gated,
    Route,
}

pub(crate) fn classify(plugin: &dyn Plugin, sub: &str, method: &str, enabled: bool) -> Owned {
    match (sub, method) {
        ("/enable", "POST") => Owned::Enable,
        ("/settings", _) => Owned::Settings,
        _ if !enabled && !plugin.ungated(sub) => Owned::Gated,
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
            Owned::Route => None,
        },
    )
}

use crate::routes::{Native, json_response};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

pub mod api;
#[path = "plugins/local.gen.rs"]
mod local_gen;
pub mod notebook;
#[cfg(feature = "wasm-plugins")]
pub mod wasm;

use api::{Owned, Plugin, classify};

/// The WebAssembly packages, once [`load_wasm`] ran.
#[cfg(feature = "wasm-plugins")]
static WASM: std::sync::OnceLock<Vec<&'static wasm::WasmPlugin>> = std::sync::OnceLock::new();

#[cfg(feature = "wasm-plugins")]
fn wasm_plugins() -> impl Iterator<Item = &'static dyn Plugin> {
    WASM.get()
        .into_iter()
        .flatten()
        .map(|&p| p as &'static dyn Plugin)
}
#[cfg(not(feature = "wasm-plugins"))]
fn wasm_plugins() -> impl Iterator<Item = &'static dyn Plugin> {
    std::iter::empty()
}

fn compiled() -> impl Iterator<Item = &'static dyn Plugin> {
    let first_party: [&'static dyn Plugin; 1] = [&notebook::PLUGIN];
    first_party
        .into_iter()
        .chain(local_gen::LOCAL.iter().copied())
}

/// Every plugin: first-party ones, the ones composed from plugins.local.json, then the
/// WebAssembly packages installed under `<root>/plugins/wasm`.
pub fn registry() -> impl Iterator<Item = &'static dyn Plugin> {
    compiled().chain(wasm_plugins())
}

/// Compiles the installed WebAssembly packages once, at boot.
#[cfg_attr(
    not(feature = "wasm-plugins"),
    allow(clippy::unused_async, reason = "nothing to load without the runtime")
)]
pub async fn load_wasm(root: &std::path::Path) {
    #[cfg(feature = "wasm-plugins")]
    {
        let taken: Vec<_> = compiled().map(api::Plugin::id).collect();
        let loaded = wasm::load_all(root, &taken)
            .await
            .into_iter()
            .map(|p| &*Box::leak(Box::new(p)))
            .collect();
        let _ = WASM.set(loaded);
    }
    #[cfg(not(feature = "wasm-plugins"))]
    let _ = root;
}

fn find(id: &str) -> Option<&'static dyn Plugin> {
    registry().find(|p| p.id() == id)
}

pub fn encode(value: &str) -> String {
    let mut url = reqwest::Url::parse("https://encode.invalid/").unwrap();
    url.query_pairs_mut().append_pair("v", value);
    url.query().unwrap_or("")[2..].to_owned()
}

/// The composed plugins' frontend bundle, installed by `just plugins-install`.
pub fn web_dir(root: &std::path::Path) -> std::path::PathBuf {
    root.join("plugins/web")
}

/// Boot-time loops of every plugin; the composed plugins' page marks join the hierarchy rules.
pub fn start_all(native: &Native) -> Vec<tokio::task::JoinHandle<()>> {
    let roles = local_gen::MARK_ROLES
        .iter()
        .filter_map(|(mark, value, role)| {
            Some(crate::pages::MarkRule {
                mark: (*mark).to_owned(),
                value: regex::Regex::new(value).ok()?,
                role: (*role).to_owned(),
            })
        })
        .collect();
    crate::pages::add_mark_roles(roles);
    registry().filter_map(|p| p.start(native.clone())).collect()
}

/// Trame is exiting.
pub fn stop_all() {
    for p in registry() {
        p.stop();
    }
}

/// The enabled WebAssembly packages' own `plugin.<ext>`, appended to the composed bundle.
fn wasm_web_files(settings: &std::path::Path, ext: &str) -> Vec<std::path::PathBuf> {
    #[cfg(feature = "wasm-plugins")]
    {
        WASM.get()
            .into_iter()
            .flatten()
            .filter(|p| crate::settings::plugin(settings, api::Plugin::id(**p))["enabled"] == true)
            .map(|p| p.web_file(ext))
            .collect()
    }
    #[cfg(not(feature = "wasm-plugins"))]
    {
        let _ = (settings, ext);
        Vec::new()
    }
}

// the composed plugins' frontend bundle (`just plugins-install`), then each WebAssembly package's
async fn web_file(root: &std::path::Path, name: &str, extra: &[std::path::PathBuf]) -> Response {
    let (content_type, separator): (_, &[u8]) = match name {
        // `;`: each part is a standalone classic script
        "plugins.js" => ("text/javascript", b"\n;\n"),
        "plugins.css" => ("text/css", b"\n"),
        _ => return json_response(404, json!({"error":"not found"})),
    };
    let mut parts = Vec::new();
    for path in std::iter::once(web_dir(root).join(name)).chain(extra.iter().cloned()) {
        if let Ok(bytes) = tokio::fs::read(&path).await {
            parts.push(bytes);
        }
    }
    if parts.is_empty() {
        return json_response(404, json!({"error":"not installed"}));
    }
    (
        StatusCode::OK,
        [
            ("content-type", content_type),
            ("cache-control", "no-store"),
        ],
        parts.join(separator),
    )
        .into_response()
}
pub fn owns(_method: &str, path: &str) -> bool {
    path == "/api/plugins" || path.starts_with("/api/plugins/")
}

/// `GET /api/plugins` entries for every compiled-in plugin.
pub fn manifest_list(settings: &std::path::Path) -> Vec<Value> {
    registry().map(|p| api::manifest(p, settings)).collect()
}

fn manifests(state: &Native) -> Response {
    json_response(200, Value::Array(manifest_list(&state.settings)))
}

async fn json_body(req: Request<Body>) -> Option<Value> {
    let bytes = axum::body::to_bytes(req.into_body(), 1 << 20).await.ok()?;
    Some(serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| json!({})))
}

pub async fn serve(state: Native, req: Request<Body>) -> Response {
    let path = req.uri().path().to_owned();
    if let Some(name) = path.strip_prefix("/api/plugins/web/") {
        let ext = name.rsplit('.').next().unwrap_or("");
        return web_file(&state.root, name, &wasm_web_files(&state.settings, ext)).await;
    }
    if path == "/api/plugins" {
        return manifests(&state);
    }
    let rest = path.strip_prefix("/api/plugins/").unwrap_or("");
    let (id, sub) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let Some(plugin) = find(id) else {
        return json_response(404, json!({"error":"unknown plugin"}));
    };
    let slice = crate::settings::plugin(&state.settings, plugin.id());
    let method = req.method().as_str().to_owned();
    match classify(plugin, sub, &method, slice["enabled"] == true) {
        Owned::Enable => {
            let Some(body) = json_body(req).await else {
                return json_response(400, json!({"error":"body unavailable"}));
            };
            let enabled = body["enabled"] == true;
            if let Err(e) = crate::settings::save_plugin(
                &state.settings,
                plugin.id(),
                &json!({"enabled": enabled}),
            ) {
                return json_response(500, json!({"error": e.to_string()}));
            }
            if enabled {
                plugin.on_enabled(&state);
            }
            json_response(200, json!({"enabled": enabled}))
        }
        Owned::Settings => {
            if method == "POST" {
                let Some(body) = json_body(req).await else {
                    return json_response(400, json!({"error":"body unavailable"}));
                };
                let patch = plugin.sanitize(&body, &slice);
                if let Err(e) = crate::settings::save_plugin(&state.settings, plugin.id(), &patch) {
                    return json_response(500, json!({"error": e.to_string()}));
                }
            }
            let slice = crate::settings::plugin(&state.settings, plugin.id());
            let mut view = plugin.settings_view(&slice);
            view["enabled"] = json!(slice["enabled"] == true);
            json_response(200, view)
        }
        Owned::Gated => json_response(403, json!({"error":"plugin disabled"})),
        Owned::Cli => {
            let Some(body) = json_body(req).await else {
                return json_response(400, json!({"error":"body unavailable"}));
            };
            match api::cli_call(plugin, &body) {
                Ok((name, args)) => {
                    let reply = Box::pin(plugin.command(state, name, args)).await;
                    json_response(
                        200,
                        json!({"code": reply.code, "text": reply.text, "json": reply.json}),
                    )
                }
                Err(error) => json_response(400, json!({"error": error})),
            }
        }
        // boxed: the proxying plugins' futures would otherwise bloat every plugin request
        Owned::Route => Box::pin(plugin.route(state, sub.to_owned(), req)).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn plugin_web_serves_only_the_bundle_files() {
        let root = crate::scratch_root(
            &crate::workspace().join(format!(".scratch/plugin-web-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        let web = web_dir(&root);
        std::fs::create_dir_all(&web).unwrap();
        std::fs::write(web.join("plugins.js"), "js").unwrap();
        std::fs::write(web.join("other.js"), "js").unwrap();
        std::fs::write(root.join("settings.json"), "{}").unwrap();
        for (name, status) in [
            ("plugins.js", 200),
            ("plugins.css", 404),
            ("other.js", 404),
            ("../../settings.json", 404),
        ] {
            assert_eq!(
                web_file(&root, name, &[]).await.status().as_u16(),
                status,
                "{name}"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

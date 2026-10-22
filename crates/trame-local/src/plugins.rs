use crate::routes::{Native, json_response};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

pub mod api;
pub mod deployments;
#[path = "plugins/local.gen.rs"]
mod local_gen;
pub mod notebook;
pub mod sql_source;

use api::{Owned, Plugin, classify};

/// Every compiled-in plugin: first-party ones, then the ones composed from plugins.local.json.
pub fn registry() -> impl Iterator<Item = &'static dyn Plugin> {
    let first_party: [&'static dyn Plugin; 3] =
        [&deployments::PLUGIN, &sql_source::PLUGIN, &notebook::PLUGIN];
    first_party
        .into_iter()
        .chain(local_gen::LOCAL.iter().copied())
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

// the out-of-process plugins' frontend bundle, installed by `just plugins-install`
async fn web_file(root: &std::path::Path, name: &str) -> Response {
    let content_type = match name {
        "plugins.js" => "text/javascript",
        "plugins.css" => "text/css",
        _ => return json_response(404, json!({"error":"not found"})),
    };
    match tokio::fs::read(web_dir(root).join(name)).await {
        Ok(bytes) => (
            StatusCode::OK,
            [
                ("content-type", content_type),
                ("cache-control", "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => json_response(404, json!({"error":"not installed"})),
    }
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
        return web_file(&state.root, name).await;
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
                web_file(&root, name).await.status().as_u16(),
                status,
                "{name}"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

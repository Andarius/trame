use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use std::path::{Component, Path, PathBuf};

pub fn owns(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("/api/")
        && path != "/api"
        && path != "/report-file"
        && !path.starts_with("/report/")
}
fn safe_file(root: &Path, name: &str) -> Option<PathBuf> {
    let relative = Path::new(name);
    if !relative
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let file = root.join(relative);
    let real = file.canonicalize().ok()?;
    real.starts_with(root).then_some(real)
}
#[allow(
    clippy::case_sensitive_file_extension_comparisons,
    reason = "case-sensitive match is intentional for parity"
)]
pub async fn serve(state: crate::routes::Native, req: Request<Body>) -> Response {
    let path = req.uri().path();
    let name = if path == "/" {
        "index.html"
    } else {
        &path[1..]
    };
    let content_type = if name.ends_with(".js") {
        "text/javascript"
    } else if name.ends_with(".css") {
        "text/css"
    } else if name.ends_with(".html") {
        "text/html"
    } else {
        "application/octet-stream"
    };
    let cache = if name.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let root = state.web_dir.canonicalize().unwrap_or(state.web_dir);
    if let Some(file) = safe_file(&root, name) {
        if let Ok(Ok(bytes)) = crate::blocking::spawn(move || std::fs::read(file)).await {
            return (
                StatusCode::OK,
                [("content-type", content_type), ("cache-control", cache)],
                bytes,
            )
                .into_response();
        }
    }
    if name.starts_with("assets/") {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    (
        StatusCode::OK,
        [("content-type", "text/html")],
        "<h1>🧵 Trame</h1><p>Frontend not built — run <code>just web-build</code>.</p>",
    )
        .into_response()
}

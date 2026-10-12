use axum::{Json, Router, routing::get};

// Build-time route stand-in; the spike never binds an HTTP listener.
pub fn router() -> Router {
    Router::new().route("/api/status", get(|| async {
        Json(serde_json::json!({"spike": true, "core": trame_core::todo_marks::strip_marks("spike {{trame:due=2026-10-10}}") }))
    }))
}

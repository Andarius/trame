use crate::{db::Db, files, routes::Native, sessions};
use anyhow::{Context, Result};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::{
    fs,
    path::{Path, PathBuf},
};

const MAX_BYTES: usize = 10 * 1024 * 1024;
#[allow(
    clippy::needless_pass_by_value,
    reason = "callers pass json! temporaries"
)]
fn json_response(status: u16, value: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        [("content-type", "application/json")],
        crate::json::stringify(&value),
    )
        .into_response()
}
fn html(status: u16, body: String) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        [("content-type", "text/html; charset=utf-8")],
        body,
    )
        .into_response()
}
fn text(status: u16, body: &'static str) -> Response {
    (StatusCode::from_u16(status).unwrap(), body).into_response()
}
fn assets_dir(root: &Path) -> Result<PathBuf> {
    let path = std::env::var_os("TRACKER_ASSETS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("assets"));
    if crate::isolated_mode() || crate::scratch_path(root).is_ok() {
        crate::scratch_path(&path)
    } else {
        Ok(path)
    }
}
fn ext(mime: &str) -> &'static str {
    match mime {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/svg+xml" => ".svg",
        "image/avif" => ".avif",
        _ => "",
    }
}
fn id_path(id: &str, mime: &str) -> String {
    format!("{id}{}", ext(mime))
}
fn asset_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/api/assets/")?;
    if id.len() == 36
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
    {
        Some(id)
    } else {
        None
    }
}
fn report_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/report/")?;
    (!id.is_empty() && !id.contains('/')).then_some(id)
}
fn query_path(query: &str) -> String {
    reqwest::Url::parse(&format!("http://localhost/?{query}"))
        .ok()
        .and_then(|u| {
            u.query_pairs()
                .find(|(k, _)| k == "path")
                .map(|(_, v)| v.into_owned())
        })
        .unwrap_or_default()
}
pub fn owns(method: &str, path: &str) -> bool {
    (method == "POST" && path == "/api/assets")
        || asset_id(path).is_some()
        || report_id(path).is_some()
        || path == "/report-file"
}

#[derive(Clone)]
struct S3 {
    endpoint: String,
    bucket: String,
    region: String,
    access: String,
    secret: String,
    prefix: String,
}
impl S3 {
    fn config() -> Option<Self> {
        let endpoint = std::env::var("TRACKER_S3_ENDPOINT")
            .ok()
            .filter(|s| !s.is_empty())?;
        let bucket = std::env::var("TRACKER_S3_BUCKET")
            .ok()
            .filter(|s| !s.is_empty())?;
        Some(Self {
            endpoint,
            bucket,
            region: std::env::var("TRACKER_S3_REGION")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "us-east-1".into()),
            access: std::env::var("TRACKER_S3_ACCESS_KEY").unwrap_or_default(),
            secret: std::env::var("TRACKER_S3_SECRET_KEY").unwrap_or_default(),
            prefix: std::env::var("TRACKER_S3_PREFIX").unwrap_or_else(|_| "trame-assets/".into()),
        })
    }
    async fn request(
        &self,
        method: &str,
        key: &str,
        bytes: Option<Vec<u8>>,
    ) -> Result<Option<Vec<u8>>> {
        let origin = reqwest::Url::parse(&self.endpoint)?;
        let host = origin.host_str().context("S3 endpoint host missing")?;
        let authority = if let Some(port) = origin.port() {
            format!("{host}:{port}")
        } else {
            host.to_owned()
        };
        let path = aws_uri(&format!("/{}/{key}", self.bucket));
        let url = format!("{}://{authority}{path}", origin.scheme());
        let payload = bytes.as_deref().unwrap_or(&[]);
        let hash = hex(&Sha256::digest(payload));
        let at = chrono::Utc::now();
        let stamp = at.format("%Y%m%dT%H%M%SZ").to_string();
        let day = at.format("%Y%m%d").to_string();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let mut req = client
            .request(method.parse()?, url)
            .header("host", &authority)
            .header("x-amz-date", &stamp)
            .header("x-amz-content-sha256", &hash);
        if !self.access.is_empty() {
            let scope = format!("{day}/{}/s3/aws4_request", self.region);
            let canonical = format!(
                "{method}\n{path}\n\nhost:{authority}\nx-amz-content-sha256:{hash}\nx-amz-date:{stamp}\n\nhost;x-amz-content-sha256;x-amz-date\n{hash}"
            );
            let string_to_sign = format!(
                "AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{}",
                hex(&Sha256::digest(canonical.as_bytes()))
            );
            let key = hmac(format!("AWS4{}", self.secret).as_bytes(), day.as_bytes());
            let key = hmac(&key, self.region.as_bytes());
            let key = hmac(&key, b"s3");
            let key = hmac(&key, b"aws4_request");
            let signature = hex(&hmac(&key, string_to_sign.as_bytes()));
            req=req.header("authorization",format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={signature}",self.access));
        }
        if let Some(bytes) = bytes {
            req = req.body(bytes);
        }
        let response = req.send().await?;
        if response.status() != reqwest::StatusCode::OK {
            return Ok(None);
        }
        Ok(Some(response.bytes().await?.to_vec()))
    }
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        self.request("PUT", key, Some(bytes))
            .await?
            .context("S3 upload failed")?;
        Ok(())
    }
    async fn get(&self, key: &str) -> Option<Vec<u8>> {
        self.request("GET", key, None).await.ok().flatten()
    }
}
fn s3_blocked_offline(state: &Native, s3: &S3) -> bool {
    state.sync.offline
        && !reqwest::Url::parse(&s3.endpoint)
            .ok()
            .filter(|url| matches!(url.scheme(), "http" | "https"))
            .and_then(|url| {
                url.host_str().and_then(|host| {
                    host.trim_matches(['[', ']'])
                        .parse::<std::net::IpAddr>()
                        .ok()
                })
            })
            .is_some_and(|ip| ip.is_loopback())
}
fn aws_uri(path: &str) -> String {
    let mut out = String::new();
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            out.push(byte as char);
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut acc, b| {
        let _ = write!(acc, "{b:02x}");
        acc
    })
}
fn hmac(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut keyblock = [0u8; 64];
    let material = if key.len() > 64 {
        Sha256::digest(key).to_vec()
    } else {
        key.to_vec()
    };
    keyblock[..material.len()].copy_from_slice(&material);
    let mut inner = keyblock;
    let mut outer = keyblock;
    for i in 0..64 {
        inner[i] ^= 0x36;
        outer[i] ^= 0x5c;
    }
    let mut h = Sha256::new();
    h.update(inner);
    h.update(message);
    let inner = h.finalize();
    let mut h = Sha256::new();
    h.update(outer);
    h.update(inner);
    h.finalize().into()
}
fn local_name(value: &str) -> Option<&str> {
    let path = Path::new(value);
    (path.components().count() == 1
        && path.file_name().and_then(|s| s.to_str()) == Some(value)
        && !value.contains(".."))
    .then_some(value)
}
fn connect(state: &Native) -> Result<Db> {
    Db::connect(
        &state.root.join("socket"),
        &state.origin,
        Some(state.settings.clone()),
    )
}
fn excalidraw_page(scene: &str, path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or("").replace('<', "&lt;");
    let scene = scene.replace("</", "<\\/");
    format!(
        r#"<!doctype html><meta charset="utf-8"><title>{name}</title>
<link rel="stylesheet" href="https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/index.css">
<body style="margin:0">
<div id="root" style="position:fixed;inset:0"></div>
<div id="status" style="position:fixed;right:14px;bottom:14px;z-index:10;font:12px system-ui;color:#555;background:#fffc;border-radius:6px;padding:2px 8px;pointer-events:none"></div>
<script type="application/json" id="scene">{scene}</script>
<script type="module">
globalThis.EXCALIDRAW_ASSET_PATH ??= "https://unpkg.com/@excalidraw/excalidraw@0.18.1/dist/prod/";
import React from "https://esm.sh/react@18.3.1";
import {{ createRoot }} from "https://esm.sh/react-dom@18.3.1/client";
const {{ Excalidraw, serializeAsJSON }} = await import("https://esm.sh/@excalidraw/excalidraw@0.18.1?deps=react@18.3.1,react-dom@18.3.1");
const scene = JSON.parse(document.getElementById("scene").textContent);
delete scene.appState?.collaborators;
const status = document.getElementById("status");
let api, timer, lastSaved = null;
async function save() {{
  if (!api) return;
  const body = serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), "local");
  if (body === lastSaved) return;
  status.textContent = "saving…";
  const r = await fetch(location.href, {{ method: "POST", body }}).catch(() => null);
  status.textContent = r && r.ok ? "saved" : "⚠ save failed";
  if (r && r.ok) lastSaved = body;
}}
document.addEventListener("visibilitychange", () => {{ if (document.visibilityState === "hidden") save(); }});
createRoot(document.getElementById("root")).render(React.createElement(Excalidraw, {{
  initialData: scene,
  excalidrawAPI: (a) => {{ api = a; }},
  onChange: () => {{ clearTimeout(timer); timer = setTimeout(save, 800); }},
}}));
</script></body>"#
    )
}
pub async fn serve(state: Native, req: Request<Body>) -> Response {
    let path = req.uri().path().to_owned();
    let query = req.uri().query().unwrap_or("").to_owned();
    let method = req.method().to_string();
    if path == "/api/assets" && method == "POST" {
        let mime = req
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_owned();
        if !mime.starts_with("image/") {
            return json_response(400, json!({"error":"images only"}));
        }
        let Ok(bytes) = axum::body::to_bytes(req.into_body(), MAX_BYTES + 1).await else {
            return json_response(413, json!({"error":"too large (10 MB max)"}));
        };
        if bytes.len() > MAX_BYTES {
            return json_response(413, json!({"error":"too large (10 MB max)"}));
        }
        let s3 = S3::config();
        if s3.as_ref().is_some_and(|s3| s3_blocked_offline(&state, s3)) {
            return json_response(503, json!({"error":"unavailable in offline mode"}));
        }
        let store = if s3.is_some() { "s3" } else { "local" };
        let mime_db = mime.clone();
        let id = crate::blocking::spawn({
            let state = state.clone();
            move || -> Result<String> {
                let mut db = connect(&state)?;
                let rows = db.query(
                    "insert into assets (mime,store,path) values ($1,$2,'') returning id",
                    &[json!(mime_db), json!(store)],
                )?;
                Ok(rows[0]["id"]
                    .as_str()
                    .context("asset id missing")?
                    .to_owned())
            }
        })
        .await;
        let Ok(Ok(id)) = id else {
            return text(500, "Internal Server Error");
        };
        let name = id_path(&id, &mime);
        let object = if let Some(s3) = &s3 {
            format!("{}{}", s3.prefix, name)
        } else {
            name.clone()
        };
        let write = if let Some(s3) = s3 {
            s3.put(&object, bytes.to_vec()).await
        } else {
            let Ok(dir) = assets_dir(&state.root) else {
                return text(500, "Internal Server Error");
            };
            let data = bytes.to_vec();
            crate::blocking::spawn(move || -> Result<()> {
                fs::create_dir_all(&dir)?;
                fs::write(dir.join(name), data)?;
                Ok(())
            })
            .await
            .unwrap_or_else(|e| Err(e.into()))
        };
        if write.is_err() {
            return text(500, "Internal Server Error");
        }
        let id_db = id.clone();
        let result = crate::blocking::spawn(move || -> Result<()> {
            let mut db = connect(&state)?;
            db.query(
                "update assets set path=$1 where id=$2",
                &[json!(object), json!(id_db)],
            )?;
            Ok(())
        })
        .await;
        return if result.is_ok_and(|r| r.is_ok()) {
            json_response(200, json!({"id":id}))
        } else {
            text(500, "Internal Server Error")
        };
    }
    if let Some(id) = asset_id(&path) {
        let row = crate::blocking::spawn({
            let state = state.clone();
            let id = id.to_owned();
            move || -> Result<Option<Value>> {
                let mut db = connect(&state)?;
                Ok(db
                    .query(
                        "select mime,store,path from assets where id=$1 and not deleted",
                        &[json!(id)],
                    )?
                    .into_iter()
                    .next())
            }
        })
        .await;
        let Some(row) = row.ok().and_then(Result::ok).flatten() else {
            return text(404, "not found");
        };
        let path = row["path"].as_str().unwrap_or("");
        if path.is_empty() || path.contains("..") {
            return text(404, "not found");
        }
        let bytes = if row["store"] == "s3" {
            if let Some(s3) = S3::config() {
                if s3_blocked_offline(&state, &s3) {
                    return json_response(503, json!({"error":"unavailable in offline mode"}));
                }
                s3.get(path).await
            } else {
                None
            }
        } else {
            let Some(name) = local_name(path) else {
                return text(404, "not found");
            };
            let Ok(dir) = assets_dir(&state.root) else {
                return text(404, "not found");
            };
            fs::read(dir.join(name)).ok()
        };
        let Some(bytes) = bytes else {
            return text(404, "not found");
        };
        return (
            StatusCode::OK,
            [
                (
                    "content-type",
                    row["mime"].as_str().unwrap_or("application/octet-stream"),
                ),
                ("x-content-type-options", "nosniff"),
                ("cache-control", "public, max-age=31536000, immutable"),
            ],
            bytes,
        )
            .into_response();
    }
    if let Some(id) = report_id(&path) {
        let id = id.to_owned();
        let result = crate::blocking::spawn(move || -> Result<Value> {
            let mut db = connect(&state)?;
            sessions::get_report(&mut db, &id)
        })
        .await;
        return match result {
            Ok(Ok(value)) if !value.is_null() => {
                html(200, value["html"].as_str().unwrap_or("").to_owned())
            }
            Ok(Ok(_)) => html(404, "report not found".into()),
            _ => text(500, "Internal Server Error"),
        };
    }
    if path == "/report-file" {
        let file = query_path(&query);
        if method == "POST" {
            let Ok(bytes) = axum::body::to_bytes(req.into_body(), usize::MAX).await else {
                return text(500, "Internal Server Error");
            };
            let body = String::from_utf8_lossy(&bytes).into_owned();
            let parsed = serde_json::from_str::<Value>(&body);
            let Ok(parsed) = parsed else {
                return json_response(400, json!({"error":"invalid json"}));
            };
            if parsed["type"] != "excalidraw" {
                return json_response(400, json!({"error":"not an excalidraw scene"}));
            }
            return match files::write_report(&state.settings, &file, &body) {
                Ok(true) => json_response(200, json!({"ok":true})),
                Ok(false) => json_response(404, json!({"error":"not allowed or not found"})),
                Err(_) => text(500, "Internal Server Error"),
            };
        }
        return match files::read_report(&state.settings, &file) {
            Ok(Some(content)) => html(
                200,
                if file.ends_with(".excalidraw") {
                    excalidraw_page(&content, &file)
                } else {
                    content
                },
            ),
            Ok(None) => html(404, "not allowed or not found".into()),
            Err(_) => text(500, "Internal Server Error"),
        };
    }
    text(404, "not found")
}
#[cfg(test)]
mod tests {
    use super::{aws_uri, hex, hmac};
    #[test]
    fn s3_signature_primitives_match_known_vector() {
        assert_eq!(
            hex(&hmac(
                b"key",
                b"The quick brown fox jumps over the lazy dog"
            )),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
        assert_eq!(
            aws_uri("/bucket/images/a b+é.png"),
            "/bucket/images/a%20b%2B%C3%A9.png"
        );
    }
}

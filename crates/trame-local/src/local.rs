use crate::{db::Db, files, settings};
use anyhow::Result;
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
};

pub fn owns(method: &str, path: &str) -> bool {
    matches!(
        path,
        "/api/settings"
            | "/api/identity"
            | "/api/repo-remote"
            | "/api/report-files"
            | "/api/report-files/content"
            | "/api/folder"
            | "/api/fs/complete"
            | "/api/users"
            | "/api/shares"
            | "/api/page-links"
            | "/api/reports"
    ) || matches!(path.split('/').collect::<Vec<_>>().as_slice(),["","api","reports",id] if !id.is_empty())
        || (method == "POST"
            && (matches!(path, "/api/report-files/delete" | "/api/open-path")
                || matches!(path.split('/').collect::<Vec<_>>().as_slice(),["","api","shares"|"page-links"|"reports",id,"delete"] if !id.is_empty())))
}

pub fn handle(
    db: &mut Db,
    method: &str,
    path: &str,
    query: &str,
    body: &Value,
) -> Option<Result<(u16, Value)>> {
    if !owns(method, path) {
        return None;
    }
    Some((|| {
        let url = reqwest::Url::parse(&format!("http://localhost/?{query}"))?;
        let get = |key: &str| {
            url.query_pairs()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default()
        };
        let settings = db.settings_path()?.to_owned();
        let value = match path {
            "/api/settings" => {
                if method == "POST" {
                    settings::save_explore(&settings, body)?;
                    files::invalidate(&settings);
                    let _ = update_profile(db, body);
                }
                settings::explore(&settings)?
            }
            "/api/identity" => db.identity()?,
            "/api/repo-remote" => {
                let path = get("path");
                if !path.starts_with('/') {
                    return Ok((400, json!({"error":"absolute path expected"})));
                }
                json!({"url":repo_url(&path)})
            }
            "/api/report-files" => {
                files::scan(&settings, url.query_pairs().any(|(k, _)| k == "force"))?
            }
            "/api/report-files/content" => {
                let path = get("path");
                match files::read_report(&settings, &path)? {
                    Some(html) => json!({"path":path,"html":html}),
                    None => return Ok(not_allowed()),
                }
            }
            "/api/report-files/delete" => {
                let result = files::delete_report(&settings, body["path"].as_str().unwrap_or(""))?;
                if result["ok"] != true {
                    return Ok(not_allowed());
                }
                result
            }
            "/api/folder" => {
                let path = get("path");
                match files::list_folder(&settings, &path)? {
                    Some(entries) => json!({"path":path,"entries":entries}),
                    None => return Ok(not_allowed()),
                }
            }
            "/api/open-path" => {
                let real = body["path"]
                    .as_str()
                    .map(|path| files::allowed_path(&settings, path))
                    .transpose()?
                    .flatten();
                let Some(real) = real else {
                    return Ok(not_allowed());
                };
                let mut child = Command::new(if cfg!(target_os = "macos") {
                    "open"
                } else {
                    "xdg-open"
                })
                .arg(real)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?;
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                json!({"ok":true})
            }
            "/api/fs/complete" => files::complete(&get("path")),
            "/api/reports" if method == "POST" => {
                json!({"id":crate::sessions::create_report(db,body)?})
            }
            "/api/reports" => crate::sessions::list_reports(db)?,
            "/api/users" => json!(db.query(
                "select id, name, role from users where not deleted order by name, id",
                &[]
            )?),
            "/api/shares" if method == "POST" => json!({"id":set_share(db,body)?}),
            "/api/shares" => {
                let page = get("page");
                if page.is_empty() {
                    json!([])
                } else {
                    json!(db.query("select s.id, s.user_id, s.role, coalesce(nullif(u.name, ''), s.user_id::text) as name from page_shares s left join users u on u.id = s.user_id where s.page_id=$1 and not s.deleted order by name",&[json!(page)])?)
                }
            }
            "/api/page-links" => {
                let base = settings::link_base(&settings);
                if method == "POST" {
                    let page = body
                        .get("page_id")
                        .map(trame_core::js_string)
                        .unwrap_or_else(|| "undefined".into());
                    let (id, token) = create_link(db, &page)?;
                    json!({"id":id,"url":base.map(|base|format!("{base}/l/{token}")),"token":token})
                } else {
                    let page = get("page");
                    let links = if page.is_empty() {
                        vec![]
                    } else {
                        list_links(db, &page)?
                    };
                    let links=links.into_iter().map(|l|json!({"id":l["id"],"updated_at":l["updated_at"],"url":base.as_ref().and_then(|base|l["token"].as_str().filter(|s|!s.is_empty()).map(|token|format!("{base}/l/{token}")))})).collect::<Vec<_>>();
                    json!({"base":base,"links":links})
                }
            }
            _ => {
                let parts = path.split('/').collect::<Vec<_>>();
                if parts[2] == "reports" {
                    if parts.len() == 5 {
                        crate::sessions::delete_report(db, parts[3])?;
                        return Ok((200, json!({"ok":true})));
                    }
                    let report = crate::sessions::get_report(db, parts[3])?;
                    return Ok(if report.is_null() {
                        (404, json!({"error":"not found"}))
                    } else {
                        (200, report)
                    });
                }
                let table = if parts[2] == "shares" {
                    "page_shares"
                } else {
                    "page_links"
                };
                db.query(&format!("update {table} set deleted=true, origin=$2, updated_at=clock_timestamp() where id=$1"),&[json!(parts[3]),json!(db.origin)])?;
                json!({"ok":true})
            }
        };
        Ok((200, value))
    })())
}

fn not_allowed() -> (u16, Value) {
    (404, json!({"error":"not allowed or not found"}))
}

pub fn device_id(node: &str) -> uuid::Uuid {
    uuid::Uuid::new_v5(
        &uuid::Uuid::parse_str("9c2f6a71-4b8e-4d05-a3c9-2e61d7f0b842").unwrap(),
        node.as_bytes(),
    )
}

pub fn claim_device(db: &mut Db) -> Result<()> {
    if settings::hub_api(db.settings_path()?).is_some() {
        return Ok(());
    }
    if !db
        .query(
            "select 1 from devices where node_id=$1 and not deleted limit 1",
            &[json!(db.origin)],
        )?
        .is_empty()
    {
        return Ok(());
    }
    let users = db.query("select id from users where not deleted", &[])?;
    if users.len() != 1 {
        return Ok(());
    }
    db.query("insert into devices (id, node_id, user_id, origin) values ($1,$2,$3,$4) on conflict (id) do nothing",&[json!(device_id(&db.origin).to_string()),json!(db.origin),users[0]["id"].clone(),json!(db.origin)])?;
    Ok(())
}

pub fn update_profile(db: &mut Db, patch: &Value) -> Result<()> {
    if !patch["authorName"].is_string() && !patch["authorAvatar"].is_string() {
        return Ok(());
    }
    let device = db.query(
        "select user_id from devices where node_id=$1 and not deleted limit 1",
        &[json!(db.origin)],
    )?;
    if let Some(d) = device.first() {
        db.query("update users set name = coalesce($2, name), avatar = coalesce($3, avatar), origin = $4, updated_at = now() where id = $1",&[d["user_id"].clone(),json!(patch["authorName"].as_str().map(trame_core::trim)),json!(patch["authorAvatar"].as_str().map(trame_core::trim)),json!(db.origin)])?;
    }
    Ok(())
}

pub fn set_share(db: &mut Db, body: &Value) -> Result<Value> {
    let role = if body["role"] == "viewer" {
        "viewer"
    } else {
        "editor"
    };
    let hit = db.query(
        "select id from page_shares where page_id=$1 and user_id=$2 and not deleted limit 1",
        &[body["page_id"].clone(), body["user_id"].clone()],
    )?;
    if let Some(hit) = hit.first() {
        db.query(
            "update page_shares set role=$2, origin=$3, updated_at=clock_timestamp() where id=$1",
            &[hit["id"].clone(), json!(role), json!(db.origin)],
        )?;
        Ok(hit["id"].clone())
    } else {
        Ok(db.query("insert into page_shares (page_id, user_id, role, origin) values ($1,$2,$3,$4) returning id",&[body["page_id"].clone(),body["user_id"].clone(),json!(role),json!(db.origin)])?[0]["id"].clone())
    }
}

pub fn create_link(db: &mut Db, page: &str) -> Result<(Value, String)> {
    let mut raw = [0u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut raw)?;
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    let id=db.query("insert into page_links (page_id, token_hash, token, origin) values ($1,$2,$3,$4) returning id",&[json!(page),json!(hash),json!(token),json!(db.origin)])?[0]["id"].clone();
    Ok((id, token))
}
pub fn list_links(db: &mut Db, page: &str) -> Result<Vec<Value>> {
    db.query("select id, token, updated_at from page_links where page_id=$1 and not deleted order by updated_at",&[json!(page)])
}

pub fn remote_to_web(remote: &str) -> Option<String> {
    static REMOTE: OnceLock<regex::Regex> = OnceLock::new();
    let m=REMOTE.get_or_init(||regex::Regex::new(r"^(?:git@([^:]+):|ssh://git@([^/:]+)(?::\d+)?/|https?://(?:[^@/]+@)?([^/]+)/)(.+?)(?:\.git)?/?$").unwrap()).captures(trame_core::trim(remote))?;
    Some(format!(
        "https://{}/{}",
        m.get(1).or(m.get(2)).or(m.get(3))?.as_str(),
        m.get(4)?.as_str()
    ))
}
fn repo_url(path: &str) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Mutex::default).lock().unwrap();
    cache
        .entry(path.to_owned())
        .or_insert_with(|| {
            Command::new("git")
                .args(["-C", path, "remote", "get-url", "origin"])
                .stderr(Stdio::null())
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| remote_to_web(&String::from_utf8_lossy(&o.stdout)))
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repo_remote_typescript_assertions() {
        for (remote, expected) in [
            (
                "git@github.com:Getsoren/sre-config.git",
                Some("https://github.com/Getsoren/sre-config"),
            ),
            (
                "ssh://git@gitlab.com:22/obitrain/obi-chart.git",
                Some("https://gitlab.com/obitrain/obi-chart"),
            ),
            (
                "https://x-token:abc@github.com/Andarius/trame.git\n",
                Some("https://github.com/Andarius/trame"),
            ),
            (
                "git@gitlab.com:obitrain/devops/templates.git",
                Some("https://gitlab.com/obitrain/devops/templates"),
            ),
            ("/srv/git/repo.git", None),
        ] {
            assert_eq!(remote_to_web(remote).as_deref(), expected);
        }
    }
}

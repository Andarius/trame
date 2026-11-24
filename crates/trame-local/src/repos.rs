use crate::db::Db;
use anyhow::Result;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
};

/// A folder's git identity: its main checkout (worktrees resolve to it) and normalised remote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub checkout: String,
    pub remote: String,
}

/// `git@github.com:Acme/Web.git`, `https://user@github.com/acme/web/` → `github.com/acme/web`.
pub fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    let (host, path) = if let Some((_, rest)) = url.split_once("://") {
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        (host.split(':').next()?, path)
    } else {
        // scp-like `user@host:owner/repo`; a local path has no `host:`
        let (authority, path) = url.split_once(':')?;
        if authority.contains('/') {
            return None;
        }
        (
            authority.rsplit_once('@').map_or(authority, |(_, h)| h),
            path,
        )
    };
    let path = path.trim_matches('/');
    if host.is_empty() || !path.contains('/') {
        return None;
    }
    Some(format!("{}/{}", host.to_lowercase(), path.to_lowercase()))
}

fn git(dir: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_owned()).filter(|s| !s.is_empty())
}

fn cache() -> &'static Mutex<HashMap<String, Option<Identity>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<Identity>>>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

/// The git identity of a folder, cached per path; None outside a repo or without a remote.
pub fn identity(path: &str) -> Option<Identity> {
    let path = path.trim_end_matches('/');
    if path.is_empty() {
        return None;
    }
    if let Some(hit) = cache().lock().unwrap().get(path) {
        return hit.clone();
    }
    let found = (|| {
        if !Path::new(path).is_dir() {
            return None;
        }
        let common = git(
            path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?;
        let checkout = common.strip_suffix("/.git").unwrap_or(&common).to_owned();
        let remote = git(&checkout, &["remote", "get-url", "origin"]).or_else(|| {
            let first = git(&checkout, &["remote"])?.lines().next()?.to_owned();
            git(&checkout, &["remote", "get-url", &first])
        })?;
        Some(Identity {
            checkout,
            remote: normalize_remote(&remote)?,
        })
    })();
    cache()
        .lock()
        .unwrap()
        .insert(path.to_owned(), found.clone());
    found
}

/// The repo row for a folder, by remote. When two projects list it: `prefer`'s, else the one whose card there moved last.
pub fn repo_for(db: &mut Db, path: &str, prefer: &Value) -> Result<Option<Value>> {
    let Some(id) = identity(path) else {
        return Ok(None);
    };
    let row = db
        .query(
            "select r.id, r.project_id, r.name from project_repos r
              join pages p on p.id = r.project_id and p.kind = 'project' and not p.deleted
             where r.remote = $1 and not r.deleted
             order by (r.project_id = $2::uuid) is true desc,
                      (select max(last_touched) from sessions s where s.repo_id = r.id and not s.deleted) desc nulls last,
                      r.updated_at
             limit 1",
            &[json!(id.remote), prefer.clone()],
        )?
        .into_iter()
        .next();
    if let Some(row) = &row {
        remember_checkout(db, &row["id"], &id.checkout)?;
    }
    Ok(row)
}

// keep the first checkout seen on this machine, unless it is gone
fn remember_checkout(db: &mut Db, repo: &Value, checkout: &str) -> Result<()> {
    let known = db.query(
        "select path from repo_checkouts where repo_id = $1",
        std::slice::from_ref(repo),
    )?;
    let stale = known
        .first()
        .and_then(|r| r["path"].as_str())
        .is_none_or(|p| p != checkout && !Path::new(p).is_dir());
    if stale {
        db.query(
            "insert into repo_checkouts (repo_id, path) values ($1, $2)
             on conflict (repo_id) do update set path = excluded.path",
            &[repo.clone(), json!(checkout)],
        )?;
    }
    Ok(())
}

/// Each project's repos with this machine's checkout, keyed by project id.
pub fn by_project(db: &mut Db) -> Result<HashMap<String, Vec<Value>>> {
    let rows = db.query(
        "select r.id, r.project_id, r.name, r.remote, r.sort_key, c.path
           from project_repos r left join repo_checkouts c on c.repo_id = r.id
          where not r.deleted order by r.sort_key, r.name",
        &[],
    )?;
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    for mut r in rows {
        let project = r["project_id"].as_str().unwrap_or_default().to_owned();
        r.as_object_mut().unwrap().remove("project_id");
        out.entry(project).or_default().push(r);
    }
    Ok(out)
}

/// Fills `repo_id` on cards filed before their repo was listed, from their folder (not written back).
pub fn fill_cards(db: &mut Db, cards: &mut [Value]) -> Result<()> {
    let mut seen: HashMap<(String, String), Value> = HashMap::new();
    for card in cards.iter_mut().filter(|c| c["repo_id"].is_null()) {
        let Some(path) = card["repo_path"].as_str().map(str::to_owned) else {
            continue;
        };
        let key = (path, trame_core::js_string(&card["client_id"]));
        if !seen.contains_key(&key) {
            let repo = repo_for(db, &key.0, &card["client_id"])?;
            seen.insert(key.clone(), repo.map_or(Value::Null, |r| r["id"].clone()));
        }
        card["repo_id"] = seen[&key].clone();
    }
    Ok(())
}

fn add(db: &mut Db, body: &Value) -> Result<(u16, Value)> {
    let project = body["project_id"]
        .as_str()
        .filter(|s| crate::routes::valid_uuid(s));
    let Some(project) = project else {
        return Ok((400, json!({"error":"project_id (uuid) is required"})));
    };
    let is_project = !db
        .query(
            "select 1 from pages where id = $1 and kind = 'project' and not deleted",
            &[json!(project)],
        )?
        .is_empty();
    if !is_project {
        return Ok((404, json!({"error":"no such project"})));
    }
    let path = body["path"].as_str().unwrap_or("");
    let Some(id) = identity(path) else {
        return Ok((400, json!({"error":"not a git folder with a remote"})));
    };
    let name = body["name"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| id.remote.rsplit('/').next().unwrap_or_default().to_owned());
    let existing = db.query(
        "select id from project_repos where project_id = $1 and remote = $2 order by deleted limit 1",
        &[json!(project), json!(id.remote)],
    )?;
    let row = if let Some(r) = existing.first() {
        db.query(
            "update project_repos set deleted = false, name = $2, origin = $3, updated_at = clock_timestamp()
              where id = $1 returning id, name, remote, sort_key",
            &[r["id"].clone(), json!(name), json!(db.origin)],
        )?
    } else {
        db.query(
            "insert into project_repos (project_id, name, remote, sort_key, origin)
             values ($1, $2, $3, coalesce((select max(sort_key) from project_repos where project_id = $1 and not deleted), 'a0') || 'V', $4)
             returning id, name, remote, sort_key",
            &[json!(project), json!(name), json!(id.remote), json!(db.origin)],
        )?
    }
    .remove(0);
    db.query(
        "insert into repo_checkouts (repo_id, path) values ($1, $2) on conflict (repo_id) do update set path = excluded.path",
        &[row["id"].clone(), json!(id.checkout)],
    )?;
    Ok((
        200,
        json!({"id":row["id"],"name":row["name"],"remote":row["remote"],"sort_key":row["sort_key"],"path":id.checkout}),
    ))
}

fn update(db: &mut Db, id: &str, body: &Value) -> Result<(u16, Value)> {
    if let Some(path) = body["path"].as_str() {
        let remote = db.query(
            "select remote from project_repos where id = $1 and not deleted",
            &[json!(id)],
        )?;
        let Some(remote) = remote
            .first()
            .and_then(|r| r["remote"].as_str())
            .map(str::to_owned)
        else {
            return Ok((404, json!({"error":"no such repo"})));
        };
        let Some(found) = identity(path).filter(|i| i.remote == remote) else {
            return Ok((
                400,
                json!({"error":format!("that folder is not a checkout of {remote}")}),
            ));
        };
        db.query(
            "insert into repo_checkouts (repo_id, path) values ($1, $2) on conflict (repo_id) do update set path = excluded.path",
            &[json!(id), json!(found.checkout)],
        )?;
    }
    let name = body["name"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let sort = body["sort_key"].as_str().filter(|s| !s.is_empty());
    if name.is_some() || sort.is_some() {
        db.query(
            "update project_repos set name = coalesce($2, name), sort_key = coalesce($3, sort_key), origin = $4,
                    updated_at = clock_timestamp() where id = $1 and not deleted",
            &[json!(id), json!(name), json!(sort), json!(db.origin)],
        )?;
    }
    Ok((200, json!({"ok":true})))
}

/// Checkouts the project's recent cards worked in whose remote it doesn't list yet.
fn suggest(db: &mut Db, project: &str) -> Result<Value> {
    let folders = db.query(
        "select repo_path from sessions where client_id = $1 and repo_path is not null and not deleted
          group by repo_path order by max(last_touched) desc limit 40",
        &[json!(project)],
    )?;
    let listed: Vec<String> = db
        .query(
            "select remote from project_repos where project_id = $1 and not deleted",
            &[json!(project)],
        )?
        .into_iter()
        .filter_map(|r| r["remote"].as_str().map(str::to_owned))
        .collect();
    let mut out: Vec<Identity> = Vec::new();
    for path in folders.iter().filter_map(|r| r["repo_path"].as_str()) {
        if let Some(id) = identity(path) {
            if !listed.contains(&id.remote) && !out.iter().any(|o| o.remote == id.remote) {
                out.push(id);
            }
        }
    }
    Ok(json!(
        out.iter()
            .take(6)
            .map(
                |i| json!({"path":i.checkout,"remote":i.remote,"name":i.remote.rsplit('/').next()})
            )
            .collect::<Vec<_>>()
    ))
}

pub fn handle(
    db: &mut Db,
    method: &str,
    path: &str,
    query: &str,
    body: &Value,
) -> Option<Result<(u16, Value)>> {
    let parts: Vec<_> = path.strip_prefix("/api/repos")?.split('/').collect();
    Some(match (method, parts.as_slice()) {
        ("GET", ["", "suggest"]) => match crate::sessions::query_param(query, "project").filter(|p| crate::routes::valid_uuid(p)) {
            Some(project) => suggest(db, &project).map(|v| (200, v)),
            None => Ok((400, json!({"error":"project (uuid) is required"}))),
        },
        ("POST", [""]) => add(db, body),
        ("POST", ["", id]) if crate::routes::valid_uuid(id) => update(db, id, body),
        ("POST", ["", id, "delete"]) if crate::routes::valid_uuid(id) => db
            .query(
                "update project_repos set deleted = true, origin = $2, updated_at = clock_timestamp() where id = $1",
                &[json!(id), json!(db.origin)],
            )
            .map(|_| (200, json!({"ok":true}))),
        _ => Ok((404, json!({"error":"not found"}))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_remote_cases() {
        for (url, want) in [
            ("git@github.com:Acme/Web.git", Some("github.com/acme/web")),
            ("https://github.com/acme/web", Some("github.com/acme/web")),
            (
                "https://user:tok@GitLab.com/acme/infra/api.git/",
                Some("gitlab.com/acme/infra/api"),
            ),
            (
                "ssh://git@git.example.com:2222/acme/web.git",
                Some("git.example.com/acme/web"),
            ),
            ("/srv/git/web.git", None),
            ("../web", None),
            ("https://github.com/", None),
        ] {
            assert_eq!(normalize_remote(url).as_deref(), want, "{url}");
        }
    }
}

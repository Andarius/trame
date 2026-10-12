use crate::{
    db::Db,
    imports,
    routes::{Native, json_response, valid_uuid},
    share, terminal,
};
use anyhow::Result;
use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use base64::Engine;
use serde_json::{Value, json};
use std::{
    fs,
    process::{Command, Stdio},
};

pub fn owns(method: &str, path: &str) -> bool {
    method == "POST"
        && (matches!(
            path,
            "/api/open"
                | "/api/resume"
                | "/api/resume-all"
                | "/api/pick-image"
                | "/api/pages/import"
                | "/api/watcher/start"
        ) || matches!(path.split('/').collect::<Vec<_>>().as_slice(),["","api","pages",id,"export"] if !id.is_empty()))
}
pub async fn serve(state: Native, req: Request<Body>) -> Response {
    let path = req.uri().path().to_owned();
    let Ok(bytes) = axum::body::to_bytes(req.into_body(), usize::MAX).await else {
        return (StatusCode::BAD_REQUEST, "body unavailable").into_response();
    };
    let body = if path == "/api/pick-image" || path.ends_with("/export") {
        Value::Null
    } else {
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) => v,
            Err(_) if path == "/api/pages/import" => json!({}),
            Err(_) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
                    .into_response();
            }
        }
    };
    let result = crate::blocking::spawn(move || {
        let mut db = Db::connect(
            &state.root.join("socket"),
            &state.origin,
            Some(state.settings),
        )?;
        db.exclusive(|db| handle(db, state.port, &path, &body))
    })
    .await;
    match result {
        Ok(Ok((status, value))) => json_response(status, value),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response(),
    }
}

fn open(target: &str) -> Result<()> {
    let mut child = Command::new(if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    })
    .arg(target)
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[allow(
    clippy::case_sensitive_file_extension_comparisons,
    reason = "case-sensitive match is intentional for parity"
)]
pub fn handle(db: &mut Db, port: u16, path: &str, body: &Value) -> Result<(u16, Value)> {
    let result = match path {
        "/api/open" => {
            let target = body["target"].as_str().unwrap_or("");
            if !(target.starts_with('/')
                || target.starts_with("http://")
                || target.starts_with("https://"))
            {
                return Ok((400, json!({"error":"invalid target"})));
            }
            open(&if target.starts_with('/') {
                format!("http://127.0.0.1:{port}{target}")
            } else {
                target.to_owned()
            })?;
            json!({"ok":true})
        }
        "/api/pick-image" => pick_image(),
        "/api/pages/import" => {
            let picked = pick_bundle(None);
            let Some(path) = picked.as_str() else {
                return Ok((200, picked));
            };
            let Some(bundle) = fs::read(path)
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            else {
                return Ok((400, json!({"error":"cannot read file"})));
            };
            return Ok(match share::import(db, &bundle, &body["parent_id"]) {
                Ok(id) => {
                    if id.is_null() {
                        (200, json!({}))
                    } else {
                        (200, json!({"id":id}))
                    }
                }
                Err(e) => (400, json!({"error":e.to_string()})),
            });
        }
        "/api/resume" => return resume(db, body),
        "/api/resume-all" => return resume_all(body),
        "/api/watcher/start" => return watcher(db, body),
        _ => {
            let id = path.split('/').nth(3).unwrap_or("");
            let bundle = share::export(db, id)?;
            if bundle.is_null() {
                return Ok((404, json!({"error":"page not found"})));
            }
            let title = bundle["pages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == bundle["root"])
                .and_then(|p| p["title"].as_str())
                .map(trame_core::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("page");
            let safe = regex::Regex::new(r"[^A-Za-z0-9_.-]+")
                .unwrap()
                .replace_all(title, "-")
                .trim_matches('-')
                .chars()
                .take(60)
                .collect::<String>();
            let picked = pick_bundle(Some(&format!(
                "{}.trame.json",
                if safe.is_empty() { "page" } else { &safe }
            )));
            let Some(path) = picked.as_str() else {
                return Ok((200, picked));
            };
            let dest = if path.ends_with(".json") {
                path.to_owned()
            } else {
                format!("{path}.json")
            };
            fs::write(&dest, serde_json::to_string_pretty(&bundle)?)?;
            json!({"path":dest})
        }
    };
    Ok((200, result))
}

fn dialog(commands: Vec<Vec<String>>, image: bool) -> Value {
    for command in commands {
        let Ok(output) = Command::new(&command[0])
            .args(&command[1..])
            .stderr(Stdio::null())
            .output()
        else {
            continue;
        };
        let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !output.status.success() || path.is_empty() {
            return if image {
                json!({"error":"cancelled","cancelled":true})
            } else {
                json!({"cancelled":true})
            };
        }
        return json!(path);
    }
    json!({"error":"no file dialog available (install zenity or kdialog)"})
}
fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| (*s).to_owned()).collect()
}
fn pick_bundle(name: Option<&str>) -> Value {
    let commands = if cfg!(target_os = "macos") {
        vec![strings(&["osascript","-e",&match name{Some(name)=>format!("POSIX path of (choose file name with prompt \"Export page\" default name \"{name}\")"),None=>"POSIX path of (choose file with prompt \"Import page\" of type {\"json\",\"public.json\"})".into()}])]
    } else if let Some(name) = name {
        let filename = format!(
            "{}/{}",
            std::env::var("HOME").unwrap_or_else(|_| ".".into()),
            name
        );
        vec![
            strings(&[
                "zenity",
                "--file-selection",
                "--save",
                "--confirm-overwrite",
                "--title=Export page",
                &format!("--filename={filename}"),
            ]),
            strings(&["kdialog", "--getsavefilename", &filename, "*.json"]),
        ]
    } else {
        vec![
            strings(&[
                "zenity",
                "--file-selection",
                "--title=Import page",
                "--file-filter=Trame page | *.json",
            ]),
            strings(&["kdialog", "--getopenfilename", ".", "*.json"]),
        ]
    };
    dialog(commands, false)
}
fn pick_image() -> Value {
    let commands = if cfg!(target_os = "macos") {
        vec![strings(&[
            "osascript",
            "-e",
            "POSIX path of (choose file with prompt \"Choose an icon\" of type {\"public.image\"})",
        ])]
    } else {
        vec![
            strings(&[
                "zenity",
                "--file-selection",
                "--title=Choose an icon",
                "--file-filter=Images | *.png *.jpg *.jpeg *.gif *.webp *.svg",
            ]),
            strings(&["kdialog", "--getopenfilename", ".", "image/*"]),
        ]
    };
    let picked = dialog(commands, true);
    let Some(path) = picked.as_str() else {
        return picked;
    };
    let Ok(bytes) = fs::read(path) else {
        return json!({"error":format!("cannot read {path}")});
    };
    if bytes.len() > 10_000_000 {
        return json!({"error":"file too large (max 10 MB)"});
    }
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return json!({"error":format!("not an image: .{ext}")}),
    };
    json!({"dataUri":format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes))})
}

fn resume(db: &mut Db, body: &Value) -> Result<(u16, Value)> {
    let Some(id) = body["id"].as_str().filter(|id| valid_uuid(id)) else {
        return Ok((400, json!({"error":"invalid id"})));
    };
    let mode = match body["mode"].as_str() {
        Some("tab") => "tab",
        Some("existing") => "existing",
        _ => "window",
    };
    let (repo, cid, agent, local, home) = if let Some(repo) =
        body["repoPath"].as_str().filter(|s| !s.is_empty())
    {
        (
            Some(json!(repo)),
            id.to_owned(),
            if body["agent"] == "codex" {
                "codex"
            } else {
                "claude"
            },
            true,
            Value::Null,
        )
    } else {
        let rows = db.query(
            "select repo_path,claude_id,agent from sessions where id=$1 and not deleted",
            &[json!(id)],
        )?;
        let row = rows.first();
        let repo = row.map(|r| r["repo_path"].clone());
        let cid = row
            .and_then(|r| r["claude_id"].as_str())
            .filter(|s| valid_uuid(s))
            .unwrap_or(id)
            .to_owned();
        let events=db.query("select summary from session_events where session_id=$1 and kind='import' and not deleted order by at limit 1",&[json!(id)])?;
        let summary = events
            .first()
            .and_then(|e| e["summary"].as_str())
            .unwrap_or("");
        let agent = if row.is_some_and(|r| r["agent"] == "codex")
            || summary.starts_with("Imported from Codex")
        {
            "codex"
        } else {
            "claude"
        };
        let home = summary
            .contains('·')
            .then(|| {
                summary
                    .rsplit('·')
                    .next()
                    .map(trame_core::trim)
                    .filter(|s| !s.is_empty())
            })
            .flatten();
        let local = imports::transcript_is_local(db, agent, &cid)?;
        (repo, cid, agent, local, json!(home))
    };
    let command = if agent == "codex" {
        format!("codex resume {cid}")
    } else {
        format!("claude --resume {cid}")
    };
    let cwd = repo
        .as_ref()
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let full = cwd
        .map(|p| format!("cd {} && {command}", terminal::shq(p)))
        .unwrap_or_else(|| command.clone());
    let mut result = json!({"local":local,"homeNode":home,"cmd":full});
    if let Some(repo) = &repo {
        result["repo"] = repo.clone();
    }
    result["agent"] = json!(agent);
    if trame_core::truthy(&body["probe"]) || cwd.is_none() || !local {
        result["ok"] = json!(local && cwd.is_some());
        result["launched"] = json!(false);
        return Ok((200, result));
    }
    let cwd = cwd.unwrap();
    if mode == "existing"
        || (mode == "tab" && cfg!(target_os = "linux") && !terminal::ghostty_running())
    {
        let r = terminal::in_existing(cwd, &command, mode == "tab");
        if mode == "existing" || r["ok"] == true || r["reason"] == "api-disabled" {
            result["ok"] = r["ok"].clone();
            result["launched"] = r["ok"].clone();
            result["local"] = json!(true);
            result["mode"] = json!(mode);
            if let Some(reason) = r.get("reason") {
                result["reason"] = reason.clone();
            }
            return Ok((200, result));
        }
    }
    let launched = terminal::spawn_terminal(cwd, &command, mode);
    result["ok"] = json!(launched);
    result["launched"] = json!(launched);
    result["local"] = json!(true);
    result["mode"] = json!(mode);
    Ok((200, result))
}
#[allow(
    clippy::unnecessary_wraps,
    reason = "signature kept for parity with sibling handlers"
)]
fn resume_all(body: &Value) -> Result<(u16, Value)> {
    let Some(items) = body["sessions"]
        .as_array()
        .filter(|items| !items.is_empty())
    else {
        return Ok((400, json!({"error":"no sessions"})));
    };
    let items = items
        .iter()
        .filter_map(|s| {
            let id = s["id"].as_str().filter(|id| valid_uuid(id))?;
            let repo = s["repoPath"]
                .as_str()
                .filter(|r| r.starts_with('/') && std::path::Path::new(r).is_dir())?;
            Some((
                repo,
                if s["agent"] == "codex" {
                    format!("codex resume {id}")
                } else {
                    format!("claude --resume {id}")
                },
            ))
        })
        .collect::<Vec<_>>();
    if items.is_empty() {
        return Ok((400, json!({"error":"no resumable sessions"})));
    }
    if cfg!(target_os = "linux") && !terminal::ghostty_running() && terminal::konsole_can_type() {
        let tabbed = items
            .iter()
            .filter(|(repo, cmd)| terminal::in_existing(repo, cmd, true)["ok"] == true)
            .count();
        if tabbed > 0 {
            return Ok((
                200,
                json!({"ok":true,"launched":tabbed,"mode":"konsole-tabs"}),
            ));
        }
    }
    let launched = items
        .iter()
        .filter(|(repo, cmd)| terminal::spawn_terminal(repo, cmd, "window"))
        .count();
    Ok((
        200,
        json!({"ok":launched>0,"launched":launched,"mode":if terminal::ghostty_running(){"ghostty-windows"}else{"windows"}}),
    ))
}
fn watcher(db: &mut Db, body: &Value) -> Result<(u16, Value)> {
    let agent = body
        .get("agent")
        .filter(|v| !v.is_null())
        .map(trame_core::js_string)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if !regex::Regex::new(r"^[a-z0-9][a-z0-9._-]{0,31}$")
        .unwrap()
        .is_match(&agent)
    {
        return Ok((400, json!({"error":"invalid agent"})));
    }
    let page = body["page"].as_str().filter(|s| valid_uuid(s));
    let model = body["model"].as_str().filter(|s| !s.is_empty());
    if model.is_some_and(|m| {
        !regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
            .unwrap()
            .is_match(m)
    }) {
        return Ok((400, json!({"error":"invalid model"})));
    }
    let repo = if let Some(cwd) = body["cwd"].as_str().filter(|s| !s.is_empty()) {
        Some(std::path::PathBuf::from(cwd))
    } else if let Some(page) = page {
        db.query("select repo_path from sessions where not deleted and origin=$2 and (page_id=$1 or specs_page_id=$1) and repo_path is not null and repo_path<>'' order by last_touched desc limit 1", &[json!(page),json!(db.origin)])?
            .first().and_then(|row| row["repo_path"].as_str()).map(std::path::PathBuf::from)
    } else {
        None
    };
    let cwd = repo
        .or_else(|| std::env::var_os("TRAME_WORKSPACE_DIR").map(std::path::PathBuf::from))
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .filter(|p| p.join(".git").exists())
        });
    let Some(cwd) = cwd.filter(|p| p.is_absolute() && p.is_dir()) else {
        return Ok((
            400,
            json!({"error":"working directory unavailable; provide cwd or TRAME_WORKSPACE_DIR"}),
        ));
    };
    let exe = std::env::current_exe()?.with_file_name("tramecli");
    let command = format!(
        "{} answer --agents {agent}{}{} --cwd {}",
        terminal::shq(exe.to_str().unwrap_or("tramecli")),
        page.map(|p| format!(" --page {p}")).unwrap_or_default(),
        model.map(|m| format!(" --model {m}")).unwrap_or_default(),
        terminal::shq(&cwd.to_string_lossy())
    );
    let full = format!("cd {} && {command}", terminal::shq(&cwd.to_string_lossy()));
    if crate::sessions::list_presence(page.unwrap_or(""))
        .as_array()
        .into_iter()
        .flatten()
        .any(|p| {
            p["id"] == format!("watcher:{agent}")
                || page.is_some_and(|page| p["id"] == format!("watcher:{agent}:{page}"))
        })
    {
        return Ok((
            200,
            json!({"ok":false,"launched":false,"cmd":full,"reason":"already-watching"}),
        ));
    }
    let installed = exe.is_file();
    let launched = installed
        && body["probe"] != true
        && terminal::spawn_terminal(&cwd.to_string_lossy(), &command, "window");
    let mut result = json!({"ok":launched,"launched":launched,"cmd":full});
    if !launched {
        result["reason"] = json!(if installed {
            "no-terminal"
        } else {
            "no-script"
        });
    }
    Ok((200, result))
}

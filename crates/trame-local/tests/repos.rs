mod common;
use common::TestDb;
use serde_json::{Value, json};
use std::{path::Path, process::Command};

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.email=t@example.com", "-c", "user.name=t"])
        .args(args)
        .output()
        .unwrap()
        .status
        .success();
    assert!(ok, "git {args:?}");
}

// a clone of `remote` at `dir`, with one commit so worktrees can be added
fn clone(dir: &Path, remote: &str) -> String {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q"]);
    git(dir, &["remote", "add", "origin", remote]);
    git(dir, &["commit", "-q", "--allow-empty", "-m", "init"]);
    dir.to_str().unwrap().to_owned()
}

// through the HTTP front door, which only serves the routes it knows
fn http_post(t: &TestDb, path: &str, body: &Value) -> (u16, Value) {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!("{}{path}", t.base_url()))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .unwrap();
        (
            response.status().as_u16(),
            serde_json::from_str(&response.text().await.unwrap()).unwrap(),
        )
    })
}

fn project(t: &mut TestDb, title: &str) -> Value {
    t.request(
        "POST",
        "/api/pages",
        json!({"title":title,"kind":"project"}),
    )
    .1["id"]
        .clone()
}

// a new card each time: a distinct branch, so the open card on that folder isn't reused
fn card(t: &mut TestDb, mut body: Value) -> Value {
    body["branch"] = json!(uuid::Uuid::new_v4().to_string());
    let id = t.request("POST", "/api/sessions", body).1["id"].clone();
    t.db.query("select client_id, repo_id from sessions where id=$1", &[id])
        .unwrap()
        .remove(0)
}

#[test]
fn cards_file_under_the_project_listing_their_repo() {
    let mut t = TestDb::new();
    let root = t.root.join("src");
    let web = clone(&root.join("web"), "git@github.com:Acme/Web.git");
    git(
        Path::new(&web),
        &["worktree", "add", "-q", ".scratch/wt-fix"],
    );
    git(
        Path::new(&web),
        &["worktree", "add", "-q", "../web-sibling"],
    );
    let plain = root.join("notes");
    std::fs::create_dir_all(&plain).unwrap();
    git(&plain, &["init", "-q"]);
    let (acme, other) = (project(&mut t, "Acme"), project(&mut t, "Other"));

    // a checkout without a remote can't be listed
    let (status, _) = t.request(
        "POST",
        "/api/repos",
        json!({"project_id":acme,"path":plain}),
    );
    assert_eq!(status, 400);
    let (status, repo) = http_post(
        &t,
        "/api/repos",
        &json!({"project_id":acme,"path":format!("{web}/")}),
    );
    assert_eq!(status, 200);
    assert_eq!(
        (repo["name"].as_str(), repo["remote"].as_str()),
        (Some("web"), Some("github.com/acme/web"))
    );

    // the checkout, a nested worktree and a sibling worktree all file under Acme, with the repo
    for path in [
        web.clone(),
        format!("{web}/.scratch/wt-fix"),
        root.join("web-sibling").to_str().unwrap().to_owned(),
    ] {
        let c = card(
            &mut t,
            json!({"title":format!("work in {path}"),"repo_path":path}),
        );
        assert_eq!(
            (&c["client_id"], &c["repo_id"]),
            (&acme, &repo["id"]),
            "{path}"
        );
    }
    // the board lists the repo with this machine's checkout
    let board = t.request("GET", "/api/board", Value::Null).1;
    let listed = &board["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == acme)
        .unwrap()["repos"];
    assert_eq!(listed[0]["path"].as_str(), Some(web.as_str()));

    // a second project listing the same remote: its own cards keep its repo, new cards follow the latest
    let (_, shared) = t.request("POST", "/api/repos", json!({"project_id":other,"path":web}));
    let c = card(
        &mut t,
        json!({"title":"other's card","repo_path":web,"client_id":other}),
    );
    assert_eq!(c["repo_id"], shared["id"]);
    let c = card(&mut t, json!({"title":"unfiled card","repo_path":web}));
    assert_eq!((&c["client_id"], &c["repo_id"]), (&other, &shared["id"]));

    // removed repos no longer file cards
    t.request(
        "POST",
        &format!("/api/repos/{}/delete", shared["id"].as_str().unwrap()),
        Value::Null,
    );
    let c = card(&mut t, json!({"title":"after removal","repo_path":web}));
    assert_eq!((&c["client_id"], &c["repo_id"]), (&acme, &repo["id"]));

    // suggestions: checkouts Acme's cards worked in that it doesn't list (not web, not the remote-less folder)
    let api = clone(&root.join("api"), "https://gitlab.com/acme/api.git");
    std::fs::create_dir_all(format!("{api}/src")).unwrap();
    card(
        &mut t,
        json!({"title":"api work","repo_path":format!("{api}/src"),"client_id":acme}),
    );
    card(
        &mut t,
        json!({"title":"notes","repo_path":plain,"client_id":acme}),
    );
    let url = format!("/api/repos/suggest?project={}", acme.as_str().unwrap());
    let suggested = t.request("GET", &url, Value::Null).1;
    assert_eq!(
        suggested,
        json!([{"path":api,"remote":"gitlab.com/acme/api","name":"api"}])
    );
}

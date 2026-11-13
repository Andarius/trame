// A WebAssembly Trame plugin: `GET /greet?name=…`, `POST /note` (writes a page) and `tramecli hello greet <name>`.
wit_bindgen::generate!({ path: "../../../wit", world: "plugin" });

use serde_json::{Value, json};
use trame::plugin::host;
use trame::plugin::types::{Command, Header};

struct Hello;

fn greeting(name: &str) -> String {
    let settings: Value = serde_json::from_str(&host::settings()).unwrap_or_default();
    let word = settings["greeting"].as_str().unwrap_or("Hello");
    format!("{word}, {name}!")
}

fn json_response(status: u16, body: &Value) -> HttpResponse {
    HttpResponse {
        status,
        headers: vec![Header {
            name: "content-type".into(),
            value: "application/json".into(),
        }],
        body: body.to_string().into_bytes(),
    }
}

impl Guest for Hello {
    fn manifest() -> Manifest {
        Manifest {
            id: "hello".into(),
            label: "Hello".into(),
            glyph: "H".into(),
            description: "Says hello from WebAssembly".into(),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            repo: None,
            commands: vec![Command {
                name: "greet".into(),
                usage: "<name>".into(),
                summary: "print a greeting".into(),
            }],
            hosts: vec![],
            tick_secs: None,
        }
    }

    fn sanitize(raw: String, _current: String) -> String {
        let raw: Value = serde_json::from_str(&raw).unwrap_or_default();
        match raw["greeting"].as_str() {
            Some(word) => json!({"greeting": word.trim()}).to_string(),
            None => "{}".into(),
        }
    }

    fn settings_view(slice: String) -> String {
        slice
    }

    fn route(req: HttpRequest) -> HttpResponse {
        let (path, query) = req.url.split_once('?').unwrap_or((&req.url, ""));
        match (req.method.as_str(), path) {
            ("GET", "/greet") => {
                let name = query.strip_prefix("name=").unwrap_or("world");
                json_response(200, &json!({"text": greeting(name)}))
            }
            ("POST", "/note") => {
                let body: Value = serde_json::from_slice(&req.body).unwrap_or_default();
                let plan = json!([{"op": "create_page", "args": {"title": body["title"]}}]);
                match host::apply(&plan.to_string()) {
                    Ok(out) => {
                        let out: Value = serde_json::from_str(&out).unwrap_or_default();
                        json_response(200, &json!({"id": out[0]}))
                    }
                    Err(error) => json_response(400, &json!({"error": error})),
                }
            }
            _ => json_response(404, &json!({"error": "not found"})),
        }
    }

    fn command(name: String, args: Vec<String>) -> CliReply {
        let who = args.first().map_or("world", String::as_str);
        match name.as_str() {
            "greet" => CliReply {
                code: 0,
                text: greeting(who),
                json: json!({"text": greeting(who)}).to_string(),
            },
            _ => CliReply {
                code: 1,
                text: format!("no command {name}"),
                json: "null".into(),
            },
        }
    }

    fn tick() {}
}

export!(Hello);

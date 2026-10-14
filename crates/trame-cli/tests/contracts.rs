use serde_json::{Value, json};
use trame_cli::{
    board, cli, comment, db, deployments, help, presence, query,
    refs::{RefKind, SessionRef, parse_session_ref},
    setup, watch,
};

#[test]
fn session_ref_precedence_and_rejection() {
    let card = "bcb4e719-2bdb-4a2a-94f6-c8b5e5e35136";
    let page = "3ce5f54e-b00c-4228-82cb-fa3d82392496";
    for (source, want) in [
        (
            card,
            Some(SessionRef {
                kind: RefKind::Session,
                id: card.into(),
            }),
        ),
        (
            &format!("http://localhost/?page={page}&session={card}"),
            Some(SessionRef {
                kind: RefKind::Session,
                id: card.into(),
            }),
        ),
        (
            &format!("http://localhost/?page={page}"),
            Some(SessionRef {
                kind: RefKind::Page,
                id: page.into(),
            }),
        ),
        (
            &format!("http://localhost/?card={card}"),
            Some(SessionRef {
                kind: RefKind::Session,
                id: card.into(),
            }),
        ),
        ("http://localhost/?group=story", None),
        ("not a url", None),
        ("http://localhost/?session=nope", None),
    ] {
        assert_eq!(parse_session_ref(source), want);
    }
}
#[test]
fn cli_help_version_and_staleness() {
    assert!(help::topic("TRACK_HELP").contains("outcome first"));
    assert!(help::topic("TRACK_HELP").contains("One agent session + story = one card"));
    assert!(help::topic("TRACK_HELP").contains("specs_page_id"));
    assert!(help::topic("TRACK_HELP").contains("do not ask the user"));
    assert!(help::topic("PAGE_HELP").contains("{{fold}}"));
    assert!(help::topic("PAGE_DIALECT").contains("green|yellow|red|copper|gray"));
    assert!(help::topic("PAGE_DIALECT").contains("`cards` fence"));
    assert!(help::topic("COMMENT_HELP").contains("meta.model is required"));
    assert!(help::topic("CONVERT_HELP").contains("specs_page_id"));
    for cmd in [
        "track",
        "page",
        "comment",
        "presence",
        "show",
        "watch",
        "answer",
        "list",
        "stories",
        "convert",
        "archive",
        "move",
        "setup",
        "deployments",
        "db",
        "query",
        "mcp",
    ] {
        assert!(help::topic("OVERVIEW").contains(cmd), "{cmd}");
    }
    for kind in [
        "number",
        "text",
        "select",
        "multi_select",
        "date",
        "checkbox",
        "url",
        "relation",
        "formula",
        "rollup",
    ] {
        assert!(help::topic("UDB_CONTRACT").contains(kind), "{kind}");
    }
    assert_eq!(
        help::version(),
        option_env!("TRAME_BUILD")
            .filter(|build| !build.is_empty())
            .map(|build| format!("{}+{build}", env!("CARGO_PKG_VERSION")))
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned())
    );
    for (cli_version, app, path, want) in [
        ("0.13.0", Some("0.13.0"), "/tmp/tramecli", None),
        ("0.13.0+abc", Some("0.13.0"), "/tmp/tramecli", None),
        ("0.14.0", Some("0.13.0"), "/tmp/tramecli", None),
        ("0.13.0", None, "/tmp/tramecli", None),
        (
            "0.13.0",
            Some("0.14.0"),
            "/tmp/dist/tramecli",
            Some("`just setup`"),
        ),
        (
            "0.13.0",
            Some("0.14.0"),
            "/tmp/tramecli",
            Some("releases/latest"),
        ),
    ] {
        let got = cli::stale_warning(cli_version, app, path);
        if let Some(want) = want {
            assert!(got.unwrap().contains(want));
        } else {
            assert!(got.is_none());
        }
    }
}
#[test]
fn db_help_tracks_ui_column_and_chart_vocabulary() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let api = std::fs::read_to_string(root.join("app/web/src/api.ts")).unwrap();
    let chart = std::fs::read_to_string(root.join("app/web/src/udb/chart.ts")).unwrap();
    let contract = help::topic("UDB_CONTRACT");
    let quoted = regex::Regex::new(r#""(\w+)""#).unwrap();
    for (source, pattern) in [
        (&api, r"(?s)export type PropType =(.+?);"),
        (&chart, r"(?s)export type ChartKind =(.+?);"),
        (&chart, r"(?s)export const CHART_AGGS[^=]*=(.+?);"),
    ] {
        let section = regex::Regex::new(pattern)
            .unwrap()
            .captures(source)
            .unwrap()[1]
            .to_owned();
        for word in quoted.captures_iter(&section) {
            assert!(contract.contains(&word[1]), "missing {}", &word[1]);
        }
    }
    let keys = regex::Regex::new(r"(?m)^  (\w+)\??:").unwrap();
    for (source, pattern) in [
        (&api, r"(?s)export type PropConfig = \{(.+?)\n\};"),
        (&chart, r"(?s)export type ChartConfig = \{(.+?)\n\};"),
    ] {
        let section = regex::Regex::new(pattern)
            .unwrap()
            .captures(source)
            .unwrap()[1]
            .to_owned();
        for key in keys.captures_iter(&section) {
            assert!(contract.contains(&key[1]), "missing {}", &key[1]);
        }
    }
}
#[test]
fn setup_embeds_use_the_compiled_binary_contract() {
    for content in [
        setup::TRACK_SKILL,
        setup::TRACK_SKILL_OPENAI,
        setup::PAGE_SKILL,
        setup::WATCH_SKILL,
        setup::TRAME_SKILL,
        setup::PRE_PUSH,
    ] {
        for legacy in [
            "__TRAMECLI__",
            "__TRACK_WRITER__",
            "__PAGE_WRITER__",
            "__PAGE_WATCH__",
        ] {
            assert!(!content.contains(legacy), "legacy marker {legacy}");
        }
    }
}
#[tokio::test]
async fn cli_dispatch_help_version_and_unknown_exit_codes() {
    for args in [
        vec![],
        vec!["--version"],
        vec!["help", "track"],
        vec!["track", "--help"],
        vec!["convert", "--help"],
        vec!["archive", "--help"],
        vec!["move", "--help"],
        vec!["db"],
    ] {
        assert_eq!(
            cli::run(&args.into_iter().map(str::to_owned).collect::<Vec<_>>())
                .await
                .unwrap(),
            0
        );
    }
    assert_eq!(cli::run(&["bogus".into()]).await.unwrap(), 2);
}
#[test]
fn board_grouping_flat_rows_and_query() {
    let board = json!({"sessions":[
        {"id":"s1","title":"repo — fix thing","status":"active","branch":"fix/thing","branches":"fix/thing","next_step":"merge it","pr_url":null,"page_id":"st-1","client_id":"pr-1","repo_path":"/home/dev/repo","last_touched":"2026-09-09T18:42:40.564Z","deleted":false,"tags":["p1"]},
        {"id":"s2","title":"old work","status":"done","branch":null,"next_step":null,"page_id":"st-1","deleted":false},
        {"id":"s3","title":"repo — orphan","status":"paused","branch":null,"next_step":null,"page_id":null,"deleted":false},
        {"id":"s4","title":"gone","status":"active","page_id":null,"deleted":true}
    ],"stories":[{"id":"st-1","title":"Ship the thing"}],
    "pages":[{"id":"st-1","parent_id":"pr-1","kind":"story","title":"Ship the thing","tags":["infra"]},{"id":"pr-1","parent_id":"pr-0","kind":"project","title":"Trame"},{"id":"pr-0","parent_id":null,"kind":"project","title":"Side-projects"}],
    "projects":[{"id":"pr-1","name":"Trame"}],
    "statuses":[{"key":"active","terminal":false},{"key":"paused","terminal":false},{"key":"done","terminal":true}]});
    let out = board::format_board(&board);
    assert!(
        out.contains("Ship the thing\n  [active] repo — fix thing (fix/thing) — next: merge it")
    );
    assert!(out.contains("(no story)\n  [paused] repo — orphan"));
    assert!(!out.contains("old work") && !out.contains("gone"));
    assert_eq!(
        board::format_board(&json!({"sessions":[],"stories":[],"statuses":[]})),
        "no open sessions"
    );
    let rows = board::board_rows(&board);
    assert_eq!(rows.as_array().unwrap().len(), 2);
    assert_eq!(rows[0]["story"], "Ship the thing");
    assert_eq!(rows[0]["branches"], "fix/thing");
    assert_eq!(rows[0]["id"], "s1");
    assert_eq!(rows[0]["title"], "repo — fix thing");
    assert_eq!(rows[0]["status"], "active");
    assert_eq!(rows[0]["branch"], "fix/thing");
    assert_eq!(rows[0]["repo_path"], "/home/dev/repo");
    assert_eq!(rows[0]["last_touched"], "2026-09-09T18:42:40.564Z");
    assert_eq!(rows[0]["next_step"], "merge it");
    assert!(rows[0]["pr_url"].is_null());
    let serialized = rows[0].to_string();
    assert!(serialized.find("\"status\"").unwrap() < serialized.find("\"story\"").unwrap());
    assert!(serialized.find("\"story\"").unwrap() < serialized.find("\"branch\"").unwrap());
    let assigners = json!({"s1":{"name":"Carlo Rossi","avatar":null}});
    for (filter, want) in [
        ("status:active", true),
        ("tag:infra", true),
        ("project:trame", true),
        ("story:ship*", true),
        ("project:side", true), // a parent project matches its subtree
        ("-has:pr", true),
        ("has:branch", true),
        ("repo:dev", true),
        ("title:fix", true),
        ("status:done", false),
        ("no:branch", false),
        ("assigner:carlo", true),
        ("-assigner:carlo", false),
        ("assigner:nobody", false),
        ("has:assigner", true),
        ("no:assigner", false),
        ("title:fix status:", true),
    ] {
        let parsed = query::parse(filter);
        assert!(parsed.errors.is_empty());
        assert_eq!(
            query::matches(&board["sessions"][0], &board, &assigners, &parsed.terms),
            want,
            "{filter}"
        );
    }
    assert_eq!(query::parse("wat:fail").errors, vec!["unknown key \"wat\""]);
    let detached = json!({"client_id":"","page_id":null,"last_touched":"9999-01-01T00:00:00Z"});
    let empty = json!({"pages":[],"projects":[],"statuses":[]});
    assert!(!query::matches(
        &detached,
        &empty,
        &Value::Null,
        &query::parse("has:project").terms
    ));
    assert!(query::matches(
        &detached,
        &empty,
        &assigners,
        &query::parse("no:assigner touched:<badw").terms
    ));
}
#[test]
fn db_columns_and_deployments_merge() {
    let props = json!([
        {"id":"p1","name":"Name","type":"text"},
        {"id":"p2","name":"When","type":"date"},
        {"id":"p3","name":"Related","type":"relation"},
        {"id":"p4","name":"Calc","type":"formula"},
        {"id":"p5","name":"Total","type":"rollup"}
    ]);
    assert_eq!(
        db::resolve_vals(&json!({"Name":"Q3","p2":null}), &props).unwrap(),
        json!({"p1":"Q3","p2":null})
    );
    for (vals, message) in [
        (json!({"unknown":1}), "unknown column"),
        (json!({"Related":"x"}), "not writable"),
        (json!({"Calc":1}), "not writable"),
        (json!({"Total":2}), "not writable"),
    ] {
        assert!(
            db::resolve_vals(&vals, &props)
                .unwrap_err()
                .to_string()
                .contains(message)
        );
    }
    let ships = json!({"a/x":{"pattern":"old","backport":false},"b/y":{"pattern":"keep"}});
    let args = [
        "--pattern",
        "PR-(\\d+)",
        "--env",
        "prod, stage",
        "--backport",
    ]
    .map(str::to_owned);
    let updated = deployments::apply_flags(&ships, "a/x", &args).unwrap();
    assert_eq!(
        updated["a/x"],
        json!({"pattern":"PR-(\\d+)","environments":["prod","stage"],"backport":true})
    );
    assert_eq!(updated["b/y"], ships["b/y"]);
    let env_only = deployments::apply_flags(
        &ships,
        "a/x",
        &["--env".into(), "production, staging".into()],
    )
    .unwrap();
    assert_eq!(
        env_only["a/x"],
        json!({"pattern":"old","backport":false,"environments":["production","staging"]})
    );
    assert!(
        deployments::apply_flags(&ships, "a/x", &["--env".into()])
            .unwrap_err()
            .to_string()
            .contains("--env needs a value")
    );
    assert!(
        deployments::apply_flags(&ships, "a/x", &["--reset".into()])
            .unwrap()
            .get("a/x")
            .is_none()
    );
}
#[test]
fn comment_validation_and_quote_resolution() {
    let content = json!([
        {"id":"b1","type":"todo","text":"Ship {{trame:due=2026-11-01}} carefully"},
        {"id":"b2","type":"text","text":"A shared phrase"},
        {"id":"b3","type":"heading","text":"B shared phrase"}
    ]);
    for (target, want) in [
        (json!({"block_text":"Ship carefully"}), "b1"),
        (json!({"block_text":"carefully"}), "b1"),
        (json!({"block_id":"b2"}), "b2"),
    ] {
        assert_eq!(
            comment::resolve_block(&content, &target).unwrap()["id"],
            want
        );
    }
    assert!(
        comment::resolve_block(&content, &json!({"block_text":"shared phrase"}))
            .unwrap_err()
            .to_string()
            .contains("multiple blocks")
    );
    assert!(
        comment::resolve_block(&content, &json!({"block_id":"missing"}))
            .unwrap_err()
            .to_string()
            .contains("was not found")
    );
    assert!(
        comment::resolve_block(&json!([]), &json!({}))
            .unwrap_err()
            .to_string()
            .contains("no commentable blocks")
    );
    let base = json!({"page_id":"p1","body":"  review  ","agent":"claude","meta":{"model":"gpt","in":1,"out":2,"ms":3}});
    assert_eq!(comment::validate(&base).unwrap(), "claude");
    for (patch, message) in [
        (json!({"body":" "}), "body is required"),
        (json!({"page_title":"x"}), "exactly one"),
        (json!({"meta":null}), "meta.model"),
        (json!({"meta":{"model":"gpt"}}), "meta.in"),
        (json!({"meta":{"model":"gpt","in":1,"out":2}}), "meta.ms"),
        (json!({"meta":{"model":" "}}), "meta.model"),
    ] {
        let mut case = base.clone();
        for (k, v) in patch.as_object().unwrap() {
            case[k] = v.clone();
        }
        assert!(
            comment::validate(&case)
                .unwrap_err()
                .to_string()
                .contains(message)
        );
    }
    let mut custom = base.clone();
    custom["agent"] = json!("glm");
    custom["meta"] = json!({"model":"glm-5"});
    assert_eq!(comment::validate(&custom).unwrap(), "glm");
}
#[test]
fn presence_hooks_usage_provider_and_state() {
    for (event, want) in [
        ("UserPromptSubmit", Some("working")),
        ("PreToolUse", Some("working")),
        ("Notification", Some("waiting")),
        ("Stop", Some("idle")),
        ("SessionEnd", Some("idle")),
        ("PostToolUse", None),
    ] {
        assert_eq!(presence::state_of(event), want);
    }
    let claude = r#"{"type":"assistant","message":{"model":"claude-opus-5-5","usage":{"input_tokens":10,"cache_creation_input_tokens":200,"cache_read_input_tokens":40000,"output_tokens":300}}}"#;
    assert_eq!(
        presence::usage_of(claude),
        json!({"model":"claude-opus-5-5","tokens":40510})
    );
    let codex = "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.5-codex\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":131904},\"model_context_window\":272000}}}";
    assert_eq!(
        presence::usage_of(codex),
        json!({"model":"gpt-5.5-codex","tokens":131_904,"context_max":272_000})
    );
    assert_eq!(presence::usage_of("junk\n{\"type\":\"user\"}"), json!({}));
    for (url, want) in [
        (None, "Anthropic"),
        (Some("https://api.anthropic.com"), "Anthropic"),
        (Some("https://api.z.ai/api/anthropic"), "api.z.ai"),
        (Some("http://localhost:4000"), "localhost:4000"),
        (Some("not a url"), "Anthropic"),
    ] {
        assert_eq!(presence::provider_from_base(url), want);
    }
    for initial in [
        json!({}),
        json!({"hooks":{"Stop":[{"hooks":[{"type":"command","command":"choub notify"}]}]},"model":"x"}),
    ] {
        let once = setup::with_presence_hooks(&initial, "claude");
        let twice = setup::with_presence_hooks(&once, "claude");
        assert_eq!(once, twice);
        assert_eq!(
            once.to_string()
                .matches("tramecli presence --hook claude")
                .count(),
            5
        );
        assert_eq!(once.to_string().matches("tramecli hook").count(), 1);
        assert_eq!(once["model"], initial["model"]);
        assert_eq!(
            once.to_string().contains("choub notify"),
            initial.to_string().contains("choub notify")
        );
    }
}
#[test]
fn watcher_prompt_commands_and_output() {
    let item = json!({"agent":"codex","page":{"title":"Release plan"},"block":{"text":"Ship the release"},
        "thread":[{"author":"Codex","author_id":"00000000-0000-4000-8000-0000000000aa","body":"clarify rollback"},
        {"author":"Julien","author_id":"human","body":"why?"}]});
    let prompt = watch::build_prompt(&item, "codex");
    assert!(watch::build_prompt(&item, "gemini").contains("You are Gemini"));
    assert!(watch::build_prompt(&item, "qwen").contains("You are QWEN"));
    for text in [
        "You are Codex",
        "page \"Release plan\"",
        "> Ship the release",
        "[Codex (you)] clarify rollback",
        "[Julien] why?",
        "Output ONLY the comment body",
    ] {
        assert!(prompt.contains(text), "{text}");
    }
    let command = watch::agent_command("codex", "answer this", None).unwrap();
    assert_eq!(command.cmd, "codex");
    assert_eq!(
        command.args,
        vec!["exec", "--json", "--sandbox", "read-only", "answer this"]
    );
    assert!(command.stdin.is_none());
    assert!(
        !watch::agent_command("claude", "answer", Some("  "))
            .unwrap()
            .args
            .contains(&"--model".to_owned())
    );
    assert!(
        watch::agent_command("claude", "answer", Some("opus"))
            .unwrap()
            .args
            .ends_with(&["--model".into(), "opus".into()])
    );
    assert!(
        watch::agent_command("codex", "answer", Some("gpt"))
            .unwrap()
            .args
            .contains(&"gpt".into())
    );
    let jsonl = "{\"type\":\"thread.started\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Final answer\"}}\n{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":12,\"cached_input_tokens\":10,\"output_tokens\":4}}";
    assert_eq!(
        watch::parse_agent_output("codex", jsonl, 4200, Some("gpt"))["meta"],
        json!({"model":"gpt","in":12,"out":4,"ms":4200})
    );
    assert_eq!(
        watch::parse_agent_output("codex", jsonl, 4200, None)["body"],
        "Final answer"
    );
    let emitted = "{\"type\":\"turn.started\",\"model\":\"gpt-5.7-codex\"}\nnot json, but harmless\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Final answer\"}}\n{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":100,\"output_tokens\":20}}";
    assert_eq!(
        watch::parse_agent_output("codex", emitted, 900, Some("older-model")),
        json!({"body":"Final answer","meta":{"model":"gpt-5.7-codex","in":100,"out":20,"ms":900}})
    );
    let failed = watch::parse_agent_output(
        "codex",
        "{\"type\":\"thread.started\"}\n{\"type\":\"turn.failed\",\"error\":{\"message\":\"boom\"}}",
        700,
        None,
    );
    assert_eq!(failed, json!({"body":"","meta":{"model":"codex","ms":700}}));
    let claude=json!({"result":"  Okay  ","usage":{"input_tokens":2,"cache_read_input_tokens":5,"cache_creation_input_tokens":3,"output_tokens":9},"modelUsage":{"claude-opus":{}},"duration_ms":44}).to_string();
    assert_eq!(
        watch::parse_agent_output("claude", &claude, 900, None),
        json!({"body":"Okay","meta":{"model":"claude-opus","in":10,"out":9,"ms":44}})
    );
    assert_eq!(
        watch::parse_codex_doctor_model(
            r#"{"checks":{"config.load":{"details":{"model":"gpt-5.6-sol"}}}}"#
        ),
        Some("gpt-5.6-sol".into())
    );
    assert!(watch::parse_codex_doctor_model("not json").is_none());
    assert_eq!(
        watch::tokenize(r#"echo "two words" '{}' hello"#),
        vec!["echo", "two words", "{}", "hello"]
    );
}

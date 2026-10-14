use serde_json::{Value, json};
use trame_core::{page_markdown, page_merge, todo_marks};

fn markdown(text: &str, title: &str) -> Vec<Value> {
    page_markdown::markdown_to_page_blocks(text, title, None).unwrap()
}

fn without_ids(blocks: &[Value]) -> Value {
    json!(
        blocks
            .iter()
            .map(|b| {
                let mut b = b.clone();
                b.as_object_mut().unwrap().remove("id");
                b
            })
            .collect::<Vec<_>>()
    )
}

fn text(value: &str, id: &str) -> Value {
    json!({"type":"text","text":value,"id":id})
}

fn folder(path: &str, id: &str) -> Value {
    json!({"type":"folder","path":path,"view":"list","id":id})
}

#[test]
fn markdown_typescript_assertions() {
    // app/page_markdown_test.ts:7 — native blocks, preserved fences and UUIDs.
    let blocks = markdown(
        "# Release plan\n\nIntro with **formatting**.\n\n## Checklist\n\n- [x] Ship writer\n- [ ] Install skill\n\n```ts\nconst answer = 42;\n\nconsole.log(answer);\n```",
        "Release plan",
    );
    assert_eq!(
        without_ids(&blocks),
        json!([
            {"type":"text","text":"Intro with **formatting**."},
            {"type":"heading","text":"Checklist"},
            {"type":"todo","text":"Ship writer","done":true},
            {"type":"todo","text":"Install skill","done":false},
            {"type":"text","text":"```ts\nconst answer = 42;\n\nconsole.log(answer);\n```"}
        ])
    );
    let uuid = regex::Regex::new(
        r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )
    .unwrap();
    for block in &blocks {
        assert!(uuid.is_match(block["id"].as_str().unwrap()));
    }

    // app/page_markdown_test.ts:44 — two spaces or a tab per nesting level.
    assert_eq!(
        without_ids(&markdown(
            "- [ ] parent\n  - [x] child\n\t- [ ] tab child\n      - [ ] deep",
            ""
        )),
        json!([
            {"type":"todo","text":"parent","done":false},
            {"type":"todo","text":"child","done":true,"indent":1},
            {"type":"todo","text":"tab child","done":false,"indent":1},
            {"type":"todo","text":"deep","done":false,"indent":3}
        ])
    );

    // app/page_markdown_test.ts:58 — a different leading title stays content.
    assert_eq!(
        without_ids(&markdown("# Different title\n\nBody", "Page title")),
        json!([
            {"type":"heading","text":"Different title"}, {"type":"text","text":"Body"}
        ])
    );

    // app/page_markdown_test.ts:68 — serialization round trip and structural skip.
    let input = "Intro paragraph.\n\n## Checklist\n\n- [x] Ship writer\n- [ ] Install skill\n  - [ ] on the mac\n\n```ts\nconst answer = 42;\n\nconsole.log(answer);\n```\n";
    let blocks = markdown(input, "");
    let rendered = page_markdown::page_blocks_to_markdown(&blocks).unwrap();
    assert_eq!(without_ids(&markdown(&rendered, "")), without_ids(&blocks));
    assert_eq!(
        page_markdown::page_blocks_to_markdown(&[
            json!({"type":"subpage","page_id":"x"}),
            json!({"type":"heading","text":"Goal"})
        ])
        .unwrap(),
        "## Goal\n"
    );
    assert_eq!(page_markdown::page_blocks_to_markdown(&[]).unwrap(), "");

    // app/page_markdown_test.ts:97 — lone folder lines become native blocks.
    assert_eq!(
        without_ids(&markdown(
            "## Artefacts\n\n{{trame:folder=~/LLMS/Soren/compliance}}\n\n{{trame:folder=./reports}} {{trame:view=gallery}}",
            ""
        )),
        json!([
            {"type":"heading","text":"Artefacts"},
            {"type":"folder","path":"~/LLMS/Soren/compliance","view":"list"},
            {"type":"folder","path":"./reports","view":"gallery"}
        ])
    );

    // app/page_markdown_test.ts:114 — inline, empty and fenced folder marks stay text.
    assert_eq!(
        without_ids(&markdown(
            "Files live in {{trame:folder=~/reports}}.\n\n{{trame:folder=}}\n\n```md\n{{trame:folder=~/reports}}\n```",
            ""
        )),
        json!([
            {"type":"text","text":"Files live in {{trame:folder=~/reports}}."},
            {"type":"text","text":"{{trame:folder=}}"},
            {"type":"text","text":"```md\n{{trame:folder=~/reports}}\n```"}
        ])
    );

    // app/page_markdown_test.ts:133 — folder view round trip and empty-path omission.
    let input = "## Artefacts\n\n{{trame:folder=~/reports}} {{trame:view=gallery}}\n";
    assert_eq!(
        page_markdown::page_blocks_to_markdown(&markdown(input, "")).unwrap(),
        input
    );
    assert_eq!(
        page_markdown::page_blocks_to_markdown(&[folder("~/reports", "b")]).unwrap(),
        "{{trame:folder=~/reports}}\n"
    );
    assert_eq!(
        page_markdown::page_blocks_to_markdown(&[folder("", "b")]).unwrap(),
        ""
    );
}

#[test]
fn embed_markdown_assertions() {
    let ok = "{{trame:embed=https://grafana.example.com/d/abc}} {{trame:height=900}}\n\n{{trame:embed=https://grafana.example.com/d/xyz}}\n";
    let blocks = markdown(ok, "");
    assert_eq!(
        blocks
            .iter()
            .map(|b| (b["type"].as_str(), b["url"].as_str(), b["height"].as_u64()))
            .collect::<Vec<_>>(),
        vec![
            (
                Some("embed"),
                Some("https://grafana.example.com/d/abc"),
                Some(900)
            ),
            (
                Some("embed"),
                Some("https://grafana.example.com/d/xyz"),
                None
            )
        ]
    );
    assert_eq!(page_markdown::page_blocks_to_markdown(&blocks).unwrap(), ok);
    for text in [
        "{{trame:embed=http://a.example.com/}}",
        "{{trame:embed=javascript:alert(1)}}",
        "{{trame:embed=https://a.example.com/x y}}",
        "{{trame:embed=}}",
        "See {{trame:embed=https://a.example.com/}}.",
    ] {
        let blocks = markdown(text, "");
        assert_eq!(blocks.len(), 1, "{text}");
        assert_eq!(blocks[0]["type"], "text", "{text}");
    }
    let tall = markdown(
        "{{trame:embed=https://a.example.com/}} {{trame:height=tall}}",
        "",
    );
    assert!(tall[0].get("height").is_none());
}

#[test]
fn merge_typescript_assertions() {
    // app/page_merge_test.ts:11 — unchanged IDs survive, edited IDs are fresh.
    let next = markdown("## Checklist\n\nNew paragraph.", "");
    assert_eq!(
        page_merge::merge_page_blocks(
            &[
                json!({"type":"heading","text":"Checklist","id":"b1"}),
                text("Old paragraph.", "b2")
            ],
            &next
        ),
        vec![
            json!({"type":"heading","text":"Checklist","id":"b1"}),
            text("New paragraph.", next[1]["id"].as_str().unwrap())
        ]
    );

    // app/page_merge_test.ts:24 — IDs follow reordered text.
    let out = page_merge::merge_page_blocks(
        &[text("one", "b1"), text("two", "b2")],
        &[text("two", "n1"), text("one", "n2")],
    );
    assert_eq!(
        out.iter().map(|b| &b["id"]).collect::<Vec<_>>(),
        vec![&json!("b2"), &json!("b1")]
    );

    // app/page_merge_test.ts:32 — duplicates pair FIFO.
    let out = page_merge::merge_page_blocks(
        &[text("dup", "b1"), text("dup", "b2")],
        &[text("dup", "n1"), text("dup", "n2"), text("dup", "n3")],
    );
    assert_eq!(
        out.iter().map(|b| &b["id"]).collect::<Vec<_>>(),
        vec![&json!("b1"), &json!("b2"), &json!("n3")]
    );

    // app/page_merge_test.ts:40 — trim/type ignored, new done/indent retained.
    assert_eq!(
        page_merge::merge_page_blocks(
            &[text("  Ship it ", "b1")],
            &[json!({"type":"todo","text":"Ship it","done":true,"indent":1,"id":"n1"})]
        ),
        vec![json!({"type":"todo","text":"Ship it","done":true,"indent":1,"id":"b1"})]
    );

    // app/page_merge_test.ts:50 — structural blocks follow surviving anchors.
    assert_eq!(
        page_merge::merge_page_blocks(
            &[
                json!({"type":"database","db_id":"db-0"}),
                json!({"type":"heading","text":"A","id":"b1"}),
                json!({"type":"html","html":"<x>","id":"h1"}),
                text("gone", "b2"),
                json!({"type":"subpage","page_id":"sp-1"})
            ],
            &[
                json!({"type":"heading","text":"A","id":"n1"}),
                text("B", "n2")
            ]
        ),
        vec![
            json!({"type":"database","db_id":"db-0"}),
            json!({"type":"heading","text":"A","id":"b1"}),
            json!({"type":"html","html":"<x>","id":"h1"}),
            json!({"type":"subpage","page_id":"sp-1"}),
            text("B", "n2")
        ]
    );

    // app/page_merge_test.ts:71 — structural-only pages stay at the head.
    assert_eq!(
        page_merge::merge_page_blocks(
            &[json!({"type":"database","db_id":"db-1"})],
            &[text("intro", "n1")]
        ),
        vec![
            json!({"type":"database","db_id":"db-1"}),
            text("intro", "n1")
        ]
    );

    // app/page_merge_test.ts:80 — legacy text drops; unknown blocks survive.
    assert_eq!(
        page_merge::merge_page_blocks(
            &[
                json!({"type":"text","text":"legacy"}),
                json!({"type":"mystery","foo":1})
            ],
            &[text("fresh", "n1")]
        ),
        vec![json!({"type":"mystery","foo":1}), text("fresh", "n1")]
    );

    // app/page_merge_test.ts:88 — empty existing content is unchanged.
    let next = markdown("# Title\n\nBody", "Title");
    assert_eq!(page_merge::merge_page_blocks(&[], &next), next);

    // app/page_merge_test.ts:93 — dropped marks and matching ID survive a rewrite.
    assert_eq!(
        page_merge::merge_page_blocks(
            &[
                json!({"type":"todo","text":"Ship it {{trame:created_at=2026-08-20}}","done":false,"id":"b1"})
            ],
            &[json!({"type":"todo","text":"Ship it","done":true,"id":"n1"})]
        ),
        vec![
            json!({"type":"todo","text":"Ship it {{trame:created_at=2026-08-20}}","done":true,"id":"b1"})
        ]
    );

    // app/page_merge_test.ts:111 — explicit replacement marks win.
    let out = page_merge::merge_page_blocks(
        &[json!({"type":"todo","text":"Ship it {{trame:created_at=2026-08-20}}","id":"b1"})],
        &[json!({"type":"todo","text":"Ship it {{trame:created_at=2026-01-01}}","id":"n1"})],
    );
    assert_eq!(out[0]["text"], "Ship it {{trame:created_at=2026-01-01}}");
    assert_eq!(out[0]["id"], "b1");

    // app/page_merge_test.ts:135 — expressed folder line reuses its existing ID.
    assert_eq!(
        page_merge::merge_page_blocks(
            &[
                json!({"type":"heading","text":"Artefacts","id":"b1"}),
                folder("~/reports", "b2")
            ],
            &markdown(
                "## Artefacts\n\n{{trame:folder=~/reports}} {{trame:view=gallery}}",
                ""
            )
        ),
        vec![
            json!({"type":"heading","text":"Artefacts","id":"b1"}),
            json!({"type":"folder","path":"~/reports","view":"gallery","id":"b2"})
        ]
    );

    // app/page_merge_test.ts:151 — changed folder paths retain IDs, stale folders drop.
    assert_eq!(
        page_merge::merge_page_blocks(
            &[folder("~/old", "b1"), folder("~/gone", "b2")],
            &markdown("{{trame:folder=~/new}}", "")
        ),
        vec![folder("~/new", "b1")]
    );

    // app/page_merge_test.ts:164 — an unexpressed folder remains in place.
    let out = page_merge::merge_page_blocks(
        &[
            json!({"type":"heading","text":"Artefacts","id":"b1"}),
            folder("~/reports", "b2"),
        ],
        &markdown("## Artefacts\n\nNothing to see.", ""),
    );
    assert_eq!(out.len(), 3);
    assert_eq!(out[1], folder("~/reports", "b2"));
}

#[test]
fn todo_marks_typescript_assertions() {
    const CREATED: &str = "{{trame:created_at=2026-08-20}}";
    const DONE: &str = "{{trame:completed_at=2026-08-31}}";

    // app/todo_marks_test.ts:18 — marks parse apart from their visible text.
    for (input, marks, stripped) in [
        ("Ship it".to_owned(), json!({}), "Ship it"),
        (
            format!("Ship it {CREATED}"),
            json!({"created_at":"2026-08-20"}),
            "Ship it",
        ),
        (
            format!("Ship it {CREATED} {DONE}"),
            json!({"created_at":"2026-08-20","completed_at":"2026-08-31"}),
            "Ship it",
        ),
        (
            format!("a {CREATED} b"),
            json!({"created_at":"2026-08-20"}),
            "a b",
        ),
        (
            "a {{trame:created_at=}}".to_owned(),
            json!({"created_at":""}),
            "a",
        ),
        ("a {{green:done}}".to_owned(), json!({}), "a {{green:done}}"),
        (
            format!("a {CREATED} {{{{trame:created_at=2026-01-01}}}}"),
            json!({"created_at":"2026-08-20"}),
            "a",
        ),
    ] {
        assert_eq!(Value::Object(todo_marks::read_marks(&input)), marks);
        assert_eq!(todo_marks::strip_marks(&input), stripped);
    }

    // app/todo_marks_test.ts:44 — a writer's existing mark wins.
    assert_eq!(
        todo_marks::set_mark("Ship it", "created_at", "2026-08-31"),
        "Ship it {{trame:created_at=2026-08-31}}"
    );
    assert_eq!(
        todo_marks::set_mark(&format!("Ship it {CREATED}"), "created_at", "2026-08-31"),
        format!("Ship it {CREATED}")
    );
    assert_eq!(
        todo_marks::set_mark("", "created_at", "2026-08-31"),
        "{{trame:created_at=2026-08-31}}"
    );

    // app/todo_marks_test.ts:60 — removal consumes the mark's separating space.
    assert_eq!(
        todo_marks::remove_mark(&format!("Ship it {CREATED} {DONE}"), "completed_at"),
        format!("Ship it {CREATED}")
    );
    assert_eq!(
        todo_marks::remove_mark("Ship it", "completed_at"),
        "Ship it"
    );

    // app/todo_marks_test.ts:68 — omitted marks carry; explicit replacements win.
    assert_eq!(
        todo_marks::carry_marks(&format!("Ship it {CREATED}"), "Ship it now"),
        format!("Ship it now {CREATED}")
    );
    assert_eq!(
        todo_marks::carry_marks(
            &format!("Ship it {CREATED}"),
            "Ship it {{trame:created_at=2026-01-01}}"
        ),
        "Ship it {{trame:created_at=2026-01-01}}"
    );

    // app/todo_marks_test.ts:80 — completed_at follows done and preserves dates.
    assert_eq!(
        todo_marks::stamp_todo_marks(
            &[
                json!({"type":"todo","text":"open","done":false}),
                json!({"type":"todo","text":"shipped","done":true}),
                json!({"type":"todo","text":format!("reopened {DONE}"),"done":false}),
                json!({"type":"todo","text":format!("dated {CREATED}"),"done":false}),
                json!({"type":"text","text":"not a todo"})
            ],
            "2026-09-01"
        ),
        vec![
            json!({"type":"todo","text":"open {{trame:created_at=2026-09-01}}","done":false}),
            json!({"type":"todo","text":"shipped {{trame:created_at=2026-09-01}} {{trame:completed_at=2026-09-01}}","done":true}),
            json!({"type":"todo","text":"reopened {{trame:created_at=2026-09-01}}","done":false}),
            json!({"type":"todo","text":format!("dated {CREATED}"),"done":false}),
            json!({"type":"text","text":"not a todo"})
        ]
    );

    // app/todo_marks_test.ts:112 — native facade receives local date components.
    assert_eq!(
        trame_core::evaluate_value(&json!({"op":"todayMark","args":[2026,1,5]})).unwrap(),
        "2026-01-05"
    );

    // app/todo_marks_test.ts:116 — updates dedupe, sort, skip creation, cap five.
    for (start, days, expected) in [
        (
            "Ship it {{trame:created_at=2026-08-20}}",
            vec!["2026-08-25"],
            "2026-08-25",
        ),
        (
            "Ship it {{trame:created_at=2026-08-20}}",
            vec!["2026-08-20"],
            "",
        ),
        ("Ship it", vec!["2026-08-25", "2026-08-25"], "2026-08-25"),
        (
            "Ship it",
            vec!["2026-08-25", "2026-08-21"],
            "2026-08-21,2026-08-25",
        ),
        (
            "Ship it",
            vec![
                "2026-08-01",
                "2026-08-02",
                "2026-08-03",
                "2026-08-04",
                "2026-08-05",
                "2026-08-06",
            ],
            "2026-08-02,2026-08-03,2026-08-04,2026-08-05,2026-08-06",
        ),
    ] {
        let out = days.into_iter().fold(start.to_owned(), |text, day| {
            todo_marks::touch_todo(&text, day)
        });
        assert_eq!(
            todo_marks::read_list(&out, "updated_at").join(","),
            expected
        );
    }

    // app/todo_marks_test.ts:157 — updated_at unions both versions.
    assert_eq!(
        todo_marks::read_list(
            &todo_marks::carry_marks(
                "Ship it {{trame:updated_at=2026-08-01,2026-08-09}}",
                "Ship it {{trame:updated_at=2026-08-05}}"
            ),
            "updated_at"
        ),
        vec!["2026-08-01", "2026-08-05", "2026-08-09"]
    );

    // app/todo_marks_test.ts:170 — stamping retains and orders updated_at.
    assert_eq!(
        todo_marks::stamp_todo_marks(
            &[json!({"type":"todo","text":"Ship it {{trame:updated_at=2026-08-05}}","done":false})],
            "2026-09-01"
        ),
        vec![
            json!({"type":"todo","text":"Ship it {{trame:created_at=2026-09-01}} {{trame:updated_at=2026-08-05}}","done":false})
        ]
    );

    // app/todo_marks_test.ts:183 — stranded marks move to the end in order.
    assert_eq!(
        todo_marks::normalize_marks("Mint a client {{trame:created_at=2026-08-11}} (policy scope)"),
        "Mint a client (policy scope) {{trame:created_at=2026-08-11}}"
    );
    assert_eq!(
        todo_marks::normalize_marks(
            "Ship it {{trame:completed_at=2026-08-28}} {{trame:updated_at=2026-08-22}} {{trame:created_at=2026-08-11}}"
        ),
        "Ship it {{trame:created_at=2026-08-11}} {{trame:updated_at=2026-08-22}} {{trame:completed_at=2026-08-28}}"
    );
    assert_eq!(
        todo_marks::normalize_marks("no marks here"),
        "no marks here"
    );
}

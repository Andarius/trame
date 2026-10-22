# Templates

Starting points for a plugin with id `demo`. Replace `demo`, `Demo` and `owner/trame-demo`.
Each block is the whole file unless marked otherwise.

## src/mod.rs

```rust
// Demo plugin: <what it reads>, polled from <where>. Live state is a module-level snapshot.
use crate::plugins::api::{Native, Plugin, RouteFuture, blocking, json_response, settings};
use axum::{body::Body, http::Request};
use serde_json::{Value, json};
use std::{
    sync::{LazyLock, Mutex},
    time::Duration,
};

mod poll; // src/poll.rs: the network or subprocess part, pure functions where possible

pub const ID: &str = "demo";
// keep in step with version.ts (version_test.ts checks it)
const VERSION: &str = "0.1.0";
const REPO: &str = "owner/trame-demo";

static STATE: LazyLock<Mutex<Value>> = LazyLock::new(|| Mutex::new(json!({"items": [], "polledAt": null, "error": null})));

fn text(v: &Value) -> String {
    v.as_str().unwrap_or("").trim().to_owned()
}

/// Allowlisted patch: the registry stores exactly what this returns.
pub fn sanitize(raw: &Value, current: &Value) -> Value {
    let mut out = if current.is_object() { current.clone() } else { json!({}) };
    if let Some(n) = raw["pollSeconds"].as_i64() {
        out["pollSeconds"] = json!(n.clamp(15, 3600));
    }
    if let Some(list) = raw["sources"].as_array() {
        out["sources"] = json!(list.iter().map(text).filter(|s| !s.is_empty()).collect::<Vec<_>>());
    }
    if raw.get("token").is_some() {
        // a blank token keeps the stored one; never echoed back (see settings_view)
        let t = text(&raw["token"]);
        if !t.is_empty() {
            out["token"] = json!(t);
        }
    }
    out
}

pub fn settings_view(slice: &Value) -> Value {
    json!({
        "pollSeconds": slice["pollSeconds"].as_i64().unwrap_or(60),
        "sources": slice["sources"].as_array().cloned().unwrap_or_default(),
        "hasToken": slice["token"].as_str().is_some_and(|t| !t.is_empty()),
    })
}

async fn refresh(native: &Native) {
    let slice = settings::plugin(&native.settings, ID);
    match poll::fetch(&slice).await {
        Ok(items) => *STATE.lock().unwrap() = json!({"items": items, "polledAt": chrono::Utc::now(), "error": null}),
        // keep the last good items, flag the error
        Err(e) => STATE.lock().unwrap()["error"] = json!(e.to_string()),
    }
}

pub struct Demo;
pub static PLUGIN: Demo = Demo;

impl Plugin for Demo {
    fn id(&self) -> &'static str {
        ID
    }
    fn label(&self) -> &'static str {
        "Demo"
    }
    fn glyph(&self) -> &'static str {
        "◇"
    }
    fn description(&self) -> &'static str {
        "One line, shown in the plugins manager."
    }
    fn version(&self) -> Option<(&'static str, &'static str)> {
        Some((VERSION, REPO))
    }
    fn badge(&self, _slice: &Value) -> Option<u64> {
        let n = STATE.lock().unwrap()["items"].as_array().map_or(0, Vec::len);
        (n > 0).then_some(n as u64)
    }
    fn ungated(&self, sub: &str) -> bool {
        sub == "/probe" // a connection test, reachable before enabling
    }
    fn sanitize(&self, raw: &Value, current: &Value) -> Value {
        sanitize(raw, current)
    }
    fn settings_view(&self, slice: &Value) -> Value {
        settings_view(slice)
    }
    fn start(&'static self, native: Native) -> Option<tokio::task::JoinHandle<()>> {
        Some(tokio::spawn(async move {
            loop {
                let slice = settings::plugin(&native.settings, ID);
                if slice["enabled"] == true {
                    refresh(&native).await;
                }
                let every = slice["pollSeconds"].as_u64().unwrap_or(60).clamp(15, 3600);
                tokio::time::sleep(Duration::from_secs(every)).await;
            }
        }))
    }
    fn on_enabled(&'static self, native: &Native) {
        let native = native.clone();
        tokio::spawn(async move { refresh(&native).await });
    }
    fn stop(&'static self) {
        // kill what start() or a route spawned (process groups, temp servers); nothing here
    }
    fn route(&'static self, native: Native, sub: String, req: Request<Body>) -> RouteFuture {
        Box::pin(async move {
            match (sub.as_str(), req.method().as_str()) {
                ("/state", "GET") => json_response(200, STATE.lock().unwrap().clone()),
                ("/refresh", "POST") => {
                    refresh(&native).await;
                    json_response(200, STATE.lock().unwrap().clone())
                }
                ("/probe", "GET") => json_response(200, json!({"ok": true})),
                // blocking work (database, subprocess) leaves the async runtime
                ("/count", "GET") => match blocking(move || poll::count_on_disk(&native.root)).await {
                    Ok(Ok(n)) => json_response(200, json!({"count": n})),
                    _ => json_response(500, json!({"error": "count failed"})),
                },
                _ => json_response(404, json!({"error": "not found"})),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_allowlists_and_keeps_a_stored_token_on_blank() {
        let current = json!({"token": "secret", "pollSeconds": 60});
        let out = sanitize(&json!({"pollSeconds": 5, "token": " ", "x": 1}), &current);
        assert_eq!(out, json!({"token": "secret", "pollSeconds": 15}));
        assert_eq!(settings_view(&out)["hasToken"], true);
        assert!(settings_view(&out).get("token").is_none());
    }
}
```

A route that proxies or streams returns any axum `Response`: build it with
`axum::response::Response::builder()` and `Body::from_stream(...)`, or upgrade with
`axum::extract::ws::WebSocketUpgrade::from_request(req, &()).await` (see `notebook.rs` in Trame
for both). Routes run inside Trame's process: a panic takes the app down, so handle errors.

## version.ts

```ts
// Plugin release identity: Trame compares VERSION with the latest GitHub release of REPO.
// src/mod.rs carries the same two constants; version_test.ts keeps them equal.
export const VERSION = "0.1.0";
export const REPO = "owner/trame-demo";

/** Why a pushed tag cannot release this version, or null when it matches (`v` prefix optional). */
export function tagMismatch(tag: string, version = VERSION): string | null {
  const bare = tag.replace(/^refs\/tags\//, "").replace(/^v/, "");
  return bare === version ? null : `tag ${tag} does not match plugin version ${version} (version.ts)`;
}

if (import.meta.main) {
  const error = tagMismatch(process.argv[2] ?? "");
  if (error) {
    console.error(error);
    process.exit(1);
  }
}
```

## web/index.ts

```ts
import type { FrontendPlugin } from "@trame/web-api";
import { DemoPanel } from "./Panel.tsx";
import { DemoSettings } from "./Settings.tsx";

export default {
  id: "demo",
  Panel: DemoPanel,
  column: true, // drop it when the panel should fill the pane on its own
  Settings: DemoSettings,
} satisfies FrontendPlugin;
```

## web/Panel.tsx (shape)

```tsx
import { useEffect, useState } from "react";
import { type PanelProps, SidebarColumn } from "@trame/web-api";

export function DemoPanel({ column, onOpenSettings }: PanelProps) {
  const [state, setState] = useState<{ items: string[] } | null>(null);
  useEffect(() => {
    void fetch("/api/plugins/demo/state").then((r) => r.json()).then(setState);
  }, []);
  return (
    <div className="flex h-full min-h-0 flex-col text-ink">
      <SidebarColumn column={column}>
        <nav className="flex flex-col gap-0.5">{/* list that lives in the host's sidebar column */}</nav>
      </SidebarColumn>
      <div className="flex-1 overflow-auto p-4">
        {state?.items.length ? state.items.map((i) => <div key={i}>{i}</div>) : (
          <button type="button" onClick={onOpenSettings} className="text-copper">Configure…</button>
        )}
      </div>
    </div>
  );
}
```

## web/Settings.tsx (shape)

```tsx
import { useEffect, useState } from "react";
import { FieldRow, getPluginSettings, savePluginSettings } from "@trame/web-api";

export function DemoSettings() {
  const [slice, setSlice] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    void getPluginSettings("demo").then(setSlice);
  }, []);
  if (!slice) return <div className="p-4 text-[12px] text-ink-muted">Loading…</div>;
  const save = (patch: Record<string, unknown>) => void savePluginSettings("demo", patch).then(setSlice);
  return (
    <div className="text-[12px] text-ink-soft">
      <FieldRow label="Every">
        <input type="number" min={15} defaultValue={Number(slice.pollSeconds ?? 60)} onBlur={(e) => save({ pollSeconds: Number(e.target.value) })} />
      </FieldRow>
    </div>
  );
}
```

## web/boundary_test.ts

```ts
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

// The web side reaches Trame only through "@trame/web-api".
const ok = (s: string) => s.startsWith("./") || s === "../model.ts" || s === "react" || s === "@trame/web-api";

test("the web side imports Trame only through @trame/web-api", () => {
  const bad: string[] = [];
  const root = new URL("./", import.meta.url);
  for (const name of readdirSync(root)) {
    if (!/\.tsx?$/.test(name) || name.endsWith("_test.ts")) continue;
    const src = readFileSync(new URL(name, root), "utf8");
    const specs = [
      ...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm),
      ...src.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g),
    ];
    for (const [, spec] of specs) if (!ok(spec)) bad.push(`${name}: ${spec}`);
  }
  expect(bad).toEqual([]);
});
```

Add a third-party web dependency (say `d3-force`) to the predicate only after adding it to
Trame's `app/web/package.json`: the plugin resolves packages through the symlinked
`node_modules` and the runtime bundle inlines them. The Rust side has no boundary test: the
compiler is the boundary, and `crate::plugins::api` is the supported surface.

## version_test.ts

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { REPO, tagMismatch, VERSION } from "./version.ts";

test.each([
  { id: "exact", tag: "v0.1.0", want: null },
  { id: "no prefix", tag: "0.1.0", want: null },
  { id: "full ref", tag: "refs/tags/v0.1.0", want: null },
  { id: "other version", tag: "v0.2.0", want: "tag v0.2.0 does not match plugin version 0.1.0 (version.ts)" },
])("tagMismatch: $id", ({ tag, want }) => {
  expect(tagMismatch(tag, "0.1.0")).toBe(want);
});

test("src/mod.rs carries the same version and repo", () => {
  const rs = readFileSync(new URL("./src/mod.rs", import.meta.url), "utf8");
  expect(rs).toContain(`const VERSION: &str = "${VERSION}";`);
  expect(rs).toContain(`const REPO: &str = "${REPO}";`);
});
```

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": ["bun"],
    "typeRoots": ["../trame/node_modules/@types"],
    "paths": {
      "@trame/web-api": ["../trame/app/web/src/plugin-api.ts"]
    }
  },
  "include": ["*.ts", "web", "e2e", "../trame/types.d.ts"]
}
```

Adjust `../trame` when the plugin does not sit beside the Trame checkout.

## .gitignore

```
node_modules
.scratch
```

## .github/workflows/ci.yml

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          repository: Andarius/trame
          path: trame

      - uses: actions/checkout@v7
        with:
          path: trame-demo

      - uses: actions/setup-node@v6
        with:
          node-version: "22"
          cache: npm
          cache-dependency-path: trame/app/web/package-lock.json

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.11"

      - name: Rust toolchain (Trame's rust-toolchain.toml)
        run: cd trame && rustup show active-toolchain

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: trame

      - name: Compose the plugin into Trame
        run: |
          echo '{ "plugins": ["../trame-demo"] }' > trame/plugins.local.json
          cd trame && bun install --frozen-lockfile && (cd app/web && npm ci) && bun scripts/gen-plugins.ts

      - name: Backend under Trame's lints and the plugin's unit tests
        run: |
          cd trame && mkdir -p .scratch
          cargo clippy -p trame-local --all-targets --locked -- -D warnings
          cargo test -p trame-local --locked --lib local_gen::

      - name: Web typecheck, lint and tests
        run: |
          (cd trame/app/web && npm run typecheck)
          cd trame-demo
          ../trame/node_modules/.bin/oxlint -c ../trame/.oxlintrc.json web
          bun test
```

Pin the actions to commit SHAs in the real file. Composed modules live under
`plugins::local_gen`, so the `local_gen::` filter runs only the plugin's `#[cfg(test)]` tests;
Trame's own unit tests expect a prepared `.scratch` and its integration tests need PostgreSQL
binaries, both of which stay in Trame's CI.

## .github/workflows/release.yml

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.11"

      - name: Tag matches the plugin version
        run: bun version.ts "$GITHUB_REF_NAME"

      - name: Create the GitHub release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" --verify-tag --generate-notes --title "$GITHUB_REF_NAME"
```

## mark-roles.json (only for plugins that write page marks)

```json
[
  { "mark": "trame:demo", "value": "^.+$", "role": "story" }
]
```

`value` is a regular expression on the mark's value; `role` is what the hierarchy makes of a
page carrying it (see `core/mark-roles.ts` in Trame).

## e2e/demo.spec.ts (shape)

```ts
import { expect, test } from "@playwright/test";

// runs inside Trame's e2e project with the plugin composed; the fixture base URL is Trame's
test("the panel lists what the backend polled", async ({ page, request }) => {
  await request.post("/api/plugins/demo/enable", { data: { enabled: true } });
  await page.goto("/?plugin=demo");
  await expect(page.getByRole("button", { name: "Configure…" })).toBeVisible();
});
```

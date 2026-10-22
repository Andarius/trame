---
name: trame-plugin
description: Write, test, compose, ship and release an out-of-tree Trame plugin (a native Rust module on `crate::plugins::api`, a `web/index.ts` frontend on `@trame/web-api`). Use when creating a new Trame plugin repo, adding a panel, settings, routes or sidebar column to one, wiring its CI against Trame, or cutting a release that Trame announces as an update.
---

# Trame plugin

A Trame plugin is its own git repo, composed into a Trame checkout at build time. Nothing is
loaded at runtime from arbitrary paths: `scripts/gen-plugins.ts` writes registries that include
the plugin statically. The backend is a Rust module compiled into `trame-local` itself (a
`#[path]` module, so it uses the crate's dependencies and runs in the app's process), the
frontend goes into one `plugins.js` bundle. There is no other backend shape: the TypeScript
`mod.ts` plugins of the Bun host era were ported (`Getsoren/trame-k8s`, `Getsoren/trame-cockpit`
are out-of-tree examples). The in-tree plugins show the shape in use:
`crates/trame-local/src/plugins/notebook.rs` (a server the plugin spawns or attaches to, a
same-origin proxy with WebSockets, a full-pane panel), `sql_source.rs` (settings with secrets,
a poll loop, database writes), `deployments.rs` (a sidebar column, forge auth, fixtures).

Read `crates/trame-local/src/plugins/api.rs` and `app/web/src/plugins/index.ts` in the Trame
checkout before coding: they are the contract, and this skill paraphrases them.

## Layout

```
my-plugin/
  src/mod.rs          backend: `pub static PLUGIN` implementing crate::plugins::api::Plugin
  src/*.rs            submodules (`mod x;` next to mod.rs), unit tests in #[cfg(test)]
  version.ts          VERSION + REPO, and the tag check the release workflow runs
  web/index.ts        FrontendPlugin (default export), imports Trame only via "@trame/web-api"
  web/*.tsx           Panel, Settings, …   (react, @trame/web-api, ./ and ../model.ts only)
  web/*_test.ts       bun tests for pure web logic (boundary_test.ts is mandatory)
  e2e/*.spec.ts       optional Playwright specs, run by Trame's own e2e project
  mark-roles.json     optional: what the plugin's page marks mean to the hierarchy
  tsconfig.json       types from ../trame/node_modules for the web side
  .github/workflows/  ci.yml (compose into Trame, clippy, tests, typecheck) and release.yml
  .gitignore          node_modules (a symlink gen-plugins creates) and .scratch
```

The backend reaches Trame only through `crate::plugins::api` (the trait, `Native`, `Db`,
`settings`, `json_response`, `blocking`). Other `crate::` paths compile today and may break
tomorrow. It uses the dependencies `trame-local` already declares (axum, reqwest,
tokio-tungstenite, serde_json, chrono, …); a new dependency is a Trame PR. The frontend never
imports `react-dom`, Trame internals, or its own copy of React: the runtime bundle takes React
and `@trame/web-api` from `window.__trame`. Templates for every file: `references/templates.md`.

## Backend contract (`src/mod.rs`)

`Plugin` methods (`crates/trame-local/src/plugins/api.rs`):

- `id()` is the URL slug and the settings key; `label()`, `glyph()`, `description()` show in the plugins manager.
- `version()` returns `Some((VERSION, "owner/name"))` so Trame compares the build against the latest GitHub release and shows "Update available". Mirror both in `version.ts` for the release workflow.
- `route(native, sub, req)` answers `/api/plugins/<id><sub>` with the whole axum request and returns a boxed future of a full `Response`: stream, set headers, proxy, upgrade WebSockets (see `notebook.rs`). The registry has already gated it. Return `json_response(404, …)` for unknown paths.
- `ungated(sub)` names the sub paths reachable while disabled (a connection test used from the settings UI before enabling).
- `start(native)` runs once at boot whether enabled or not and returns the task to abort at exit. Own the loop and check `settings::plugin(&native.settings, id)["enabled"]` on every tick, so toggling needs no teardown. `on_enabled(native)` refreshes right away instead of waiting a tick.
- `stop()` runs when Trame exits: kill what you spawned (process groups, see `notebook::shutdown`).
- `badge(slice)` reads in-memory state or the settings slice it is handed. No other I/O.
- `sanitize(raw, current)` is **required for any plugin with settings**: the registry saves what it returns, so the default stores nothing. Allowlist each field, coerce types, drop the rest. `settings_view(slice)` redacts the GET: never echo a token, return `hasToken` booleans. A secret that only has to live as long as the process (a token you generated) stays in memory, not in the slice.
- `/enable` and `/settings` are owned by the registry. Do not route them.

Live state is a `static` behind a `Mutex` refreshed by the plugin's own loop. Keep the last good
state and flag the error rather than blanking the UI on one failed poll. Blocking work (database,
subprocesses) goes through `blocking(move || …).await`; the database is `Db::connect(&native.root
.join("socket"), &native.origin, Some(native.settings.clone()))`. Writing pages or sessions syncs
to the hub and to other devices, so gate it behind an explicit setting, never behind "enabled"
alone.

## Frontend contract (`web/index.ts`)

`FrontendPlugin` slots (`app/web/src/plugins/index.ts`): `Panel` (own rail entry and view; it
fills the pane, an iframe or a table is fine), `column: true` (the Panel receives
`PanelProps.column` and renders its list into the host's sidebar column through `SidebarColumn`),
`Settings`, `PageHeader`, `DatabaseActions`, `DatabaseEmpty`, `CardBadge`, `useCardFaces`,
`CardFields`, `metadataMarks`. Declare only the slots you fill. The host renders them and never
names the plugin. There is no slot for a new block type: that is an editor change in Trame.

From `@trame/web-api`: `getPluginSettings(id)` / `savePluginSettings(id, patch)` (GET/POST
`/api/plugins/<id>/settings`), `openInBrowser(url)`, `FieldRow`, `Select`, `timeAgo`,
`SidebarColumn`, types `PanelProps`, `CardFace`, `PageDetail`, `Session`. Tailwind classes work
because gen-plugins points Tailwind at `web/` (`@source`); use the host's tokens (`text-ink`,
`bg-panel`, `border-line`, `text-copper`, …) rather than raw colours. No modal portal exists in
the API: a dialog is a `fixed inset-0` overlay rendered inside the panel.

Plain `fetch("/api/plugins/<id>/…")` reaches your own routes; the same origin also serves
WebSockets your route upgrades. Preferences that need no sync go to `localStorage` wrapped in
try/catch; anything shared goes through the settings slice.

## Compose and run locally

In the Trame checkout, with the plugin next to it:

```bash
echo '{ "plugins": ["../my-plugin"] }' > plugins.local.json   # gitignored, several paths allowed
just plugins          # gen registries (Rust + web) + symlink my-plugin/node_modules → app/web/node_modules
just dev              # desktop app from this checkout with the plugin compiled in (isolated data)
just serve            # same backend without the window, for curl and Playwright
```

The Rust registry is `crates/trame-local/src/plugins/local.gen.rs` (a `#[path]` module per
plugin), the web one `app/web/src/plugins/local.gen.ts`; both are `--skip-worktree` while
composed: never commit them in Trame. A backend change needs a rebuild (`just dev` again), a web
change `npm run build` in `app/web` and a reload.

## Checks

From the Trame checkout, with the plugin composed:

```bash
cargo clippy -p trame-local --all-targets --locked -- -D warnings   # the plugin compiles under Trame's lints
cargo test -p trame-local --locked --lib                            # your #[cfg(test)] tests run with the crate's
(cd app/web && npm run typecheck)                                   # web side
(cd ../my-plugin && ../trame/node_modules/.bin/oxlint -c ../trame/.oxlintrc.json web && bun test)
just e2e                                                            # runs e2e/*.spec.ts as its own project
```

CI reproduces this: check out `Andarius/trame` beside the plugin, write `plugins.local.json`,
`bun install` + `npm ci` + `bun scripts/gen-plugins.ts`, install the toolchain from Trame's
`rust-toolchain.toml`, then the same commands. A plugin that uses a new `Plugin` or
`FrontendPlugin` method fails CI until that Trame change is on `master`, so merge the Trame PR
first and re-run. Integration tests that need PostgreSQL stay in Trame's own suite.

Tests: pure parsing, URL mapping and settings sanitizing are the high-value targets, as
`#[test]` tables in the module. `web/boundary_test.ts` lists the allowed import specifiers and
fails on anything else.

## Release

`version.ts` holds `VERSION` and `REPO`; `src/mod.rs` returns the same pair from `version()`
(`version_test.ts` keeps them equal). `release.yml` runs on `v*` tags: it runs
`bun version.ts "$GITHUB_REF_NAME"` (refuses a tag that differs from `VERSION`) then
`gh release create --verify-tag --generate-notes`. To ship: bump `VERSION`, merge,
`git tag vX.Y.Z <merge commit>`, `git push origin vX.Y.Z`. Trame checks the latest release hourly
and shows "Update available" in the plugins manager and Settings.

## Conventions

Terse one-line comments on non-obvious lines only; English everywhere. The README has three
sections: Use (the compose command, what the plugin reads and writes, what it never touches),
Test, Release. Nothing network-facing happens until the plugin is enabled and configured.

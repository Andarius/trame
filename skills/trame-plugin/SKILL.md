---
name: trame-plugin
description: Write, test, compose, ship and release an out-of-tree Trame plugin (a `mod.ts` backend on `@trame/plugin-api`, a `web/index.ts` frontend on `@trame/web-api`). Use when creating a new Trame plugin repo, adding a panel, settings, routes or sidebar column to one, wiring its CI against Trame, or cutting a release that Trame announces as an update.
---

# Trame plugin

A Trame plugin is its own git repo, composed into a Trame checkout at build time. Nothing is
loaded at runtime from arbitrary paths: `scripts/gen-plugins.ts` writes registries that import
the plugin statically, the backend is compiled into one `plugin-host` Bun binary, the frontend
into one `plugins.js` bundle. The in-tree `deployments` plugin (`app/plugins/deployments`,
`app/web/src/plugins/deployments`) shows the slots in use; out-of-tree examples are
`Getsoren/trame-k8s` (panel, sidebar column, settings, routes, release) and
`Getsoren/trame-cockpit` (database writes, mark roles, e2e specs).

Read `app/plugins/types.ts` and `app/web/src/plugins/index.ts` in the Trame checkout before
coding: they are the contract, and this skill paraphrases them.

## Layout

```
my-plugin/
  mod.ts              backend Plugin (default export), imports Trame only via "@trame/plugin-api"
  settings.ts         sanitizeSettings + typed read of the settings slice
  version.ts          VERSION + REPO, and the tag check the release workflow runs
  *_test.ts           bun tests next to the code (boundary_test.ts is mandatory)
  web/index.ts        FrontendPlugin (default export), imports Trame only via "@trame/web-api"
  web/*.tsx           Panel, Settings, …   (react, @trame/web-api, ./ and ../model.ts only)
  e2e/*.spec.ts       optional Playwright specs, run by Trame's own e2e project
  mark-roles.json     optional: what the plugin's page marks mean to the hierarchy
  tsconfig.json       paths to ../trame/app/plugins/api.ts, types from ../trame/node_modules
  .github/workflows/  ci.yml (compose into Trame, typecheck, lint, test) and release.yml
  .gitignore          node_modules (a symlink gen-plugins creates) and .scratch
```

Only the imports allowed by `boundary_test.ts` cross into Trame. The plugin never imports
`react-dom`, Trame internals, or its own copies of React: the runtime bundle takes React and
`@trame/web-api` from `window.__trame`. Templates for every file: `references/templates.md`.

## Backend contract (`mod.ts`)

`Plugin` fields (`app/plugins/types.ts`):

- `id` is the URL slug and the settings key; `label`, `glyph`, `description` show in the plugins manager.
- `version` and `repo` (`owner/name` on GitHub) make Trame compare the build against the latest release and show "Update available". Keep them in `version.ts` so the release workflow can check the tag.
- `routes(req, subPath, url)` answers `/api/plugins/<id>/<subPath>`; return `null` for 404. Every route 403s while the plugin is disabled unless listed in `ungatedRoutes` (a connection test used before enabling).
- `start(ctx)` runs once at boot whether enabled or not. Own the loop: `setTimeout` or `setInterval`, and check `await ctx.enabled()` on every tick, so toggling needs no teardown. `onEnabled()` refreshes right away instead of waiting a tick.
- `badge()` reads in-memory state only. No I/O.
- `sanitizeSettings(raw, current)` is **required for any plugin with settings**: the registry saves `plugin.sanitizeSettings?.(raw, current) ?? {}`, so without it every save stores nothing. Allowlist each field, coerce types, drop the rest. `settingsView(slice)` redacts the GET: never echo a token, return `hasToken` booleans.
- `/enable` and `/settings` are owned by the registry. Do not implement them.

Live state is a module-level snapshot refreshed by a self-rescheduling poll (see
`mod.ts` of trame-k8s). Keep the last good state and flag the error rather than blanking the UI
on one failed poll. Writing to Trame's database (`createPage`, `upsertSession`, …) syncs to the
hub and to other devices, so gate it behind an explicit setting, never behind "enabled" alone.

## Frontend contract (`web/index.ts`)

`FrontendPlugin` slots (`app/web/src/plugins/index.ts`): `Panel` (own sidebar view),
`column: true` (the Panel receives `PanelProps.column` and renders its list into the host's
sidebar column through `SidebarColumn`), `Settings`, `PageHeader`, `DatabaseActions`,
`DatabaseEmpty`, `CardBadge`, `useCardFaces`, `CardFields`, `metadataMarks`. Declare only the
slots you fill. The host renders them and never names the plugin.

From `@trame/web-api`: `getPluginSettings(id)` / `savePluginSettings(id, patch)` (GET/POST
`/api/plugins/<id>/settings`), `openInBrowser(url)`, `FieldRow`, `Select`, `timeAgo`,
`SidebarColumn`, types `PanelProps`, `CardFace`, `PageDetail`, `Session`. Tailwind classes work
because gen-plugins points Tailwind at `web/` (`@source`); use the host's tokens (`text-ink`,
`bg-panel`, `border-line`, `text-copper`, …) rather than raw colours. No modal portal exists in
the API: a dialog is a `fixed inset-0` overlay rendered inside the panel.

Plain `fetch("/api/plugins/<id>/…")` reaches your own routes. Preferences that need no sync go
to `localStorage` wrapped in try/catch; anything shared goes through the settings slice.

## Compose and run locally

In the Trame checkout, with the plugin next to it:

```bash
echo '{ "plugins": ["../my-plugin"] }' > plugins.local.json   # gitignored, several paths allowed
just plugins          # gen registries + symlink my-plugin/node_modules → app/web/node_modules
just web-dev          # vite with HMR against the native backend; the plugin is compiled in
just plugins-install  # host binary + web bundle into ~/.local/share/trame/plugins; restart Trame
```

The installed app loads the backend from the new `plugin-host` only after a Trame restart; the
web bundle is picked up on a page reload. A compiled-in plugin wins over a runtime one with the
same id, so `just web-dev` always shows the checkout's code. The generated files
(`app/plugins/local.gen.ts`, `app/web/src/plugins/local.gen.{ts,css}`, `core/mark-roles.gen.ts`)
are `--skip-worktree` while composed: never commit them in Trame.

## Checks

From the plugin repo, with Trame composed:

```bash
bun test                                                     # unit + boundary tests
../trame/node_modules/.bin/oxlint -c ../trame/.oxlintrc.json .
(cd ../trame && bunx tsc --noEmit -p . && cd app/web && npm run typecheck)   # Trame with the plugin in
(cd ../trame && just e2e)                                    # runs e2e/*.spec.ts as its own project
```

CI reproduces this: check out `Andarius/trame` beside the plugin, write `plugins.local.json`,
`bun install` + `npm ci` + `bun scripts/gen-plugins.ts`, then the same four commands. A plugin
that uses a new `Plugin` or `FrontendPlugin` field fails CI until that Trame change is on
`master`, so merge the Trame PR first and re-run.

Tests: `bun:test` with `test.each` tables; pure parsing and settings sanitizing are the
high-value targets. `boundary_test.ts` lists the allowed import specifiers per directory and
fails on anything else. Tests touching the database preload `../trame/app/test_setup.ts`
through `bunfig.toml` (see trame-cockpit).

## Release

`version.ts` holds `VERSION` and `REPO`; `mod.ts` passes them as `version` and `repo`.
`release.yml` runs on `v*` tags: it runs `bun version.ts "$GITHUB_REF_NAME"` (refuses a tag
that differs from `VERSION`) then `gh release create --verify-tag --generate-notes`. To ship:
bump `VERSION`, merge, `git tag vX.Y.Z <merge commit>`, `git push origin vX.Y.Z`. Trame checks
the latest release hourly and shows "Update available" in the plugins manager and Settings.

## Conventions

Terse one-line comments on non-obvious lines only; English everywhere. The README has three
sections: Use (the compose command, what the plugin reads and writes, what it never touches),
Test, Release. Nothing network-facing happens until the plugin is enabled and configured.

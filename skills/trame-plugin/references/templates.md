# Templates

Starting points for a plugin with id `demo`. Replace `demo`, `Demo` and `owner/trame-demo`.
Each block is the whole file unless marked otherwise.

## mod.ts

```ts
// Demo plugin: <what it reads>, polled from <where>. Live state is a module-level snapshot.
import type { Plugin, PluginSettings } from "@trame/plugin-api";
import { readSettings, sanitizeSettings } from "./settings.ts";
import { REPO, VERSION } from "./version.ts";

type PluginContext = Parameters<NonNullable<Plugin["start"]>>[0];

let ctx: PluginContext | null = null;
let snapshot: { items: string[]; polledAt: string | null } = { items: [], polledAt: null };
let inflight: Promise<void> | null = null;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const settings = async () => readSettings(ctx ? await ctx.settings() : {});

function poll(): Promise<void> {
  inflight ??= (async () => {
    const s = await settings();
    snapshot = { items: await fetchItems(s), polledAt: new Date().toISOString() };
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

const plugin: Plugin = {
  id: "demo",
  label: "Demo",
  glyph: "◇",
  description: "One line, shown in the plugins manager",
  version: VERSION,
  repo: REPO,
  ungatedRoutes: ["/probe"], // reachable before the plugin is enabled

  async routes(req, subPath) {
    if (subPath === "/state" && req.method === "GET") return json(snapshot);
    if (subPath === "/refresh" && req.method === "POST") {
      await poll();
      return json(snapshot);
    }
    if (subPath === "/probe" && req.method === "GET") return json({ ok: true });
    return null; // 404
  },

  start(c) {
    ctx = c;
    const loop = async () => {
      try {
        if (await c.enabled()) await poll();
      } catch (e) {
        console.error("demo poll:", e);
      }
      setTimeout(loop, ((await settings().catch(() => null))?.pollSeconds ?? 60) * 1000);
    };
    void loop();
  },

  onEnabled() {
    void poll();
  },

  badge: () => snapshot.items.length || null,

  sanitizeSettings: (raw: PluginSettings, current: PluginSettings) => sanitizeSettings(raw, current),
};

export default plugin;
```

## settings.ts

```ts
import type { PluginSettings } from "@trame/plugin-api";

export type Settings = { pollSeconds: number; sources: string[] };
const DEFAULTS: Settings = { pollSeconds: 60, sources: [] };

export function readSettings(slice: PluginSettings): Settings {
  const n = Number(slice.pollSeconds);
  return {
    pollSeconds: Number.isFinite(n) && n >= 15 ? n : DEFAULTS.pollSeconds,
    sources: Array.isArray(slice.sources) ? slice.sources.filter((s): s is string => typeof s === "string") : [],
  };
}

// the registry stores exactly what this returns; unknown fields are dropped
export function sanitizeSettings(raw: PluginSettings, _current: PluginSettings): PluginSettings {
  const out: PluginSettings = {};
  if ("pollSeconds" in raw) out.pollSeconds = Math.min(3600, Math.max(15, Number(raw.pollSeconds) || 60));
  if (Array.isArray(raw.sources)) out.sources = raw.sources.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
  return out;
}
```

## version.ts

```ts
// Plugin release identity: Trame compares VERSION with the latest GitHub release of REPO.
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
  column: true, // drop it when the rail should stand alone
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

## boundary_test.ts

```ts
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

// The plugin reaches Trame only through "@trame/plugin-api" (backend) and "@trame/web-api" (web).
const ALLOWED: [string, (spec: string) => boolean][] = [
  ["./", (s) => s.startsWith("./") || s.startsWith("node:") || s === "bun:test" || s === "@trame/plugin-api"],
  ["./web/", (s) => s.startsWith("./") || s === "../model.ts" || s === "react" || s === "@trame/web-api"],
];

test("the plugin imports Trame only through its plugin APIs", () => {
  const bad: string[] = [];
  for (const [dir, ok] of ALLOWED) {
    const root = new URL(dir, import.meta.url);
    for (const name of readdirSync(root)) {
      if (!/\.tsx?$/.test(name)) continue;
      const src = readFileSync(new URL(name, root), "utf8");
      const specs = [
        ...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm),
        ...src.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g),
      ];
      for (const [, spec] of specs) if (!ok(spec)) bad.push(`${dir}${name}: ${spec}`);
    }
  }
  expect(bad).toEqual([]);
});
```

Add a third-party web dependency (say `d3-force`) to the `./web/` predicate only after adding
it to Trame's `app/web/package.json`: the plugin resolves packages through the symlinked
`node_modules` and the runtime bundle inlines them.

## version_test.ts

```ts
import { expect, test } from "bun:test";
import { tagMismatch } from "./version.ts";

test.each([
  { id: "exact", tag: "v0.1.0", want: null },
  { id: "no prefix", tag: "0.1.0", want: null },
  { id: "full ref", tag: "refs/tags/v0.1.0", want: null },
  { id: "other version", tag: "v0.2.0", want: "tag v0.2.0 does not match plugin version 0.1.0 (version.ts)" },
])("tagMismatch: $id", ({ tag, want }) => {
  expect(tagMismatch(tag, "0.1.0")).toBe(want);
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
      "@trame/plugin-api": ["../trame/app/plugins/api.ts"],
      "@trame/plugin-test": ["../trame/app/test_tmp.ts"],
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

      - name: Compose the plugin into Trame
        run: |
          echo '{ "plugins": ["../trame-demo"] }' > trame/plugins.local.json
          cd trame && bun install --frozen-lockfile && (cd app/web && npm ci) && bun scripts/gen-plugins.ts

      - name: Typecheck Trame with the plugin composed
        run: cd trame && bunx tsc --noEmit -p . && cd app/web && npm run typecheck

      - name: Lint and unit tests
        run: |
          cd trame-demo
          ../trame/node_modules/.bin/oxlint -c ../trame/.oxlintrc.json .
          bun test
```

Pin the actions to commit SHAs in the real file.

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
  { "mark": "demo_ref", "value": "^DEMO-\\d+$", "role": "ticket" }
]
```

Roles come from `core/mark-roles.ts` in Trame. Pair it with `metadataMarks: ["demo_ref"]` in
`web/index.ts` so the mark is hidden in rendered text.

## e2e/demo.spec.ts (shape)

```ts
import { expect, test } from "@playwright/test";

test("the panel lists what the backend returns", async ({ page }) => {
  await page.route("**/api/plugins/demo/state", (r) => r.fulfill({ json: { items: ["one"], polledAt: null } }));
  await page.goto("/?view=plugin&plugin=demo");
  await expect(page.getByText("one")).toBeVisible();
});
```

Trame's `playwright.config.ts` adds `e2e/` of every composed plugin as a project named after
the plugin directory, so `just e2e` in Trame runs it.

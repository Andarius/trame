// DESCRIPTION: Replay page/comment requests on two isolated copied databases and compare every row.
// USAGE: deno run -A --config app/deno.json scripts/rust-pages-diff.ts
import { type Database, socketPg } from "../app/pg.ts";
import { handleCoreApi } from "../core/api.ts";
import postgres from "postgres";
import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { scratchPath } from "./rust-db-export.ts";

const workspace = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const full = Deno.env.get("TRAME_DIFF_GROUPS") === "full";
const evidence = join(
  workspace,
  full ? ".scratch/review-differential" : ".scratch/stage1-slice2",
);
await Deno.mkdir(evidence, { recursive: true, mode: 0o700 });
const run = await Deno.makeTempDir({
  dir: join(workspace, ".scratch"),
  prefix: "diff2-",
});
const children: Deno.ChildProcess[] = [];
const databases: Database[] = [];
const listeners: ReturnType<typeof postgres>[] = [];
const logFiles: Deno.FsFile[] = [];
const steps: {
  method: string;
  path: string;
  status: number;
  notifications: number;
}[] = [];
const origin = "rust-spike";
const qid = (s: string) => `"${s.replaceAll('"', '""')}"`;
async function start(label: string) {
  const root = join(run, label);
  await Deno.mkdir(root, { mode: 0o700 });
  if (full) {
    await Deno.writeTextFile(
      join(root, "replay-clock.txt"),
      "2031-01-01T00:00:00Z",
    );
  }
  await Deno.mkdir(join(root, "home"), { mode: 0o700 });
  await Deno.mkdir(join(root, "bin"), { mode: 0o700 });
  for (const binary of ["gh", "glab", "zenity", "kdialog"]) {
    const file = join(root, "bin", binary);
    await Deno.writeTextFile(file, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  }
  const source = await scratchPath(
    Deno.env.get("TRAME_DIFF_SOURCE") ??
      join(workspace, ".scratch/stage1/copied-app"),
  );
  const copy = await new Deno.Command("flock", {
    args: [
      "-n",
      `${source}/.owner.lock`,
      "cp",
      "-a",
      "--reflink=auto",
      `${source}/postgres`,
      `${root}/postgres`,
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!copy.success) throw new Error("stopped copied DB clone failed");
  const log = await Deno.open(join(root, "runtime.log"), {
    write: true,
    create: true,
  });
  logFiles.push(log);
  const env = {
    PATH: join(root, "bin") + ":" + (Deno.env.get("PATH") ?? "/usr/bin:/bin"),
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "home/.config"),
    XDG_DATA_HOME: join(root, "home/.local/share"),
    DENO_DIR: Deno.env.get("DENO_DIR") ??
      join(
        Deno.env.get("XDG_CACHE_HOME") ??
          join(Deno.env.get("HOME") ?? "", ".cache"),
        "deno",
      ),
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
    GITLAB_TOKEN: "",
    GLAB_TOKEN: "",
    TRACKER_HUB_API: "",
    TRACKER_HUB_API_TOKEN: "",
    TRACKER_REPORT_PATHS: "",
    TRAME_LOCAL_DIR: root,
    TRAME_PG_BIN: Deno.env.get("TRAME_PG_BIN") ??
      join(workspace, ".scratch/package/pg/usr/lib/postgresql/18/bin"),
    TRAME_WEB_DIR: join(workspace, "app/web/dist"),
    TRACKER_PORT: "0",
    TRACKER_NODE_ID: origin,
    TRACKER_SETTINGS_FILE: join(root, "settings.json"),
    TRAME_OFFLINE: "1",
    TRAME_ISOLATED: "1",
    DISPLAY: "",
    WAYLAND_DISPLAY: "",
    ...(full
      ? {
        TRACKER_DEPLOYMENTS_FIXTURE: join(
          workspace,
          "app/plugins/deployments/fixture.sample.json",
        ),
        TRACKER_DEPLOYMENTS_POLL_IDLE_MS: "3600000",
      }
      : {}),
    ...(full && label === "ts" ? { TRAME_DIFF_TS_ORACLE: "1" } : {}),
    ...(full ? { TRAME_REPLAY_CLOCK: join(root, "replay-clock.txt") } : {}),
  };
  const child = new Deno.Command(join(workspace, "target/debug/trame-local"), {
    clearEnv: true,
    env,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  children.push(child);
  child.stdout.pipeTo(log.writable, { preventClose: true }).catch(() => {});
  child.stderr.pipeTo(
    new WritableStream({
      write: async (b) => {
        await log.write(b);
      },
    }),
  ).catch(() => {});
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const { port } = JSON.parse(
        await Deno.readTextFile(join(root, "port.json")),
      );
      const db = socketPg(join(root, "socket"));
      databases.push(db);
      return { root, db, base: `http://127.0.0.1:${port}` };
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`startup timeout ${label}`);
}
async function determinize(db: Database) {
  await db.exec(`create schema replay;
    create sequence replay.ids;
    create table replay.clock(value timestamptz);
    insert into replay.clock values ('2031-01-01T00:00:00Z');
    create function replay.now() returns timestamptz language sql stable as 'select value from replay.clock';
    create function replay.clock_timestamp() returns timestamptz language sql stable as 'select value from replay.clock';
    create function replay.uuidv7() returns uuid language sql volatile as $$select ('77777777-7777-4777-8777-' || lpad(nextval('replay.ids')::text,12,'0'))::uuid$$;
    alter role trame set search_path = replay,pg_catalog,public;
    set search_path = replay,pg_catalog,public;`);
  const { rows } = await db.query<
    { table_name: string; column_name: string; column_default: string }
  >(`select table_name,column_name,column_default from information_schema.columns where table_schema='public' and column_default is not null`);
  for (const c of rows) {
    if (/(?:^|\.)(now\(\)|clock_timestamp\(\))$/.test(c.column_default)) {
      await db.exec(
        `alter table public.${qid(c.table_name)} alter column ${
          qid(c.column_name)
        } set default replay.now()`,
      );
    }
    if (
      /(?:^|\.)(uuidv7\([^)]*\)|gen_random_uuid\(\))$/.test(c.column_default)
    ) {
      await db.exec(
        `alter table public.${qid(c.table_name)} alter column ${
          qid(c.column_name)
        } set default replay.uuidv7()`,
      );
    }
  }
}
try {
  const a = await start("ts"), b = await start("rs");
  const tables = (await a.db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name",
  )).rows.map((r) => r.table_name);
  const compare = async (label: string) => {
    let rows = 0;
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const sql = `select row_to_json(t)::text as row from public.${
        qid(table)
      } t order by row_to_json(t)::text`;
      const left = (await a.db.query<{ row: string }>(sql)).rows.map((r) =>
        r.row
      );
      const right = (await b.db.query<{ row: string }>(sql)).rows.map((r) =>
        r.row
      );
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        await Deno.writeTextFile(
          join(evidence, "row-difference.json"),
          JSON.stringify(
            {
              label,
              table,
              left: left.filter((v, i) => v !== right[i]),
              right: right.filter((v, i) => v !== left[i]),
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        throw new Error(
          `row differences: ${label} ${table}; private evidence saved`,
        );
      }
      counts[table] = left.length;
      rows += left.length;
    }
    return { rows, tables: tables.length, counts, row_diffs: 0 };
  };
  const baseline = await compare("baseline");
  await determinize(a.db);
  await determinize(b.db);
  if (full) {
    await a.db.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where usename='trame' and pid<>pg_backend_pid()",
    );
  }
  const notifications = [0, 0];
  for (const [i, root] of [a.root, b.root].entries()) {
    const sql = postgres({
      path: join(root, "socket/.s.PGSQL.55439"),
      port: 55439,
      username: "trame",
      database: "postgres",
      onnotice: () => {},
    });
    listeners.push(sql);
    await sql.listen("changes", () => {
      notifications[i]++;
    });
  }
  let tick = 0;
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    raw?: string,
    mime = "application/json",
  ) => {
    tick++;
    const replayMillis = Date.parse("2031-01-01T00:00:00Z") + tick * 1000;
    if (full) {
      for (const root of [a.root, b.root]) {
        await Deno.writeTextFile(
          join(root, "replay-clock.txt"),
          new Date(replayMillis).toISOString(),
        );
      }
    }
    for (const db of [a.db, b.db]) {
      await db.query(
        "update replay.clock set value='2031-01-01'::timestamptz + make_interval(secs=>$1)",
        [tick],
      );
    }
    const init = {
      method,
      ...(raw !== undefined
        ? { body: raw, headers: { "content-type": mime } }
        : body === undefined
        ? {}
        : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
    };
    let ts: Response;
    const realDate = globalThis.Date;
    if (full) {
      globalThis.Date = new Proxy(realDate, {
        construct(target, args, newTarget) {
          return Reflect.construct(
            target,
            args.length ? args : [replayMillis],
            newTarget,
          );
        },
        get(target, key, receiver) {
          return key === "now"
            ? () => replayMillis
            : Reflect.get(target, key, receiver);
        },
      });
    }
    try {
      const req = new Request(`http://localhost${path}`, init);
      const shellFirst = path === "/api/pages/import" ||
        /^\/api\/pages\/[^/]+\/export$/.test(path);
      ts = (shellFirst
        ? null
        : await handleCoreApi({ q: a.db, origin }, req, new URL(req.url))) ??
        (full
          ? await fetch(a.base + path, init)
          : new Response('{"error":"not found"}', { status: 404 }));
    } catch {
      ts = new Response("Internal Server Error", { status: 500 });
    } finally {
      globalThis.Date = realDate;
    }
    const rs = await fetch(b.base + path, init);
    let left = await ts.text(), right = await rs.text();
    if (path.startsWith("/api/plugins/")) {
      const normalize = (text: string) => {
        const value = JSON.parse(text);
        const visit = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          for (const [key, item] of Object.entries(value)) {
            if (key === "polledAt" && typeof item === "string") {
              if (!Number.isFinite(Date.parse(item))) {
                throw new Error("invalid plugin timestamp");
              }
              (value as Record<string, unknown>)[key] = "<poll-time>";
            } else visit(item);
          }
        };
        visit(value);
        return JSON.stringify(value);
      };
      left = normalize(left);
      right = normalize(right);
    }
    if (path === "/api/plugins" && rs.ok) {
      // native-only plugins have no TypeScript twin to compare against
      const nativeOnly = new Set(["sql-source"]);
      right = JSON.stringify(
        (JSON.parse(right) as { id: string }[]).filter((p) => !nativeOnly.has(p.id)),
      );
      left = JSON.stringify(JSON.parse(left));
    }
    if (path === "/api/status") {
      const normalize = (text: string, root: string) => {
        const value = JSON.parse(text);
        if (!value.dataDir.startsWith(root + "/")) {
          throw new Error("status dataDir escaped clone");
        }
        value.dataDir = "<clone-db>";
        return JSON.stringify(value);
      };
      left = normalize(left, a.root);
      right = normalize(right, b.root);
    }
    if (path.startsWith("/api/import/claude") && method === "GET") {
      const normalize = (text: string, root: string) => {
        const value = JSON.parse(text);
        if (typeof value.dir === "string" && value.dir.startsWith(root + "/")) {
          value.dir = value.dir.replaceAll(root + "/", "<clone>/");
        }
        return JSON.stringify(value);
      };
      left = normalize(left, a.root);
      right = normalize(right, b.root);
    }
    if (left !== right || ts.status !== rs.status) {
      await Deno.writeTextFile(
        join(evidence, "response-difference.json"),
        JSON.stringify(
          {
            method,
            path,
            ts: { status: ts.status, body: left },
            rust: { status: rs.status, body: right },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      throw new Error(
        `response mismatch at ${method} ${path}; private evidence saved`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(
      notifications[0],
      notifications[1],
      `notification count after ${method} ${path}`,
    );
    steps.push({
      method,
      path,
      status: rs.status,
      notifications: notifications[1],
    });
    return left.startsWith("{") || left.startsWith("[")
      ? JSON.parse(left)
      : left;
  };
  const post = (path: string, body: unknown = {}) =>
    request("POST", path, body);
  const page = (id: string) => `/api/pages/${id}`;
  const comment = (id: string) => `/api/comments/${id}`;
  const copiedPages = await request("GET", "/api/pages");
  for (const p of copiedPages) await request("GET", page(p.id));
  await request("GET", "/api/pages/null");
  for (const method of ["PATCH", "PUT", "DELETE", "OPTIONS"]) {
    await request(method, page("77777777-0000-4000-8000-000000000000"));
  }
  for (
    const body of [null, { status: "done" }, { content: "bad" }, {
      content: null,
    }]
  ) await post("/api/pages", body);
  for (
    const raw of [
      "",
      "{",
      "nope",
      "{bad}",
      '{"a":}',
      "[1,]",
      '{"a":1,}',
      '{"a" 1}',
      "undefined",
      "null x",
      '"bad\ntext"',
    ]
  ) await request("POST", "/api/pages", undefined, raw);
  await request(
    "POST",
    "/api/pages",
    undefined,
    '{"title":"Raw numbers","content":[{"type":"text","id":"n","text":"Numbers","small":1.0,"negative":-0.0,"large":1e20,"tiny":1e-7,"keys":{"10":1,"a":2,"2":3}}]}',
  );
  const project =
    (await post("/api/pages", { title: "Slice2 project A", kind: "project" }))
      .id;
  const project2 =
    (await post("/api/pages", { title: "Slice2 project B", kind: "project" }))
      .id;
  const p = (await post("/api/pages", {
    title: "Slice2 plan",
    parent_id: project,
    content: [{ id: "block", type: "text", text: "Keep this block" }, {
      id: "todo",
      type: "todo",
      text: "Ship",
      done: false,
    }],
  })).id;
  const child = (await post("/api/pages", {
    title: "Child",
    parent_id: p,
    content: [{ id: "todo", type: "todo", text: "Ready", done: true }],
  })).id;
  await post(page(p), {
    title: "Renamed",
    icon: "book",
    color: "#123456",
    tags: ["one", "two"],
    brief: "Summary",
    status: "archived",
  });
  await post(page(p), {
    icon: null,
    color: null,
    client_id: null,
    tags: null,
    status: null,
    content: false,
  });
  await post(page(p), { status: "bad" });
  for (const icon of [true, false, [true]]) await post(page(p), { icon });
  for (const body of [null, true, 3, "patch"]) await post(page(p), body);
  await request("GET", page(p));
  await post(page(p) + "/move", { parent_id: child });
  await post(page(child) + "/move", { parent_id: project, before_id: p });
  await post(page(child) + "/move", { after_id: p });
  await post(page(child) + "/move", { before_id: project2 });
  const story = (await post("/api/pages", {
    title: "US",
    kind: "story",
    parent_id: project,
    client_id: project,
  })).id;
  await post("/api/pages", {
    title: "Nested",
    kind: "story",
    parent_id: story,
  });
  await post(page(story) + "/move", { parent_id: project2 });
  await post(page(story) + "/move", { parent_id: null });
  await post(page(p) + "/story");
  await post(page(p) + "/story");
  await post(page(project) + "/story");
  await post(page(child) + "/session");
  await post(page(child) + "/session");
  await post(page(child) + "/story");
  await request("GET", page(child));
  await request("GET", page(child) + "/events");
  const own = (await post("/api/pages", {
    title: "Repo filed",
    repo_path: "/some/unmatched/repo",
  })).id;
  await request("GET", page(own));
  await request("POST", "/api/comments/inbox");
  await request("PUT", "/api/comments");
  await request("PUT", "/api/pages");
  let agent = "";
  for (const name of ["codex", "claude", "glm", "qwen", "Gemini"]) {
    agent = (await post("/api/comments", {
      page_id: p,
      block_id: "block",
      body: `Question ${name}`,
      agent: name,
      meta: { model: "", in: 12 },
    })).id;
  }
  const human = (await post("/api/comments", {
    page_id: p,
    block_id: "block",
    anchor: "Snapshot",
    body: "Human reply",
    author: " Someone ",
  })).id;
  for (
    const body of [null, {
      page_id: p,
      block_id: "block",
      body: "Bad author",
      author: 3,
    }]
  ) await post("/api/comments", body);
  for (const resolved of [1, "true", {}, false]) {
    await post(comment(human), { resolved });
  }
  await post(comment(human), { author: 3, body: "Must not write" });
  await post(comment(human) + "/agent-status", null);
  for (const meta of [["first"], "metadata"]) {
    await post("/api/comments", {
      page_id: p,
      block_id: "meta",
      body: "Spread metadata",
      agent: "qwen",
      meta,
    });
  }
  for (const agent of ["éclair", "😀"]) {
    await post("/api/comments", {
      page_id: p,
      block_id: "unicode",
      body: "Unicode attribution",
      agent,
    });
  }
  await request("GET", `/api/comments?page=${p}`);
  await request("GET", `/api/comments/inbox?page=${p}`);
  for (
    const status of [
      "invalid",
      "seen",
      "answering",
      "failed",
      "answered",
      "clear",
    ]
  ) {
    await post(comment(human) + "/agent-status", { status, agent: "codex" });
    await request("GET", `/api/comments/inbox?page=${p}`);
  }
  await post(comment(human) + "/agent-status", { status: "answering" });
  for (const stale of ["-1", "%200%20", "0x10", "0b10", "0o10"]) {
    await request("GET", `/api/comments/inbox?page=${p}&stale=${stale}`);
  }
  await post(comment(human), { body: "Edited reply" });
  await request("GET", `/api/comments/inbox?page=${p}`);
  await post(comment(human), { resolved: true });
  await post(comment(human), { resolved: false });
  await post(comment(human), { author: " Custom Agent " });
  await post(comment(agent) + "/delete");
  const first = (await post("/api/comments", {
    page_id: child,
    block_id: "gone",
    anchor: "Old block",
    body: "First contact",
  })).id;
  await request("GET", `/api/comments/inbox?page=${child}&mode=all&stale=bad`);
  await post(comment(first) + "/agent-status", { status: "seen" });
  await post(comment(first) + "/delete");
  await request("GET", `/api/comments/inbox?page=${child}&mode=all`);
  await post(
    comment("77777777-0000-4000-8000-000000000000") + "/agent-status",
    { status: "seen" },
  );
  await post(page(project2) + "/delete");
  await post(page(project) + "/delete");
  await request("GET", page(p));
  await request("GET", "/api/pages");
  if (full) {
    const { replaySessions } = await import(
      "./fixtures/rust-replay/sessions.ts"
    );
    const { replayUdb } = await import("./fixtures/rust-replay/udb.ts");
    await replaySessions(request);
    await compare("sessions");
    await replayUdb(request);
    await compare("udb");
    const { replayImportPlugins, replayDeploymentsFixture } = await import(
      "./fixtures/rust-replay/imports-plugins.ts"
    );
    await replayImportPlugins(request);
    await replayDeploymentsFixture(request);
    await compare("imports-plugins");
    await request("GET", "/api/settings");
    await request("POST", "/api/settings", {
      authorName: " Replay Writer ",
      authorAvatar: "fixture.png",
      htmlFilter: "all",
      agentPresence: {
        marker: "rail",
        activity: "off",
        fields: { tokens: false },
        liveMinutes: "9.5",
        staleMinutes: 1,
      },
    });
    await request("GET", "/api/identity");
    await request("GET", "/api/users");
    await request("POST", "/api/settings", {
      authorName: "",
      authorAvatar: "",
      htmlFilter: "smart",
      hubApi: "https://fixture.invalid/",
      hubApiToken: "fixture-only",
    });
    await request("GET", "/api/page-links");
    await request("POST", "/api/settings", { hubApi: "" });
    await request("GET", "/api/status");
    for (const suffix of ["", "/delete"]) {
      await request("POST", `/api/tags/not-a-uuid${suffix}`, {});
    }
    await request("POST", "/api/page-links", { page_id: "not-a-uuid" });
    await request(
      "POST",
      "/api/page-links/77777777-0000-4000-8000-000000000000/delete",
    );
    const report = (await request("POST", "/api/reports", {
      title: "Report replay",
      html: "<html><h1>preserved report</h1></html>",
    })).id;
    await request("GET", "/api/reports");
    await request("GET", `/api/reports/${report}`);
    await request("GET", `/report/${report}`);
    await request("POST", `/api/reports/${report}/delete`);
    await request("GET", `/api/reports/${report}`);
    await request("GET", `/report/${report}`);
    await request("GET", "/report-file?path=missing");
    await request(
      "GET",
      "/api/fs/complete?path=" + encodeURIComponent(run + "/missing/"),
    );
    await request("POST", "/api/pages/import", {});
    await request(
      "POST",
      "/api/pages/77777777-0000-4000-8000-000000000000/export",
    );
    await request("GET", "/api/repo-remote?path=relative");
    await request(
      "GET",
      "/api/repo-remote?path=" + encodeURIComponent(workspace),
    );
    await request("GET", "/api/report-files?force");
    await request("GET", "/api/report-files/content?path=missing");
    await request("GET", "/api/folder?path=missing");
    await request("POST", "/api/open-path", { path: "missing" });
    await request("POST", "/api/report-files/delete", { path: "missing" });
    const sharePage =
      (await request("POST", "/api/pages", { title: "Local shares replay" }))
        .id;
    await request("POST", `/api/pages/${sharePage}/export`);
    const pageLink = await request("POST", "/api/page-links", {
      page_id: sharePage,
    });
    await request("GET", `/api/page-links?page=${sharePage}`);
    await request("POST", `/api/page-links/${pageLink.id}/delete`);
    await request("GET", `/api/page-links?page=${sharePage}`);
    const user = (await request("GET", "/api/users"))[0].id;
    const share = (await request("POST", "/api/shares", {
      page_id: sharePage,
      user_id: user,
      role: "viewer",
    })).id;
    await request("POST", "/api/shares", {
      page_id: sharePage,
      user_id: user,
      role: "editor",
    });
    await request("GET", "/api/shares?page=" + sharePage);
    await request("POST", `/api/shares/${share}/delete`);
    await request("GET", "/api/shares?page=" + sharePage);
    await compare("local");
    await request("POST", "/api/assets", undefined, "not an image");
    const asset = await request(
      "POST",
      "/api/assets",
      undefined,
      "fixture image\u0000bytes",
      "image/png",
    );
    await request("GET", `/api/assets/${asset.id}`);
    await request("GET", "/api/assets/77777777-0000-4000-8000-000000000000");
    await request("GET", "/api/update");
    await request("POST", "/api/update");
    await request("POST", "/api/hub/test", {});
    await request("POST", "/api/sync");
    await request("POST", "/api/pr-state", { url: "file:///not-allowed" });
    await request("POST", "/api/pr-state", {
      url: "https://fixture.invalid/pr/1",
    });
    await request("GET", "/api/unknown-native-route");
    await compare("runtime-assets");
  }
  const final = await compare("final");
  assertEquals(
    Array.from(
      (await a.db.query("select last_value,is_called from replay.ids")).rows,
    ),
    Array.from(
      (await b.db.query("select last_value,is_called from replay.ids")).rows,
    ),
  );
  assertEquals(
    Array.from(
      (await a.db.query("select last_value,is_called from change_log_rev_seq"))
        .rows,
    ),
    Array.from(
      (await b.db.query("select last_value,is_called from change_log_rev_seq"))
        .rows,
    ),
  );
  const replayNotifications = [...notifications];
  assertEquals(replayNotifications[0], replayNotifications[1]);
  await Deno.writeTextFile(
    join(evidence, "differential.json"),
    JSON.stringify(
      {
        baseline,
        final,
        requests: steps.length,
        notifications: replayNotifications,
        steps,
        clock:
          "fixed per request in both copied DBs; UUID defaults replayed; no row fields omitted",
        response_normalization:
          "Validated plugin polledAt timestamps, clone-local status dataDir and import paths; link entropy is deterministic in both debug handlers",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const cli = async (command: string, input: unknown) => {
    const out = await new Deno.Command(join(workspace, "dist/tramecli"), {
      args: [command, JSON.stringify(input)],
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "",
        HOME: b.root,
        XDG_DATA_HOME: b.root,
        TRACKER_PORT_FILE: join(b.root, "port.json"),
        TRACKER_SETTINGS_FILE: join(b.root, "settings.json"),
        TRACKER_DATA_DIR: join(b.root, "unused-pglite"),
        TRAME_OFFLINE: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!out.success) {
      throw new Error(
        `tramecli ${command} failed: ${new TextDecoder().decode(out.stderr)}`,
      );
    }
    return new TextDecoder().decode(out.stdout);
  };
  const created = await cli("page", {
    title: "Slice2 CLI",
    parent_id: null,
    markdown: "## Goal\n\nKeep this paragraph.\n\n- [ ] Verify the copy",
  });
  const cliId = created.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/)
    ?.[0];
  if (!cliId) throw new Error("CLI did not return a page id");
  const before = await (await fetch(b.base + page(cliId))).json();
  await cli("page", {
    page_id: cliId,
    markdown: "## Goal\n\nKeep this paragraph.\n\n- [x] Verify the copy",
  });
  const after = await (await fetch(b.base + page(cliId))).json();
  assertEquals(
    after.content.find((x: { text: string }) =>
      x.text === "Keep this paragraph."
    ).id,
    before.content.find((x: { text: string }) =>
      x.text === "Keep this paragraph."
    ).id,
  );
  await cli("comment", {
    page_id: cliId,
    block_text: "Keep this paragraph.",
    body: "Verified from compiled tramecli",
    agent: "codex",
    meta: { model: "slice2-test", in: 10, out: 5, ms: 1 },
  });
  const cliComments =
    await (await fetch(`${b.base}/api/comments?page=${cliId}`)).json();
  assertEquals(cliComments.length, 1);
  assertEquals(cliComments[0].body, "Verified from compiled tramecli");
  assertEquals(cliComments[0].author, "Codex");
  await Deno.writeTextFile(
    join(evidence, "cli.json"),
    JSON.stringify({
      compiled: true,
      page_create: true,
      page_update: true,
      markdown_roundtrip: true,
      kept_block_id: true,
      comment_create: true,
      copy_only: true,
    }),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      requests: steps.length,
      ...final,
      notifications: replayNotifications,
    }),
  );
} finally {
  for (const sql of listeners) await sql.end();
  for (const db of databases) await db.close();
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
  }
  for (const child of children) await child.status;
  for (const f of logFiles) {
    try {
      f.close();
    } catch { /* pipe closed */ }
  }
  await Deno.remove(run, { recursive: true });
}

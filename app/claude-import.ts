// Import Claude Code sessions (~/.claude/projects/<dashed-cwd>/<uuid>.jsonl) as Trame
// session cards. The Claude session UUID becomes the Trame session id — dedup is a
// single id lookup and re-imports can never clobber user edits (create-only).
// Transcripts can be tens of MB: only a head chunk (first cwd) and a tail chunk
// (LAST ai-title / last-prompt / gitBranch) are read.
import { addEvent, db, upsertSession } from "./db.ts";
import { CLAUDE_DIR, CLIENT_MAP, CODEX_DIR, NODE_ID, SETTINGS_FILE } from "./config.ts";
import { updateSettings } from "./settings-store.ts";

export type AgentSource = "claude" | "codex";

export type ClaudeSession = {
  source: AgentSource;
  claudeId: string;
  title: string;
  repoPath: string | null;
  branch: string | null;
  lastActive: string;
  suggestedStatus: "active" | "paused";
  suggestedClient: string;
  suggestedProject: string;
  alreadyImported: boolean;
  ignored: boolean;
};
export type ClaudeGroup = {
  repoPath: string;
  repoName: string;
  suggestedClient: string;
  sessions: ClaudeSession[];
};
export type ClaudeImportItem = {
  source?: AgentSource;
  claudeId: string;
  title: string;
  repoPath: string | null;
  branch: string | null;
  client: string;
  project: string | null;
  status: "active" | "paused";
  lastActive: string;
};

// Ignored ids live in the settings file: a per-machine concern, like the transcripts.
const ignoredKey = (source: AgentSource, id: string) => `${source}:${id}`;

async function loadIgnored(): Promise<Set<string>> {
  try {
    const s = JSON.parse(await Deno.readTextFile(SETTINGS_FILE));
    return new Set(
      Array.isArray(s.sessionIgnored) ? s.sessionIgnored as string[] : [],
    );
  } catch {
    return new Set();
  }
}

export async function setSessionIgnored(
  source: AgentSource,
  sessionId: string,
  ignored: boolean,
): Promise<{ ignored: boolean }> {
  await updateSettings((settings) => {
    const set = new Set(Array.isArray(settings.sessionIgnored) ? settings.sessionIgnored as string[] : []);
    const key = ignoredKey(source, sessionId);
    ignored ? set.add(key) : set.delete(key);
    settings.sessionIgnored = [...set];
  });
  return { ignored };
}

export const setClaudeIgnored = (claudeId: string, ignored: boolean) =>
  setSessionIgnored("claude", claudeId, ignored);

const HEAD_BYTES = 524_288;
const TAIL_BYTES = 262_144;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readFull(f: Deno.FsFile, buf: Uint8Array): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const n = await f.read(buf.subarray(off));
    if (n === null) break;
    off += n;
  }
}

async function readChunks(path: string): Promise<{ head: string; tail: string }> {
  const f = await Deno.open(path, { read: true });
  try {
    const size = (await f.stat()).size;
    const head = new Uint8Array(Math.min(HEAD_BYTES, size));
    await readFull(f, head);
    let tail = head;
    if (size > HEAD_BYTES) {
      await f.seek(Math.max(0, size - TAIL_BYTES), Deno.SeekMode.Start);
      tail = new Uint8Array(Math.min(TAIL_BYTES, size));
      await readFull(f, tail);
    }
    const dec = new TextDecoder();
    return { head: dec.decode(head), tail: dec.decode(tail) };
  } finally {
    f.close();
  }
}

// deno-lint-ignore no-explicit-any
const parseLines = (chunk: string): any[] =>
  chunk.split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return []; // cut boundary line or in-flight write — skip
    }
  });

// deno-lint-ignore no-explicit-any
function userText(e: any): string | null {
  if (e.type !== "user") return null;
  const c = e.message?.content;
  const txt = typeof c === "string"
    ? c
    : Array.isArray(c)
    // deno-lint-ignore no-explicit-any
    ? c.filter((x: any) => x?.type === "text").map((x: any) => x.text).join(" ")
    : "";
  const line = txt.trim().split("\n")[0].trim();
  // skip harness noise: slash-command/system tags, hook caveats, compaction preambles
  if (!line || line.startsWith("<") || line.startsWith("Caveat:") || line.startsWith("This session is being continued")) return null;
  return line;
}

function extractMeta(head: string, tail: string) {
  let cwd: string | null = null, firstPrompt: string | null = null;
  for (const e of parseLines(head)) {
    if (!cwd && typeof e.cwd === "string" && e.cwd) cwd = e.cwd;
    if (!firstPrompt) firstPrompt = userText(e);
    if (cwd && firstPrompt) break;
  }
  let aiTitle: string | null = null, lastPrompt: string | null = null, branch: string | null = null;
  let lastTs: string | null = null, hasActivity = firstPrompt !== null;
  for (const e of parseLines(tail)) {
    if (e.type === "ai-title" && typeof e.aiTitle === "string") aiTitle = e.aiTitle; // last wins
    if (e.type === "last-prompt" && typeof e.lastPrompt === "string") lastPrompt = e.lastPrompt;
    if (e.type === "user" || e.type === "assistant") hasActivity = true;
    if (typeof e.gitBranch === "string") branch = e.gitBranch;
    if (typeof e.timestamp === "string") lastTs = e.timestamp;
    if (!cwd && typeof e.cwd === "string" && e.cwd) cwd = e.cwd;
  }
  if (branch === "HEAD" || branch === "") branch = null;
  return { cwd, aiTitle, lastPrompt, firstPrompt, branch, lastTs, hasActivity };
}

function cleanCodexPrompt(text: string): string | null {
  const line = text.trim().split("\n")[0].trim();
  if (
    !line || line.startsWith("<") || line.startsWith("Caveat:") ||
    line.startsWith("This session is being continued")
  ) return null;
  return line;
}

function extractCodexMeta(head: string, tail: string) {
  let id: string | null = null, cwd: string | null = null, branch: string | null = null;
  let firstPrompt: string | null = null, subagent = false;
  for (const e of parseLines(head)) {
    if (e.type === "session_meta") {
      const p = e.payload ?? {};
      id = typeof p.id === "string" ? p.id : typeof p.session_id === "string" ? p.session_id : id;
      cwd = typeof p.cwd === "string" ? p.cwd : cwd;
      branch = typeof p.git?.branch === "string" ? p.git.branch : branch;
      subagent = Boolean(p.parent_thread_id) || p.thread_source === "subagent" ||
        (p.source && typeof p.source === "object" && "subagent" in p.source);
    }
    if (
      !firstPrompt && e.type === "event_msg" && e.payload?.type === "user_message" &&
      typeof e.payload.message === "string"
    ) firstPrompt = cleanCodexPrompt(e.payload.message);
  }
  let lastTs: string | null = null, hasActivity = firstPrompt !== null;
  for (const e of parseLines(tail)) {
    if (typeof e.timestamp === "string") lastTs = e.timestamp;
    if (e.type === "event_msg" && e.payload?.type === "user_message") hasActivity = true;
  }
  if (branch === "HEAD" || branch === "") branch = null;
  return { id, cwd, firstPrompt, branch, lastTs, hasActivity, subagent };
}

async function codexFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const paths: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory) paths.push(...await codexFiles(path, depth + 1));
      else if (e.isFile && e.name.endsWith(".jsonl")) paths.push(path);
    }
  } catch { /* Codex not installed / unreadable date directory */ }
  return paths;
}

async function scanCodexSessions(cutoff: number, ignoredIds: Set<string>): Promise<ClaudeSession[]> {
  const found: ClaudeSession[] = [];
  for (const path of await codexFiles(CODEX_DIR)) {
    try {
      const stat = await Deno.stat(path);
      const mtime = stat.mtime?.getTime() ?? 0;
      if (mtime < cutoff) continue;
      const filename = path.slice(path.lastIndexOf("/") + 1, -6);
      const filenameId = filename.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
      )?.[1];
      const { head, tail } = await readChunks(path);
      const { id, cwd, firstPrompt, branch, lastTs, hasActivity, subagent } = extractCodexMeta(head, tail);
      const codexId = id ?? filenameId;
      if (subagent || !codexId || !UUID_RE.test(codexId) || !hasActivity || !cwd) continue;
      const lastActive = lastTs && !Number.isNaN(Date.parse(lastTs)) ? Date.parse(lastTs) : mtime;
      if (lastActive < cutoff) continue;
      const repoName = cwd.split("/").filter(Boolean).pop() ?? "unknown";
      found.push({
        source: "codex",
        claudeId: codexId,
        title: `${repoName} — ${firstPrompt ? truncate(firstPrompt, 80) : "untitled session"}`,
        repoPath: cwd,
        branch,
        lastActive: new Date(lastActive).toISOString(),
        suggestedStatus: lastActive > Date.now() - 48 * 3_600_000 ? "active" : "paused",
        suggestedClient: clientFor(cwd),
        suggestedProject: repoName,
        alreadyImported: false,
        ignored: ignoredIds.has(ignoredKey("codex", codexId)),
      });
    } catch { /* raced deletion / unreadable file */ }
  }
  return found;
}

// working-dir → client: first TRACKER_CLIENTS segment present in the path. Scratchpad
// worktrees carry the repo path dash-encoded ("/tmp/claude-…/-home-me-Work-repo/…"),
// so those match on the dashed segment too.
export const clientFor = (path: string): string => {
  for (const [seg, name] of Object.entries(CLIENT_MAP)) {
    if (path.includes(`/${seg}/`)) return name;
    if (path.startsWith("/tmp/claude-") && path.includes(`-${seg}-`)) return name;
  }
  return "Side-projects";
};

// "-home-user-Projects-x" → "/home/user/Projects/x" (lossy: dashes in real names)
const decodeDirName = (name: string): string => name.replace(/-/g, "/");

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function scanClaudeSessions(
  days: number,
): Promise<{ groups: ClaudeGroup[]; total: number; dir: string; node: string }> {
  const cutoff = Date.now() - days * 86_400_000;
  const ignoredIds = await loadIgnored();
  const found: ClaudeSession[] = await scanCodexSessions(cutoff, ignoredIds);
  let dirs: Deno.DirEntry[] = [];
  try {
    dirs = await Array.fromAsync(Deno.readDir(CLAUDE_DIR));
  } catch {
    // Codex may still be installed even when Claude Code is not.
    if (!found.length) return { groups: [], total: 0, dir: `${CLAUDE_DIR} + ${CODEX_DIR}`, node: NODE_ID };
  }
  for (const proj of dirs) {
    if (!proj.isDirectory || proj.name.startsWith("-tmp-")) continue;
    let files: Deno.DirEntry[] = [];
    try {
      files = await Array.fromAsync(Deno.readDir(`${CLAUDE_DIR}/${proj.name}`));
    } catch {
      continue;
    }
    for (const e of files) {
      // depth 1 only — subagents/ transcripts live in subdirectories and are not sessions
      if (!e.isFile || !e.name.endsWith(".jsonl")) continue;
      const claudeId = e.name.slice(0, -6);
      if (!UUID_RE.test(claudeId)) continue;
      const path = `${CLAUDE_DIR}/${proj.name}/${e.name}`;
      try {
        const stat = await Deno.stat(path);
        const mtime = stat.mtime?.getTime() ?? 0;
        // cheap pre-filter: mtime is always >= the last message (files only get appended to)
        if (mtime < cutoff) continue;
        const { head, tail } = await readChunks(path);
        const { cwd, aiTitle, lastPrompt, firstPrompt, branch, lastTs, hasActivity } = extractMeta(head, tail);
        if (!hasActivity) continue; // aborted launch — nothing was ever said
        // real last activity = last message timestamp; mtime lags it (ai-title lines
        // and re-indexing touch the file days later) and is only the fallback
        const lastActive = lastTs && !Number.isNaN(Date.parse(lastTs)) ? Date.parse(lastTs) : mtime;
        if (lastActive < cutoff) continue;
        const repoPath = cwd ?? decodeDirName(proj.name);
        const repoName = repoPath.split("/").filter(Boolean).pop() ?? "unknown";
        // first prompt states the task; the last one is usually a follow-up ("ok push")
        const topic = aiTitle ?? firstPrompt ?? lastPrompt;
        found.push({
          source: "claude",
          claudeId,
          title: `${repoName} — ${topic ? truncate(topic, 80) : "untitled session"}`,
          repoPath,
          branch,
          lastActive: new Date(lastActive).toISOString(),
          suggestedStatus: lastActive > Date.now() - 48 * 3_600_000 ? "active" : "paused",
          suggestedClient: clientFor(repoPath),
          suggestedProject: repoName,
          alreadyImported: false,
          ignored: ignoredIds.has(ignoredKey("claude", claudeId)),
        });
      } catch {
        // raced deletion / unreadable file — skip
      }
    }
  }
  // dedup marker: ignore `deleted` on purpose — a deleted card must never resurrect
  if (found.length) {
    const pg = await db();
    // a session counts as imported if a card carries its UUID as id (import) or claude_id (/trame:track)
    const ids = found.map((s) => s.claudeId);
    const existing = new Set(
      ((await pg.query(
        `select id, claude_id from sessions where id = any($1::uuid[]) or claude_id = any($1::uuid[])`,
        [ids],
      )).rows as { id: string; claude_id: string | null }[]).flatMap((r) => [r.id, r.claude_id ?? r.id]),
    );
    for (const s of found) s.alreadyImported = existing.has(s.claudeId);
  }
  const byRepo = new Map<string, ClaudeSession[]>();
  for (const s of found) byRepo.set(s.repoPath ?? "", [...(byRepo.get(s.repoPath ?? "") ?? []), s]);
  const groups: ClaudeGroup[] = [...byRepo.entries()].map(([repoPath, sessions]) => ({
    repoPath,
    repoName: repoPath.split("/").filter(Boolean).pop() ?? "unknown",
    suggestedClient: clientFor(repoPath),
    sessions: sessions.sort((a, b) => b.lastActive.localeCompare(a.lastActive)),
  }));
  groups.sort((a, b) => b.sessions[0].lastActive.localeCompare(a.sessions[0].lastActive));
  return { groups, total: found.length, dir: `${CLAUDE_DIR} + ${CODEX_DIR}`, node: NODE_ID };
}

export async function importClaudeSessions(
  items: ClaudeImportItem[],
): Promise<{ imported: number; skipped: number; ids: string[] }> {
  const pg = await db();
  let imported = 0, skipped = 0;
  const ids: string[] = [];
  for (const item of items) {
    if (!UUID_RE.test(item.claudeId) || !item.title) {
      skipped++;
      continue;
    }
    const exists =
      (await pg.query(`select 1 from sessions where id=$1 or claude_id=$1`, [item.claudeId])).rows.length > 0;
    if (exists) {
      skipped++;
      continue; // create-only: never clobber an existing card
    }
    await upsertSession({
      id: item.claudeId,
      title: item.title,
      status: item.status === "paused" ? "paused" : "active",
      client: item.client || undefined,
      page: item.project || undefined,
      repo_path: item.repoPath ?? undefined,
      branch: item.branch ?? undefined,
      agent: item.source ?? "claude",
      agent_id: item.claudeId,
    });
    const label = item.source === "codex" ? "Codex" : "Claude Code";
    await addEvent(item.claudeId, `Imported from ${label} · ${NODE_ID}`, "import", item.source ?? "claude");
    // backdate recency to the transcript's last activity so the board keeps real order
    // (updated_at/origin stay fresh — the LWW sync still propagates the row)
    await pg.query(`update sessions set last_touched=$2 where id=$1`, [item.claudeId, item.lastActive]);
    imported++;
    ids.push(item.claudeId);
  }
  return { imported, skipped, ids };
}

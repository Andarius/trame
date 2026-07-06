// Import Claude Code sessions (~/.claude/projects/<dashed-cwd>/<uuid>.jsonl) as Trame
// session cards. The Claude session UUID becomes the Trame session id — dedup is a
// single id lookup and re-imports can never clobber user edits (create-only).
// Transcripts can be tens of MB: only a head chunk (first cwd) and a tail chunk
// (LAST ai-title / last-prompt / gitBranch) are read.
import { addEvent, db, upsertSession } from "./db.ts";
import { CLAUDE_DIR } from "./config.ts";

export type ClaudeSession = {
  claudeId: string;
  title: string;
  repoPath: string | null;
  branch: string | null;
  lastActive: string;
  suggestedStatus: "active" | "paused";
  suggestedClient: string;
  suggestedProject: string;
  alreadyImported: boolean;
};
export type ClaudeGroup = {
  repoPath: string;
  repoName: string;
  suggestedClient: string;
  sessions: ClaudeSession[];
};
export type ClaudeImportItem = {
  claudeId: string;
  title: string;
  repoPath: string | null;
  branch: string | null;
  client: string;
  project: string | null;
  status: "active" | "paused";
  lastActive: string;
};

const HEAD_BYTES = 65_536;
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

function extractMeta(head: string, tail: string) {
  let cwd: string | null = null;
  for (const e of parseLines(head)) {
    if (typeof e.cwd === "string" && e.cwd) {
      cwd = e.cwd;
      break;
    }
  }
  let aiTitle: string | null = null, lastPrompt: string | null = null, branch: string | null = null;
  let lastTs: string | null = null;
  for (const e of parseLines(tail)) {
    if (e.type === "ai-title" && typeof e.aiTitle === "string") aiTitle = e.aiTitle; // last wins
    if (e.type === "last-prompt" && typeof e.lastPrompt === "string") lastPrompt = e.lastPrompt;
    if (typeof e.gitBranch === "string") branch = e.gitBranch;
    if (typeof e.timestamp === "string") lastTs = e.timestamp;
    if (!cwd && typeof e.cwd === "string" && e.cwd) cwd = e.cwd;
  }
  if (branch === "HEAD" || branch === "") branch = null;
  return { cwd, aiTitle, lastPrompt, branch, lastTs };
}

// mirrors commands/project/track.md's working-dir → client mapping
const clientFor = (path: string): string =>
  path.includes("/Obitrain/") ? "Obitrain" : path.includes("/Polarsen/") ? "Polarsen" : "Side-projects";

// "-home-julien-Projects-x" → "/home/julien/Projects/x" (lossy: dashes in real names)
const decodeDirName = (name: string): string => name.replace(/-/g, "/");

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function scanClaudeSessions(
  days: number,
): Promise<{ groups: ClaudeGroup[]; total: number; dir: string }> {
  const cutoff = Date.now() - days * 86_400_000;
  const found: ClaudeSession[] = [];
  let dirs: Deno.DirEntry[] = [];
  try {
    dirs = await Array.fromAsync(Deno.readDir(CLAUDE_DIR));
  } catch {
    return { groups: [], total: 0, dir: CLAUDE_DIR }; // no Claude Code installation
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
        const { cwd, aiTitle, lastPrompt, branch, lastTs } = extractMeta(head, tail);
        // real last activity = last message timestamp; mtime lags it (ai-title lines
        // and re-indexing touch the file days later) and is only the fallback
        const lastActive = lastTs && !Number.isNaN(Date.parse(lastTs)) ? Date.parse(lastTs) : mtime;
        if (lastActive < cutoff) continue;
        const repoPath = cwd ?? decodeDirName(proj.name);
        const repoName = repoPath.split("/").filter(Boolean).pop() ?? "unknown";
        found.push({
          claudeId,
          title: `${repoName} — ${aiTitle ?? (lastPrompt ? truncate(lastPrompt, 80) : "untitled session")}`,
          repoPath,
          branch,
          lastActive: new Date(lastActive).toISOString(),
          suggestedStatus: lastActive > Date.now() - 48 * 3_600_000 ? "active" : "paused",
          suggestedClient: clientFor(repoPath),
          suggestedProject: repoName,
          alreadyImported: false,
        });
      } catch {
        // raced deletion / unreadable file — skip
      }
    }
  }
  // dedup marker: ignore `deleted` on purpose — a deleted card must never resurrect
  if (found.length) {
    const pg = await db();
    const existing = new Set(
      ((await pg.query(`select id from sessions where id = any($1::uuid[])`, [found.map((s) => s.claudeId)]))
        .rows as { id: string }[]).map((r) => r.id),
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
  return { groups, total: found.length, dir: CLAUDE_DIR };
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
    const exists = (await pg.query(`select 1 from sessions where id=$1`, [item.claudeId])).rows.length > 0;
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
    });
    await addEvent(item.claudeId, "Imported from Claude Code", "import");
    // backdate recency to the transcript's last activity so the board keeps real order
    // (updated_at/origin stay fresh — the LWW sync still propagates the row)
    await pg.query(`update sessions set last_touched=$2 where id=$1`, [item.claudeId, item.lastActive]);
    imported++;
    ids.push(item.claudeId);
  }
  return { imported, skipped, ids };
}

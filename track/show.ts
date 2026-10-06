// `tramecli show <id | url>` — read a card (fields, specs, worklog) or a page as text.
// The read twin of track/page: agents never need raw HTTP to look something up.
import { parseSessionRef } from "../mcp/session_url.ts";
import { pageBlocksToMarkdown } from "../core/page-markdown.ts";
import { apiRequest, appLink, resolveTarget, type Target } from "./target.ts";

type Card = {
  id: string;
  title: string;
  status: string;
  project?: { name?: string } | null;
  story?: { title?: string } | null;
  branch?: string | null;
  pr_url?: string | null;
  next_step?: string | null;
  specs?: string | null;
  links?: { page_title?: string; anchor?: string }[];
  activity?: { at: string; kind: string; summary: string | null; agent?: string | null; model?: string | null }[];
};
type Page = {
  id: string;
  title: string;
  kind: string;
  brief?: string;
  content: unknown[];
  children?: { id: string; title: string; kind: string }[];
  sessions?: { title: string; status: string; specs_page_id?: string | null }[];
};

async function readCard(t: Target, id: string, events: number): Promise<Card | null> {
  return await (apiRequest(t, `/api/sessions/${id}?events=${events}`) as Promise<Card>).catch(() => null);
}

function printCard(t: Target, c: Card) {
  const meta = [
    c.project?.name && `project: ${c.project.name}`,
    c.story?.title && `story: ${c.story.title}`,
    c.branch && `branch: ${c.branch}`,
    c.pr_url && `PR: ${c.pr_url.split("\n").join(", ")}`,
  ].filter(Boolean).join(" · ");
  console.log(`▦ ${c.title}  [${c.status}]${appLink(t, `view=card&card=${c.id}`)}`);
  if (meta) console.log(meta);
  if (c.next_step) console.log(`next: ${c.next_step}`);
  if (c.links?.length) {
    console.log(`works on: ${c.links.map((l) => l.anchor || l.page_title).filter(Boolean).join(" · ")}`);
  }
  if (c.specs?.trim()) console.log(`\n## Specs\n\n${c.specs.trim()}`);
  if (c.activity?.length) {
    console.log("\n## Worklog\n");
    for (const e of c.activity) {
      const who = [e.agent, e.model].filter(Boolean).join(" · ");
      console.log(`- ${e.at.slice(0, 10)} · ${who ? `${who} · ` : ""}${e.kind} — ${e.summary ?? ""}`);
    }
  }
}

function printPage(t: Target, p: Page) {
  console.log(`# ${p.title || "Untitled"}  [${p.kind}]${appLink(t, `page=${p.id}`)}`);
  if (p.brief?.trim()) console.log(`\n${p.brief.trim()}`);
  const md = pageBlocksToMarkdown(p.content ?? []).trim();
  if (md) console.log(`\n${md}`);
  // a card's spec page is its storage, shown with the card, not as a sub-page
  const specs = new Set((p.sessions ?? []).map((x) => x.specs_page_id).filter(Boolean));
  const subs = (p.children ?? []).filter((c) => !specs.has(c.id));
  if (subs.length) {
    console.log(`\n## Sub-pages\n\n${subs.map((c) => `- ${c.title || "Untitled"} (${c.kind})`).join("\n")}`);
  }
  if (p.sessions?.length) {
    console.log(`\n## Cards\n\n${p.sessions.map((s) => `- ${s.title} [${s.status}]`).join("\n")}`);
  }
}

export async function main(argv: string[], opts: { json: boolean }) {
  const eventsAt = argv.indexOf("--events");
  const events = eventsAt >= 0 ? Number(argv[eventsAt + 1]) || 20 : 20;
  const target = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--events");
  const ref = target ? parseSessionRef(target) : null;
  if (!ref) throw new Error("usage: tramecli show <session id | page id | Trame URL> [--events N] [--json]");
  const t = await resolveTarget();
  // a bare uuid parses as a session; fall back to a page with that id
  const card = ref.kind === "session" ? await readCard(t, ref.id, events) : null;
  if (card) return opts.json ? console.log(JSON.stringify(card)) : printCard(t, card);
  const page = await apiRequest(t, `/api/pages/${ref.id}`).catch(() => null) as Page | null;
  if (!page) throw new Error(`nothing in Trame with id ${ref.id}`);
  return opts.json ? console.log(JSON.stringify(page)) : printPage(t, page);
}

// Phase 3: mirror the tickets a mapping lets us see into Trame story pages.
//
// Identity lives in the PAGE, not on this device. A mirrored page carries a
// {{trame:cockpit_ref=...}} mark, so a second machine finds the page the first
// one made instead of mirroring the same ticket twice — the pages sync, a
// device-local index would not. Cockpit is never asked to hold a Trame id.
import {
  markdownToPageBlocks,
  type PageTextBlock,
} from "../../page-markdown.ts";
import { mergePageBlocks } from "../../page-merge.ts";
import { readMarks, stripMarks, writeMark } from "../../todo-marks.ts";
import type { Ticket } from "./api.ts";

export const REF_MARK = "cockpit_ref";

/** A mirrored page as the planner needs to see it. */
export type MirrorPage = {
  id: string;
  ref: string;
  title: string;
  content: unknown[];
  /** what the page already carries — ours plus anything the reader added */
  tags: string[];
  /** open | done | archived */
  status: string;
};

export type MirrorPlan = {
  create: {
    ref: string;
    title: string;
    blocks: PageTextBlock[];
    tags: string[];
    status: string;
  }[];
  update: {
    id: string;
    ref: string;
    title: string;
    blocks: unknown[];
    tags: string[];
    status: string;
  }[];
  remove: { id: string; ref: string }[];
  /** tickets to close because their page was marked done or archived here */
  push: { ref: string; status: string; expectedUpdatedAt: string }[];
};

// Status, across two vocabularies that do not line up.
//
// Cockpit tracks six execution states; a Trame page has three (open / done /
// archived). The collapse INWARD is total and lossless enough to be useful —
// anything unfinished is simply open. The expansion OUTWARD is not: `open`
// stands for four Cockpit states at once, so writing it back would be a guess,
// and the guess would knock a ticket someone is working on back to `todo`.
//
// Hence the asymmetry below: only the terminal states travel out. Marking a
// page done closes its ticket; nothing you do in Trame can ever regress one.

const TO_PAGE: Record<string, string> = {
  todo: "open",
  in_progress: "open",
  to_verify: "open",
  to_fix: "open",
  done: "done",
  cancelled: "archived",
};

/** The page status a ticket implies. Unknown statuses read as open, not as done. */
export function pageStatusOf(ticketStatus: string): string {
  return TO_PAGE[ticketStatus] ?? "open";
}

/**
 * The ticket status a page implies, or null when the page does not say.
 *
 * Null for `open` on purpose — see above. A null here means "leave the ticket
 * alone", never "reset it".
 */
export function ticketStatusOf(pageStatus: string): string | null {
  if (pageStatus === "done") return "done";
  if (pageStatus === "archived") return "cancelled";
  return null;
}

const line = (label: string, value: string | null | undefined) =>
  value ? `**${label}** — ${value}` : null;

/**
 * The markdown a ticket mirrors to.
 *
 * Deliberately thin: title, the few fields that tell you what the ticket is,
 * then its description. Everything else stays in Cockpit — this page is a
 * working surface for notes and comments, not a second copy of the tracker.
 */
export function ticketMarkdown(t: Ticket): string {
  const meta = [
    line("Statut", t.status),
    line("Revue", t.review_status),
    line("Déploiement", t.deployment_status),
    line("Objectif", t.objective),
  ].filter(Boolean) as string[];

  return [
    `# ${t.reference} — ${t.title}`,
    meta.join("  \n"),
    t.description ?? "",
  ].filter((s) => s.trim()).join("\n\n");
}

/**
 * Blocks for a ticket, with the reference stamped on the heading.
 *
 * The mark goes on the first block because that is the one `mergePageBlocks`
 * is most likely to keep: matching ignores marks, so the heading pairs with
 * its previous self even after a rename, and carries the mark forward.
 */
export function ticketBlocks(t: Ticket): PageTextBlock[] {
  const blocks = markdownToPageBlocks(ticketMarkdown(t));
  if (blocks.length === 0) return blocks;
  const [head, ...rest] = blocks;
  return [
    { ...head, text: writeMark(head.text, REF_MARK, t.reference) },
    ...rest,
  ];
}

/** The ticket a mirrored page stands for, or null when it is not one of ours. */
export function refOfContent(content: unknown[]): string | null {
  for (const b of content) {
    if (typeof b !== "object" || b === null) continue;
    const text = (b as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    const ref = readMarks(text)[REF_MARK];
    if (ref) return ref;
  }
  return null;
}

/** A mapping, as the pending filter needs to see it. */
export type TagMapping = { pageId: string; tagKey: string; tagLabel: string };

/** A candidate page, as the pending filter needs to see it. */
export type PendingCandidate = {
  pageId: string;
  parentId: string;
  tags: string[];
  content: unknown[];
};

/**
 * Which tagged pages are still waiting to be filed as tickets.
 *
 * A page already carrying a reference is never pending, however it got one:
 * mirrored FROM Cockpit, or filed from another device. Without that guard the
 * panel would offer to file a mirrored page, and filing it would mint a second
 * ticket for a ticket that already exists.
 */
export function pendingOf<T extends PendingCandidate>(
  candidates: readonly T[],
  mappings: readonly TagMapping[],
): { page: T; tagLabel: string }[] {
  const out: { page: T; tagLabel: string }[] = [];
  for (const page of candidates) {
    if (refOfContent(page.content)) continue;
    const m = mappings.find((m) =>
      m.pageId === page.parentId && page.tags.includes(m.tagKey)
    );
    if (m) out.push({ page, tagLabel: m.tagLabel });
  }
  return out;
}

/**
 * Decide what to create, rewrite and retire for one mapping.
 *
 * `liveRefs` is what the server currently says is in scope. Null means the
 * /refs call failed — and then nothing is removed at all: a network blip must
 * never be read as "every ticket disappeared". Removal is the only destructive
 * step here, so it is the one that fails closed.
 */
export function planMirror(
  tickets: Ticket[],
  existing: MirrorPage[],
  liveRefs: readonly string[] | null,
  /** tag keys this mirror wants on a ticket's page, by reference */
  tagsByRef: ReadonlyMap<string, string[]> = new Map(),
): MirrorPlan {
  const byRef = new Map(existing.map((p) => [p.ref, p]));
  const plan: MirrorPlan = { create: [], update: [], remove: [], push: [] };

  for (const t of tickets) {
    const blocks = ticketBlocks(t);
    const title = `${t.reference} — ${t.title}`;
    const ours = tagsByRef.get(t.reference) ?? [];
    const page = byRef.get(t.reference);
    if (!page) {
      plan.create.push({
        ref: t.reference,
        title,
        blocks,
        tags: ours,
        status: pageStatusOf(t.status),
      });
      continue;
    }
    // A page closed HERE closes its ticket, rather than being reopened by the
    // next pass. Only terminal states qualify — `ticketStatusOf` returns null
    // for anything else, which is what keeps this from regressing a ticket.
    const out = ticketStatusOf(page.status);
    const closing = out !== null && out !== t.status;
    if (closing) {
      plan.push.push({
        ref: t.reference,
        status: out,
        expectedUpdatedAt: t.updated_at,
      });
    }
    // Merge rather than replace: unchanged lines keep their block ids, so the
    // comments a reader anchored to them survive re-mirroring.
    plan.update.push({
      id: page.id,
      ref: t.reference,
      title,
      blocks: mergePageBlocks(page.content, blocks),
      // Union, never replace: a reader may have tagged this page themselves,
      // and re-mirroring must not quietly strip that.
      tags: [...new Set([...page.tags, ...ours])],
      // Keep the local state while it is on its way out; overwriting it here
      // would undo the very close we just queued.
      status: closing ? page.status : pageStatusOf(t.status),
    });
  }

  if (liveRefs) {
    const live = new Set(liveRefs);
    for (const p of existing) {
      if (!live.has(p.ref)) plan.remove.push({ id: p.id, ref: p.ref });
    }
  }
  return plan;
}

/** One mapping, once its scope has been drained. */
export type Drained<S> = {
  pageId: string;
  scope: S;
  /** tag key this scope stamps on the pages it contributes */
  tag?: string;
  tickets: Ticket[];
  /** the scope could not be read at all */
  failed?: boolean;
};

export type ProjectGroup<S> = {
  pageId: string;
  /** every scope feeding this project, for reporting */
  scopes: S[];
  /**
   * The scopes to ask `/refs` for — EMPTY when a scope failed to load. Asking
   * the rest would build a partial union, which reads as "those tickets are
   * gone" and retires their pages. Empty makes the caller pass null instead,
   * and nothing is retired. The guard lives here so it can be tested.
   */
  refScopes: S[];
  tickets: Ticket[];
  /** the tags each reference earned, by the scopes that returned it */
  tagsByRef: Map<string, string[]>;
  /** a scope in this group failed — the union is incomplete, retire nothing */
  blind: boolean;
};

/**
 * Gather the mappings that feed each Trame project.
 *
 * This is where the reconcile unit is decided, and it is the whole reason the
 * per-mapping version destroyed data: the pages under a project are loaded as
 * a whole, so a plan built from one mapping reads every other mapping's pages
 * as stale. Grouping first means one plan per project, built from everything
 * aiming at it.
 *
 * Tickets are deduplicated by reference — a ticket carries both a product and
 * a flow, so one mapped under each arrives twice — and sorted, so two devices
 * create the same pages in the same order.
 */
export function groupByProject<S>(rows: Drained<S>[]): ProjectGroup<S>[] {
  const groups = new Map<
    string,
    ProjectGroup<S> & { seen: Map<string, Ticket> }
  >();
  for (const r of rows) {
    if (!r.pageId) continue; // mapping feeds the panel only
    const g = groups.get(r.pageId) ?? {
      pageId: r.pageId,
      scopes: [],
      refScopes: [],
      tickets: [],
      tagsByRef: new Map<string, string[]>(),
      blind: false,
      seen: new Map<string, Ticket>(),
    };
    g.scopes.push(r.scope);
    for (const t of r.tickets) {
      g.seen.set(t.reference, t);
      // A ticket returned by two scopes earns both tags — that is how a page
      // under a shared project says where it came from.
      if (r.tag) {
        const has = g.tagsByRef.get(t.reference) ?? [];
        if (!has.includes(r.tag)) g.tagsByRef.set(t.reference, [...has, r.tag]);
      }
    }
    g.blind ||= r.failed === true;
    groups.set(r.pageId, g);
  }
  return [...groups.values()].map(({ seen, ...g }) => ({
    ...g,
    refScopes: g.blind ? [] : g.scopes,
    tickets: [...seen.values()].sort((a, b) =>
      a.reference.localeCompare(b.reference)
    ),
  }));
}

/**
 * What a Trame page offers Cockpit when it becomes a ticket.
 *
 * `objective` is mandatory server-side — it is the "why", and a ticket without
 * one is noise in a shared tracker. The page's own summary line is the natural
 * source; failing that, its first paragraph. We do NOT invent one: a page with
 * nothing to say should be refused, not filed with a placeholder.
 */
export function ticketFromPage(page: {
  id: string;
  title: string;
  story?: string;
  content: unknown[];
}): {
  originId: string;
  title: string;
  objective: string;
  description: string | null;
} | { error: string } {
  const title = page.title.trim();
  if (title.length < 3) {
    return { error: "The page needs a title of at least 3 characters." };
  }

  const paragraphs = page.content.flatMap((b) => {
    if (typeof b !== "object" || b === null) return [];
    const { type, text } = b as { type?: unknown; text?: unknown };
    if (type !== "text" || typeof text !== "string") return [];
    const t = stripMarks(text).trim();
    return t ? [t] : [];
  });

  const objective = (page.story ?? "").trim() || paragraphs[0] || "";
  if (!objective) {
    return {
      error:
        "The page needs a summary or a first paragraph — Cockpit requires an objective.",
    };
  }

  // The objective is already carried on its own; repeating it as the first
  // line of the description would read as a duplicate in Cockpit's UI.
  const rest = paragraphs.filter((t) => t !== objective);
  return {
    originId: page.id,
    title,
    objective,
    description: rest.length ? rest.join("\n\n") : null,
  };
}

/**
 * Put the reference mark on a page's first block, keeping everything else.
 *
 * Used when a local page becomes a ticket: the page already has the reader's
 * own content, so it is stamped in place rather than rewritten from the
 * ticket — which would discard whatever they had written.
 */
export function stampRef(content: unknown[], reference: string): unknown[] {
  const at = content.findIndex((b) =>
    typeof b === "object" && b !== null &&
    typeof (b as { text?: unknown }).text === "string"
  );
  if (at === -1) {
    return [
      ...content,
      {
        type: "text",
        text: `{{trame:${REF_MARK}=${reference}}}`,
        id: crypto.randomUUID(),
      },
    ];
  }
  const block = content[at] as { text: string };
  return content.map((b, i) =>
    i === at
      ? { ...block, text: writeMark(block.text, REF_MARK, reference) }
      : b
  );
}

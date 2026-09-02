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
import { readMarks, writeMark } from "../../todo-marks.ts";
import type { Ticket } from "./api.ts";

export const REF_MARK = "cockpit_ref";

/** A mirrored page as the planner needs to see it. */
export type MirrorPage = {
  id: string;
  ref: string;
  title: string;
  content: unknown[];
};

export type MirrorPlan = {
  create: { ref: string; title: string; blocks: PageTextBlock[] }[];
  update: { id: string; ref: string; title: string; blocks: unknown[] }[];
  remove: { id: string; ref: string }[];
};

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
): MirrorPlan {
  const byRef = new Map(existing.map((p) => [p.ref, p]));
  const plan: MirrorPlan = { create: [], update: [], remove: [] };

  for (const t of tickets) {
    const blocks = ticketBlocks(t);
    const title = `${t.reference} — ${t.title}`;
    const page = byRef.get(t.reference);
    if (!page) {
      plan.create.push({ ref: t.reference, title, blocks });
      continue;
    }
    // Merge rather than replace: unchanged lines keep their block ids, so the
    // comments a reader anchored to them survive re-mirroring.
    plan.update.push({
      id: page.id,
      ref: t.reference,
      title,
      blocks: mergePageBlocks(page.content, blocks),
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

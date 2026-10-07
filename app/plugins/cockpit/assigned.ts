// Tickets assigned to me in Cockpit, from any product or none, as board cards.
//
// The card id is derived from the ticket reference, so every device that sees
// the same ticket converges on one row instead of filing a twin.
import { v5 } from "@std/uuid";
import type { Ticket } from "./api.ts";
import { isSessionTicket, statusClassOf } from "./mirror.ts";

const ASSIGNED_NS = "0aaf1562-b412-4220-a39c-b5f1363dee25";

/** Fallback story for assigned tickets with no user story Trame knows. */
export const ASSIGNED_STORY = "Cockpit — assigned to me";

/** Dedupe key: the card id a ticket reference always maps to. */
export const assignedCardId = (ref: string): Promise<string> =>
  v5.generate(ASSIGNED_NS, new TextEncoder().encode(ref));

/** The token owner's id when Cockpit can feed assigned tickets, else null (skip). */
export function assignedMe(scopes: {
  user?: { id?: unknown } | null;
  capabilities?: { assigned_to_me?: boolean };
}): string | null {
  const id = scopes.user?.id;
  return scopes.capabilities?.assigned_to_me === true &&
      typeof id === "string" && id
    ? id
    : null;
}

/** What a card shows for an assigned ticket. */
export function cardFields(t: Ticket): {
  title: string;
  next_step: string | null;
  summary: string;
} {
  const name = t.created_by_name?.trim();
  const byOther = t.created_by && t.created_by !== t.assignee_id;
  return {
    title: `${t.reference} — ${t.title}`,
    next_step: t.objective?.trim() || null,
    summary: byOther && name ? `Assigned by ${name}` : "",
  };
}

/** The story page a ticket files under, or null for the fallback story. */
export function storyOf(
  t: Ticket,
  usRefById: ReadonlyMap<string, string>,
  usPages: ReadonlyMap<string, { id: string }>,
): string | null {
  const id = t.user_story_id;
  if (!id) return null;
  const ref = /^US-\d+$/.test(id) ? id : usRefById.get(id);
  return (ref && usPages.get(ref)?.id) || null;
}

/** An existing assigned card, keyed by its ticket ref. */
export type AssignedCard = { id: string; deleted: boolean; terminal: boolean };

export type AssignedStep =
  | { kind: "create"; ticket: Ticket }
  | { kind: "sync"; id: string; ticket: Ticket }
  /** `ticket` is absent when the ref left the feed without a trace */
  | { kind: "close"; id: string; ref: string; ticket?: Ticket };

/**
 * Decide each assigned ticket's fate. `tickets` is the complete feed: a card
 * whose ref is absent was un-assigned without a trace and closes too. Cards
 * close (done), never get deleted; a card the user deleted stays deleted.
 * `held` = refs already represented by another page or card.
 */
export function planAssigned(
  tickets: readonly Ticket[],
  me: string,
  cards: ReadonlyMap<string, AssignedCard>,
  held: ReadonlySet<string>,
): AssignedStep[] {
  const steps: AssignedStep[] = [];
  const seen = new Set<string>();
  for (const t of tickets) {
    if (seen.has(t.reference)) continue;
    seen.add(t.reference);
    const gone = t.assignee_id !== me || Boolean(t.archived_at) ||
      t.status === "cancelled";
    const card = cards.get(t.reference);
    if (card) {
      if (card.deleted) continue;
      if (gone) {
        if (!card.terminal) {
          steps.push({
            kind: "close",
            id: card.id,
            ref: t.reference,
            ticket: t,
          });
        }
      } else steps.push({ kind: "sync", id: card.id, ticket: t });
      continue;
    }
    if (
      gone || statusClassOf(t.status) === "closed" || isSessionTicket(t) ||
      held.has(t.reference)
    ) continue;
    steps.push({ kind: "create", ticket: t });
  }
  for (const [ref, card] of cards) {
    if (!seen.has(ref) && !card.deleted && !card.terminal) {
      steps.push({ kind: "close", id: card.id, ref });
    }
  }
  return steps;
}

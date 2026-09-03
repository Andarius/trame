// Page lifecycle — the second of Trame's two status axes.
//
// A page says whether the THING is still worth seeing. A session says what is
// happening to the WORK right now (the `statuses` table, i.e. the board
// columns). They cannot collapse into one field: a story carries several
// sessions, which may be active, blocked and done at the same time, and a
// story with no session at all — one filed and never started, or mirrored from
// another tracker — still has to be hideable.
//
// Three values, and deliberately only three. Anything finer that comes to mind
// ("in progress", "blocked", "paused") is the session axis; anything else
// ("planned", "needs spec") is a tag.

export const PAGE_STATUSES = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" }, // dims and sinks to the bottom of the tree
  { value: "archived", label: "Archived" }, // folds away, leaves the pickers
] as const;

export type PageStatus = (typeof PAGE_STATUSES)[number]["value"];

/**
 * Whether a value is a status the tree knows how to render.
 *
 * Worth a guard because nothing else checks: the column is plain text, and
 * eight readers branch on `done` / `archived` by string. A typo through the
 * API would store fine and then simply never match — the page would look
 * untouched while sitting outside every rule meant to apply to it.
 */
export function isPageStatus(s: unknown): s is PageStatus {
  return PAGE_STATUSES.some((p) => p.value === s);
}

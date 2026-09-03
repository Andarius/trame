// Page lifecycle — the second of Trame's two status axes, and the smaller one.
//
// A page says whether the THING is still worth seeing. A session says what is
// happening to the WORK right now (the `statuses` table, i.e. the board
// columns). They cannot collapse into one field: a story carries several
// sessions, which may be active, blocked and done at the same time, and a
// story with no session at all — one filed and never started, or mirrored from
// another tracker — still has to be hideable.
//
// So the page axis is left with exactly one question: keep this in front of me,
// or fold it away. There WAS a `done` here, inherited from the `objectives`
// table pages replaced; it dimmed a story and sank it in the tree. It was set
// zero times in 110 pages, while `done` on sessions was set 66 times — because
// "finished" is a fact about work, and work is the session. Anything finer that
// comes to mind ("in progress", "blocked", "paused") is that same axis, and
// anything else ("planned", "needs spec") is a tag.

export const PAGE_STATUSES = [
  { value: "open", label: "Open" },
  { value: "archived", label: "Archived" }, // folds away, leaves the pickers
] as const;

export type PageStatus = (typeof PAGE_STATUSES)[number]["value"];

/**
 * Whether a value is a status the tree knows how to render.
 *
 * Worth a guard because nothing else checks: the column is plain text, and
 * several readers branch on `archived` by string. A typo through the API would
 * store fine and then simply never match — the page would look untouched while
 * sitting outside every rule meant to apply to it.
 */
export function isPageStatus(s: unknown): s is PageStatus {
  return PAGE_STATUSES.some((p) => p.value === s);
}

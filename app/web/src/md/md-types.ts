import type { ReactNode } from "react";

// Session-report styling for bullet lists, driven by the section they sit under
// (Page.tsx maps the preceding heading block to a variant): "done" renders green
// checks with muted text, "open" renders copper rings in a copper-tinted callout.
export type ListVariant = "done" | "open";

// renders an event summary as Markdown; passed in so md-activity never imports md
export type RenderMd = (text: string) => ReactNode;

// Linked-session chip data attached to a list item
export type ItemLink = { title: string; color: string; sessionId: string; open: () => void };

// per-row controls (table reorder/comment, open-list mark-done) — only wired by
// the page editor; read-only contexts (comments, drawers) render them inert
export type TableOps = {
  onEdit?: (next: string) => void;
  onCommentRow?: (anchor: string) => void;
  // how many visible comments anchor to this row — tints the row + pins its 💬
  rowComments?: (anchor: string) => number;
  onMarkDone?: (item: string) => void;
  onMarkOpen?: (item: string) => void;
  onEditItem?: (item: string, next: string) => void;
  // Enter inside the item editor: split the item at the caret into two lines
  onSplitItem?: (item: string, before: string, after: string) => void;
  // item text whose editor opens on mount (the fresh half of a split)
  autoEditItem?: string;
  // session links on list items: resolver returns the chip for a linked item,
  // onLinkItem puts "Link a session" in the item's ⋯ menu
  getItemLinks?: (item: string) => ItemLink[];
  onLinkItem?: (item: string) => void;
};

import type { Block } from "../api";

export type TextBlock = Extract<Block, { type: "text" | "heading" | "todo" }>;
export const isText = (b: Block): b is TextBlock =>
  b.type === "text" || b.type === "heading" || b.type === "todo";

export const SLASH: { key: string; label: string; hint: string }[] = [
  { key: "text", label: "Text", hint: "plain paragraph" },
  { key: "heading", label: "Heading", hint: "section title" },
  { key: "todo", label: "To-do", hint: "checkbox item" },
  { key: "tab", label: "Tab section", hint: "heading that becomes a tab" },
  { key: "fold", label: "Folded section", hint: "collapsible heading" },
  { key: "subpage", label: "Sub-page", hint: "nest a page here" },
  { key: "database", label: "Database", hint: "table on this page" },
  { key: "folder", label: "Folder", hint: "live files from a directory" },
  { key: "html", label: "HTML", hint: "embedded interactive doc" },
];

// colors offered when typing "{{" — keys must match PILL_COLORS in md.tsx
export const PILLS: { key: string; dot: string; hint: string }[] = [
  { key: "green", dot: "bg-active", hint: "done / ok" },
  { key: "yellow", dot: "bg-paused", hint: "pending / warn" },
  { key: "red", dot: "bg-blocked", hint: "blocked / error" },
  { key: "copper", dot: "bg-copper", hint: "accent" },
  { key: "gray", dot: "bg-chipline", hint: "neutral" },
];

// pixel position of `index` inside a textarea (mirror-div technique), relative to
// the textarea's top-left; y is the bottom of the caret's line, top its top
export function caretXY(
  el: HTMLTextAreaElement,
  index: number,
): { x: number; y: number; top: number } {
  const div = document.createElement("div");
  const s = getComputedStyle(el);
  for (
    const p of [
      "fontFamily",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "letterSpacing",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "boxSizing",
      "tabSize",
    ] as const
  ) div.style[p] = s[p];
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.overflowWrap = "break-word";
  div.style.width = `${el.clientWidth}px`;
  div.textContent = el.value.slice(0, index);
  const span = document.createElement("span");
  span.textContent = "\u200b";
  div.appendChild(span);
  document.body.appendChild(div);
  const x = span.offsetLeft;
  const top = span.offsetTop;
  const y = top + span.offsetHeight;
  div.remove();
  return { x, y, top };
}

// markdown delimiters behind the selection toolbar / shortcuts (see INLINE in md.tsx)
const INLINE_DELIMS = {
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
} as const;
export type InlineKind = keyof typeof INLINE_DELIMS;

// Toggle the kind's delimiter around [start, end) — whitespace at the selection's
// edges stays outside so the result still parses as emphasis. Returns the new
// text plus the range to re-select.
export function toggleInline(
  text: string,
  start: number,
  end: number,
  kind: InlineKind,
): { text: string; start: number; end: number } {
  const d = INLINE_DELIMS[kind];
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  const n = d.length;
  const inner = text.slice(start, end);
  if (inner.length >= 2 * n && inner.startsWith(d) && inner.endsWith(d)) {
    return {
      text: text.slice(0, start) + inner.slice(n, -n) + text.slice(end),
      start,
      end: end - 2 * n,
    };
  }
  if (text.slice(start - n, start) === d && text.slice(end, end + n) === d) {
    return {
      text: text.slice(0, start - n) + inner + text.slice(end + n),
      start: start - n,
      end: end - n,
    };
  }
  return {
    text: `${text.slice(0, start)}${d}${inner}${d}${text.slice(end)}`,
    start: start + n,
    end: end + n,
  };
}

// Wrap the selection as a markdown link: a selected URL becomes [](url) with the
// caret in the label, anything else [sel]() with the caret in the parens.
export function linkify(
  text: string,
  start: number,
  end: number,
): { text: string; caret: number } {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  const inner = text.slice(start, end);
  const isUrl = /^https?:\/\/\S+$/.test(inner);
  return isUrl
    ? {
      text: `${text.slice(0, start)}[](${inner})${text.slice(end)}`,
      caret: start + 1,
    }
    : {
      text: `${text.slice(0, start)}[${inner}]()${text.slice(end)}`,
      caret: end + 3,
    };
}

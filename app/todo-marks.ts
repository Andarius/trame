// {{trame:key=value}} — machine-readable marks carried inline in a block's text.
// The text is the only store, so a mark survives every reader that treats a block
// as a string. Writers stamp a mark only when it is missing: a date an agent or a
// human wrote is never overwritten.

export type Marks = Record<string, string>;

// Marks whose value is a comma-separated list rather than a single value. These are
// append-only, so they merge by union instead of following the write-once rule.
const LIST_MARKS = new Set(["updated_at"]);

// `updated_at` keeps only the most recent days: the mark sits in the line the user
// types into, so it has to stay bounded.
export const UPDATED_CAP = 5;

// the order marks are re-emitted in, oldest fact first
const MARK_ORDER = ["created_at", "updated_at", "completed_at"];

const MARK = "\\{\\{trame:([a-z_][a-z0-9_]*)=([^{}\\n]*)\\}\\}";
const READ_RE = new RegExp(MARK, "g");
const STRIP_RE = new RegExp(`[ \\t]*${MARK}`, "g");

export function readMarks(text: string): Marks {
  const out: Marks = {};
  for (const [, key, value] of text.matchAll(READ_RE)) {
    out[key] ??= value.trim();
  }
  return out;
}

// the line without its marks — what merges and quote lookups compare on
export function stripMarks(text: string): string {
  return text.replace(STRIP_RE, "");
}

export function setMark(text: string, key: string, value: string): string {
  if (key in readMarks(text)) return text;
  return `${text}${/\s$|^$/.test(text) ? "" : " "}{{trame:${key}=${value}}}`;
}

export function readList(text: string, key: string): string[] {
  const raw = readMarks(text)[key];
  return raw ? raw.split(",").map((v) => v.trim()).filter(Boolean) : [];
}

// unlike setMark, replaces a mark that is already there (append-only lists)
export function writeMark(text: string, key: string, value: string): string {
  const stripped = removeMark(text, key);
  return value ? setMark(stripped, key, value) : stripped;
}

const mergeDays = (...lists: string[][]): string =>
  [...new Set(lists.flat())].sort().slice(-UPDATED_CAP).join(",");

// Record that the visible line changed on `day`. A day already listed collapses into
// the existing entry, and a day equal to created_at is dropped — an item edited on
// the day it was raised has nothing to report.
export function touchTodo(text: string, day: string): string {
  if (readMarks(text).created_at === day) return text;
  return writeMark(
    text,
    "updated_at",
    mergeDays(readList(text, "updated_at"), [day]),
  );
}

export function removeMark(text: string, key: string): string {
  return text.replace(
    new RegExp(`[ \\t]*\\{\\{trame:${key}=[^{}\\n]*\\}\\}`, "g"),
    "",
  );
}

// marks the old line carries and the new one omits, so a full-page rewrite that
// does not repeat them keeps the dates; list marks union instead of deferring
export function carryMarks(from: string, to: string): string {
  let out = to;
  const have = readMarks(to);
  for (const [key, value] of Object.entries(readMarks(from))) {
    if (LIST_MARKS.has(key)) {
      out = writeMark(
        out,
        key,
        mergeDays(
          value.split(",").map((v) => v.trim()).filter(Boolean),
          readList(out, key),
        ),
      );
    } else if (!(key in have)) out = setMark(out, key, value);
  }
  return out;
}

// Marks belong at the end of the line. Typing at the caret pushes text past one, which
// would render as a chip mid-sentence, so writers re-emit them in a stable order.
export function normalizeMarks(text: string): string {
  const marks = readMarks(text);
  const keys = Object.keys(marks);
  if (!keys.length) return text;
  const ordered = [
    ...MARK_ORDER.filter((k) => k in marks),
    ...keys.filter((k) => !MARK_ORDER.includes(k)),
  ];
  let out = stripMarks(text).trimEnd();
  for (const key of ordered) out = setMark(out, key, marks[key]);
  return out;
}

export const todayMark = (d: Date = new Date()): string =>
  [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");

// Fill in what a writer left out, keeping `done` and `completed_at` in agreement.
// A todo that arrives already checked is stamped with the day Trame saw it done —
// agents that know the real date write the mark themselves.
export function stampTodoMarks<T>(blocks: T[], day: string = todayMark()): T[] {
  return blocks.map((b) => {
    const { type, text, done } = (b ?? {}) as {
      type?: unknown;
      text?: unknown;
      done?: unknown;
    };
    if (type !== "todo" || typeof text !== "string") return b;
    let next = setMark(text, "created_at", day);
    next = done
      ? setMark(next, "completed_at", day)
      : removeMark(next, "completed_at");
    next = normalizeMarks(next);
    return next === text ? b : { ...b, text: next };
  });
}

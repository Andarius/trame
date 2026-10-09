import type { ReactNode } from "react";
import { openInBrowser, openPath } from "../api";
import { DuePill } from "../ui/due";
import { isMetadataMark } from "../plugins";
import { PR_HREF, PrChip, SENTRY_ISSUE, SentryChip } from "./chips";

export const safeHref = (url: string): string | undefined =>
  /^(https?:|mailto:|\/|#)/i.test(url.trim()) ? url.trim() : undefined;
// A link may also point at a local file; an image may not — the browser blocks
// `<img src="file:…">` on an http page, so it would render as a broken image.
export const isFile = (url: string) => /^file:/i.test(url.trim());
export const linkHref = (url: string): string | undefined =>
  safeHref(url) ?? (isFile(url) ? url.trim() : undefined);
// file:///a/b%20c → /a/b c
export const filePath = (href: string): string => {
  try {
    return decodeURIComponent(new URL(href).pathname);
  } catch {
    return href.replace(/^file:\/\//i, "");
  }
};

export function Link({ href, children }: { href: string; children: ReactNode }) {
  const local = isFile(href);
  return (
    <a
      href={href}
      title={local ? filePath(href) : undefined}
      className="text-copper underline decoration-copper/40 underline-offset-2 hover:decoration-copper"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation(); // don't bubble into a click-to-edit parent (e.g. comment body)
        // a local file opens through the Explore-root allow-list, never the browser
        if (local) openPath(filePath(href));
        else openInBrowser(href);
      }}
    >
      {children}
    </a>
  );
}

// {{trame:key=value}} marks — dates the app keeps on todos. Rendered as quiet
// chips; the raw form is still there in the textarea while the block is edited.
export const MARK_LABELS: Record<string, string> = {
  created_at: "added",
  completed_at: "done",
  updated_at: "edited",
};

// {{text}} pills — an optional known-color prefix ({{green:done}}) tints them; any
// other "word:" stays part of the text. Full class strings so Tailwind sees them.
export const PILL_COLORS: Record<string, string> = {
  green: "bg-active/15 text-active",
  yellow: "bg-paused/15 text-paused",
  red: "bg-blocked/15 text-blocked",
  copper: "bg-copper/15 text-copper",
  gray: "border border-chipline bg-panel text-ink-soft",
};

// inline tokens, tried in order at the current position. \S boundaries keep "a * b" and
// trailing/leading spaces from being read as emphasis.
export const INLINE: [RegExp, (m: RegExpMatchArray, k: number) => ReactNode][] = [
  [
    /^`([^`]+)`/,
    (m, k) => (
      <code
        key={k}
        className="rounded bg-panel px-1 py-0.5 font-mono text-[0.92em] text-ink"
      >
        {m[1]}
      </code>
    ),
  ],
  [
    /^\*\*(\S[\s\S]*?\S|\S)\*\*/,
    (m, k) => (
      <strong key={k} className="font-semibold text-ink">
        {renderInline(m[1])}
      </strong>
    ),
  ],
  [
    /^\*(\S[\s\S]*?\S|\S)\*/,
    (m, k) => <em key={k} className="italic">{renderInline(m[1])}</em>,
  ],
  [
    /^~~(\S[\s\S]*?\S|\S)~~/,
    (m, k) => <del key={k} className="opacity-70">{renderInline(m[1])}</del>,
  ],
  // images before links — same syntax with a leading !
  [/^!\[([^\]]*)\]\(([^)\s]+)\)/, (m, k) => {
    const src = safeHref(m[2]);
    return src
      ? (
        <img
          key={k}
          src={src}
          alt={m[1]}
          loading="lazy"
          className="my-1.5 max-h-96 max-w-full rounded-md border border-line"
        />
      )
      : m[0];
  }],
  [/^\[([^\]]+)\]\(([^)\s]+)\)/, (m, k) => {
    const h = linkHref(m[2]);
    if (!h) return m[0];
    if (PR_HREF.test(h)) return <PrChip key={k} url={h} label={m[1]} />;
    if (SENTRY_ISSUE.test(h)) return <SentryChip key={k} url={h} label={m[1]} />;
    return <Link key={k} href={h}>{renderInline(m[1])}</Link>;
  }],
  // PR/MR chips before generic bare URLs; trailing path/query (e.g. /files) stays in the link
  [
    /^(https?:\/\/[^\s<>)]+\/(?:pull|-\/merge_requests)\/\d+(?:[/?#][^\s<>)]*)?)/,
    (m, k) => <PrChip key={k} url={m[1]} />,
  ],
  [SENTRY_ISSUE, (m, k) => <SentryChip key={k} url={m[0]} />],
  [
    /^((?:https?|file):\/\/[^\s<>)]+)/,
    (m, k) => <Link key={k} href={m[1]}>{m[1]}</Link>,
  ],
  // marks before the generic pill, which would print them as literal gray text
  [
    /^\{\{trame:([a-z_][a-z0-9_]*)=([^{}\n]*)\}\}/,
    (m, k) => {
      if (m[1] === "due") return <DuePill key={k} due={m[2].trim()} />;
      // a plugin's metadata (a ticket ref, …): its own header or card field shows it
      if (isMetadataMark(m[1])) return null;
      // updated_at is a capped day list: the chip shows the latest, the title the run
      const days = m[2].split(",").map((d) => d.trim()).filter(Boolean);
      const many = m[1] === "updated_at" && days.length > 1;
      return (
        <span
          key={k}
          title={many
            ? `${days.length} edits, ${days[0]} → ${days.at(-1)}`
            : `${m[1]} ${m[2]}`}
          className={`ml-1 inline-block whitespace-nowrap rounded-md px-1.5 py-px font-mono text-[0.78em] ${
            m[1] === "completed_at"
              ? "bg-active/15 text-active"
              : "text-ink-muted"
          }`}
        >
          {MARK_LABELS[m[1]] ?? m[1]} {days.at(-1) ?? m[2]}
          {many && <span className="opacity-60">{` ×${days.length}`}</span>}
        </span>
      );
    },
  ],
  [
    /^\{\{([^{}\n]+?)\}\}/,
    (m, k) => {
      const cm = m[1].match(/^([a-z]+):\s*(\S[\s\S]*)$/);
      const cls = cm && PILL_COLORS[cm[1]];
      return (
        <span
          key={k}
          className={`inline-block whitespace-nowrap rounded-md px-1.5 py-px font-mono text-[0.82em] ${
            cls ?? PILL_COLORS.gray
          }`}
        >
          {(cls ? cm[2] : m[1]).trim()}
        </span>
      );
    },
  ],
  // issue/PR refs (#126) — copper mono, like the session drawer's PR chips
  [
    /^#\d+\b/,
    (m, k) => (
      <span key={k} className="font-mono text-[0.92em] text-copper">
        {m[0]}
      </span>
    ),
  ],
];

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text, key = 0;
  while (rest) {
    let hit = false;
    for (const [re, make] of INLINE) {
      const m = rest.match(re);
      if (m) {
        out.push(make(m, key++));
        rest = rest.slice(m[0].length);
        hit = true;
        break;
      }
    }
    if (hit) continue;
    // consume plain text up to the next possible token start (always ≥1 char → no loop)
    const next = rest.slice(1).search(/[`*~[#!{]|(?:https?|file):\/\//);
    const take = next === -1 ? rest.length : next + 1;
    out.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  return out;
}

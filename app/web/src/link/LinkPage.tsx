// Read-only renderer for shared pages. Mirrors Page.tsx's visual language —
// Markdown blocks, todo rows, {{tab}} strips / {{fold}} accordions, database
// tables — without any editing affordances. Data comes fully resolved from the
// hub (window.__TRAME_LINK__); the only requests this page makes are its assets.
import { useEffect, useRef, useState } from "react";
import { Markdown } from "../md";
import { BRIDGE } from "../HtmlBlock";
import { fmtNumber, OptionChip } from "../udb/cells";
import { blocksToMarkdown } from "../page-serialize";
import type { PropConfig, SelectOption } from "../api";

export type LinkBlock = {
  type: string;
  text?: string;
  done?: boolean;
  indent?: number;
  id?: string;
  db_id?: string;
  page_id?: string;
  html?: string;
  height?: number;
};
export type LinkProp = {
  id: string;
  name: string;
  type: string;
  config: PropConfig;
};
export type LinkDb = {
  name: string;
  icon: string | null;
  props: LinkProp[];
  rows: { icon: string | null; vals: Record<string, unknown> }[];
};
export type LinkData = {
  token: string;
  page: { id: string; title: string; icon: string | null; story: string };
  blocks: LinkBlock[];
  children: { id: string; title: string; icon: string | null }[];
  subpages: Record<string, { title: string; icon: string | null }>;
  databases: Record<string, LinkDb>;
  attached: string[];
  isRoot: boolean;
};

const pageHref = (token: string, id: string) => `/l/${token}/p/${id}`;

function Cell({ p, v }: { p: LinkProp; v: unknown }) {
  if (v === null || v === undefined || v === "") return null;
  if (p.type === "checkbox") {
    return v ? <span className="text-active">✓</span> : null;
  }
  if (p.type === "number") {
    return <span>{fmtNumber(v, p.config ?? {})}</span>;
  }
  if (p.type === "date" && typeof v === "object") {
    const d = v as { start?: string; end?: string };
    return <span>{d.start}{d.end ? ` → ${d.end}` : ""}</span>;
  }
  if (p.type === "select" || p.type === "multiselect") {
    const ids = Array.isArray(v) ? v : [v];
    const opts = (p.config?.options ?? []) as SelectOption[];
    return (
      <span className="inline-flex flex-wrap gap-1">
        {ids.flatMap((id) => {
          const opt = opts.find((o) => o.id === id);
          return opt ? [<OptionChip key={opt.id} opt={opt} />] : [];
        })}
      </span>
    );
  }
  if (p.type === "url" && typeof v === "string") {
    return (
      <a
        href={v}
        target="_blank"
        rel="noopener"
        className="text-copper underline decoration-copper/40 underline-offset-2"
      >
        {v.replace(/^https?:\/\//, "")}
      </a>
    );
  }
  return <span>{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>;
}

function DbTable({ db }: { db: LinkDb }) {
  return (
    <div className="my-2 overflow-x-auto rounded-lg border border-line bg-block px-3 py-1">
      <div className="pt-2 text-[12.5px] font-medium text-ink">
        {db.icon ? `${db.icon} ` : ""}
        {db.name}
      </div>
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            {db.props.map((p) => (
              <th
                key={p.id}
                className="border-b border-line px-2.5 py-2 text-left text-[0.8em] font-medium uppercase tracking-wider text-ink-muted"
              >
                {p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {db.rows.map((r, ri) => (
            <tr key={ri} className="border-b border-line-soft/50 last:border-0">
              {db.props.map((p, ci) => (
                <td
                  key={p.id}
                  className="px-2.5 py-1.5 align-top text-ink-soft"
                >
                  {ci === 0 && r.icon ? `${r.icon} ` : ""}
                  <Cell p={p} v={(r.vals ?? {})[p.id]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// same sandboxed iframe as the app's HtmlBlock, sans editing (data-back is off:
// the bridge's send() posts to us and we simply ignore it)
function HtmlFrame({ b }: { b: LinkBlock }) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const pinned = typeof b.height === "number";
  const [height, setHeight] = useState(pinned ? b.height! : 300);
  useEffect(() => {
    if (pinned) return;
    const onMsg = (e: MessageEvent) => {
      if (frame.current?.contentWindow !== e.source) return;
      if (e.data?.trame === "height" && typeof e.data.height === "number") {
        setHeight(Math.min(Math.ceil(e.data.height) + 2, 4000));
      }
    };
    addEventListener("message", onMsg);
    return () => removeEventListener("message", onMsg);
  }, [pinned]);
  return (
    <iframe
      ref={frame}
      sandbox="allow-scripts"
      allow="clipboard-write"
      srcDoc={(b.html ?? "") + BRIDGE}
      style={{ height }}
      className="my-1 w-full rounded-lg border border-line bg-canvas"
      title="embedded document"
    />
  );
}

// {{tab}}/{{fold}} grouping — the read-only mirror of Page.tsx's tabMeta
function sectionMeta(blocks: LinkBlock[]) {
  let group: number | null = null;
  let foldAt: number | null = null;
  const heads = new Map<number, { i: number; title: string }[]>();
  const of = new Map<
    number,
    { kind: "tab" | "fold"; group: number; tab: number }
  >();
  blocks.forEach((b, i) => {
    const m = b.type === "heading" &&
      (b.text ?? "").match(/\{\{(tab|fold)\}\}/i);
    if (m && m[1].toLowerCase() === "tab") {
      foldAt = null;
      if (group === null) {
        group = i;
        heads.set(i, []);
      }
      heads.get(group)!.push({
        i,
        title: (b.text ?? "").replace(/\s*\{\{tab\}\}\s*/i, " ").trim(),
      });
      of.set(i, { kind: "tab", group, tab: heads.get(group)!.length - 1 });
    } else if (m) {
      group = null;
      foldAt = i;
      of.set(i, { kind: "fold", group: i, tab: 0 });
    } else if (group !== null) {
      of.set(i, { kind: "tab", group, tab: heads.get(group)!.length - 1 });
    } else if (foldAt !== null) {
      of.set(i, { kind: "fold", group: foldAt, tab: 0 });
    }
  });
  return { heads, of };
}

export function LinkPage({ data }: { data: LinkData }) {
  const { token, page, blocks, children, subpages, databases, attached } = data;
  const [activeTabs, setActiveTabs] = useState<Record<string, number>>({});
  const [openFolds, setOpenFolds] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const copyMarkdown = () =>
    navigator.clipboard.writeText(blocksToMarkdown(page.title, blocks)).then(
      () => {
        clearTimeout(copyTimer.current);
        setCopied(true);
        copyTimer.current = setTimeout(() => setCopied(false), 2000);
      },
      () => {/* clipboard blocked — nothing to show */},
    );
  const meta = sectionMeta(blocks);
  const inlineDbs = new Set(
    blocks.flatMap((b) => (b.type === "database" && b.db_id ? [b.db_id] : [])),
  );

  return (
    <div className="mx-auto max-w-[760px] px-6 pb-16 pt-10">
      {!data.isRoot && (
        <a
          href={`/l/${token}`}
          className="text-[12.5px] text-ink-muted hover:text-copper"
        >
          ← back
        </a>
      )}
      <div className="mt-2 flex items-start justify-between gap-3">
        <h1 className="mb-1 text-[22px] font-semibold text-ink">
          {page.icon ? `${page.icon} ` : ""}
          {page.title || "Untitled"}
        </h1>
        <button
          type="button"
          title="Copy the whole page as Markdown"
          onClick={copyMarkdown}
          className="mt-1.5 shrink-0 rounded-md border border-line px-2 py-1 text-[11.5px] text-ink-muted transition-colors hover:text-ink-soft"
        >
          {copied ? "Copied ✓" : "Copy as Markdown"}
        </button>
      </div>
      {page.story && (
        <p className="mb-4 text-[12.5px] text-ink-muted">{page.story}</p>
      )}

      {blocks.map((b, i) => {
        const bid = b.id ?? String(i);
        const tm = meta.of.get(i);
        if (tm) {
          const gid = blocks[tm.group].id ?? String(tm.group);
          if (tm.kind === "fold") {
            const open = openFolds[gid] ?? false;
            if (i === tm.group) {
              const title = (b.text ?? "").replace(/\s*\{\{fold\}\}\s*/i, " ")
                .trim();
              return (
                <div
                  key={bid}
                  className="my-1 overflow-hidden rounded-lg border border-line-soft"
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 bg-panel px-3 py-2 text-left text-[13px] font-medium text-ink transition-colors hover:text-copper"
                    onClick={() =>
                      setOpenFolds((m) => ({ ...m, [gid]: !open }))}
                  >
                    <span className="text-[10px] text-ink-muted">
                      {open ? "▾" : "▸"}
                    </span>
                    {title || "untitled"}
                  </button>
                </div>
              );
            }
            if (!open) return null;
          } else {
            const active = activeTabs[gid] ?? 0;
            const heads = meta.heads.get(tm.group)!;
            if (heads.some((h) => h.i === i)) {
              if (i !== tm.group) return null;
              return (
                <div
                  key={bid}
                  className="flex gap-1 border-b border-line pb-0 pt-2"
                >
                  {heads.map((h, ti) => (
                    <button
                      key={h.i}
                      type="button"
                      className={`-mb-px border-b-2 px-3 py-1.5 text-[12.5px] transition-colors ${
                        ti === active
                          ? "border-copper font-medium text-copper"
                          : "border-transparent text-ink-muted hover:text-ink-soft"
                      }`}
                      onClick={() =>
                        setActiveTabs((m) => ({ ...m, [gid]: ti }))}
                    >
                      {h.title || "untitled"}
                    </button>
                  ))}
                </div>
              );
            }
            if (tm.tab !== active) return null;
          }
        }

        if (b.type === "html") return <HtmlFrame key={bid} b={b} />;
        if (b.type === "database" && b.db_id && databases[b.db_id]) {
          return <DbTable key={bid} db={databases[b.db_id]} />;
        }
        if (b.type === "subpage" && b.page_id && subpages[b.page_id]) {
          const sub = subpages[b.page_id];
          return (
            <p key={bid} className="my-1 text-[13px]">
              ↳{" "}
              <a
                href={pageHref(token, b.page_id)}
                className="text-ink-soft hover:text-copper"
              >
                {sub.icon ?? "📄"} {sub.title || "Untitled"}
              </a>
            </p>
          );
        }
        if (!["text", "heading", "todo"].includes(b.type)) return null;

        // the nearest heading above decides how bullets render (see Page.tsx)
        let listVariant: "done" | "open" | undefined;
        for (let j = i - 1; j >= 0; j--) {
          const pb = blocks[j];
          if (pb.type !== "heading") continue;
          listVariant = /^\s*(completed|done|shipped)\b/i.test(pb.text ?? "")
            ? "done"
            : /^\s*(open|todo|next|pending|remaining|in progress|blocked)\b/i
                .test(pb.text ?? "")
            ? "open"
            : undefined;
          break;
        }
        const textCls = b.type === "heading"
          ? "text-[16px] font-semibold text-ink"
          : `text-[13px] leading-relaxed ${
            b.type === "todo" && b.done
              ? "text-ink-muted line-through"
              : "text-ink-soft"
          }`;
        return (
          <div
            key={bid}
            className="flex items-start gap-2"
            style={b.indent ? { paddingLeft: b.indent * 20 } : undefined}
          >
            {b.type === "todo" && (
              <span className="mt-[7px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {b.done
                  ? (
                    <span className="text-[12px] leading-none text-active">
                      ✓
                    </span>
                  )
                  : (
                    <span className="h-3 w-3 rounded-full border-[1.5px] border-copper" />
                  )}
              </span>
            )}
            <div className={`w-full py-1 ${textCls}`}>
              <Markdown text={b.text ?? ""} listVariant={listVariant} />
            </div>
          </div>
        );
      })}

      {attached.filter((id) => !inlineDbs.has(id) && databases[id]).map((
        id,
      ) => <DbTable key={id} db={databases[id]} />)}

      {children.length > 0 && (
        <>
          <div className="mb-1 mt-6 text-[16px] font-semibold text-ink">
            Pages
          </div>
          {children.map((c) => (
            <p key={c.id} className="my-1 text-[13px]">
              ↳{" "}
              <a
                href={pageHref(token, c.id)}
                className="text-ink-soft hover:text-copper"
              >
                {c.icon ?? "📄"} {c.title || "Untitled"}
              </a>
            </p>
          ))}
        </>
      )}

      <p className="mt-12 text-[11.5px] text-ink-muted">
        Shared read-only from Trame.
      </p>
    </div>
  );
}

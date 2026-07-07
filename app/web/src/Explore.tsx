import { useEffect, useMemo, useRef, useState } from "react";
import {
  type BoardData,
  deleteReportFile,
  type FileHit,
  getReport,
  getReportFileContent,
  getReportFiles,
  getReports,
  getSettings,
  openInBrowser,
  patchSettings,
  type ReportMeta,
} from "./api";
import { appConfirm, ClientChip, timeAgo } from "./ui";
import { excalidrawToHtml } from "./excalidraw";

type Selected = {
  kind: "db" | "file";
  id?: string;
  path?: string;
  title: string;
  date?: string;
  html: string;
};

const HOME_RE = /^\/home\/[^/]+\/|^\/Users\/[^/]+\//;

type FolderNode = {
  name: string;
  full: string;
  folders: FolderNode[];
  files: FileHit[];
  newest: string;
  count: number;
};

export function Explore(
  { board, onOpenSettings }: { board: BoardData; onOpenSettings?: () => void },
) {
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Selected | null>(null);
  const [selKey, setSelKey] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [starred, setStarred] = useState<string[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  // folder tree: collapsed dirs persist like a file explorer
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("trame:explore-collapsed") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const toggleFolder = (full: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(full) ? next.delete(full) : next.add(full);
      localStorage.setItem("trame:explore-collapsed", JSON.stringify([...next]));
      return next;
    });
  const [htmlFilter, setHtmlFilter] = useState<"smart" | "all">("smart");
  const [kindFilter, setKindFilter] = useState<"both" | "html" | "excalidraw">("both");

  const load = (force = false, selectFirst = false) => {
    setRefreshing(true);
    Promise.allSettled([
      getReports().then((list) => {
        if (!Array.isArray(list)) return;
        setReports(list);
        if (selectFirst && list.length) selectDb(list[0]);
      }),
      getReportFiles(force).then((f) => Array.isArray(f) && setFiles(f)),
      getSettings().then((s) => {
        setStarred(s.starred ?? []);
        setHtmlFilter(s.htmlFilter ?? "smart");
        setRoots(s.paths ?? []);
      }),
    ]).finally(() => setRefreshing(false));
  };
  useEffect(() => load(false, true), []);

  const toggleFilter = () => {
    const next = htmlFilter === "smart" ? "all" : "smart";
    setHtmlFilter(next);
    patchSettings({ htmlFilter: next }).then(() => load(true));
  };
  const cycleKind = () => {
    setKindFilter((k) => (k === "both" ? "html" : k === "html" ? "excalidraw" : "both"));
  };
  const toggleStar = (dir: string) => {
    const next = starred.includes(dir) ? starred.filter((d) => d !== dir) : [...starred, dir];
    setStarred(next);
    patchSettings({ starredPaths: next });
  };
  const ignoreFolder = async (dir: string) => {
    // warn only on first use — afterwards ⊘ applies immediately (undo lives in ⚙︎ Settings)
    if (!localStorage.getItem("trame:ignore-warned")) {
      if (!(await appConfirm(`Ignore ${dir}?\n\nIgnored folders can be restored in ⚙︎ Settings.\n(This warning is only shown once.)`, "Ignore"))) {
        return;
      }
      localStorage.setItem("trame:ignore-warned", "1");
    }
    getSettings()
      .then((s) => patchSettings({ ignorePaths: [...(s.ignore ?? []), dir] }))
      .then(() => load(true));
  };

  const selectDb = (r: ReportMeta) => {
    setSelKey(`db:${r.id}`);
    getReport(r.id).then((full) =>
      setSelected({ kind: "db", id: r.id, title: full.title, date: full.created_at, html: full.html })
    );
  };
  const selectFile = (f: FileHit) => {
    setSelKey(`file:${f.path}`);
    getReportFileContent(f.path).then(async (c) => {
      // .excalidraw is JSON — pre-render to static SVG (the iframe sandbox blocks scripts)
      const html = f.name.endsWith(".excalidraw")
        ? await excalidrawToHtml(c.html, f.name).catch((e) =>
          `<pre style="padding:16px;color:#b91c1c">could not render ${f.name}: ${e}</pre>`)
        : c.html;
      setSelected({ kind: "file", title: f.name, date: f.mtime, html, path: f.path });
    }).catch(() => {});
  };

  const needle = q.trim().toLowerCase();
  const shownReports = needle
    ? reports.filter((r) => r.title.toLowerCase().includes(needle))
    : reports;
  const shownFiles = files.filter((f) => {
    if (needle && !f.path.toLowerCase().includes(needle)) return false;
    if (kindFilter === "both") return true;
    const isExcalidraw = f.name.endsWith(".excalidraw");
    return kindFilter === "excalidraw" ? isExcalidraw : !isExcalidraw;
  });

  // folder tree under the configured roots — single-child chains are merged
  // ("reports/2026"), starred folders pinned first, then freshest-first
  const tree = useMemo(() => {
    const nodes = new Map<string, FolderNode>();
    const ensure = (full: string, name: string): FolderNode => {
      let n = nodes.get(full);
      if (!n) {
        n = { name, full, folders: [], files: [], newest: "", count: 0 };
        nodes.set(full, n);
      }
      return n;
    };
    const tops: FolderNode[] = [];
    for (const f of shownFiles) {
      const dir = f.path.slice(0, f.path.lastIndexOf("/"));
      const root = roots.find((r) => dir === r || dir.startsWith(r + "/")) ?? dir;
      let cur = ensure(root, root.replace(HOME_RE, "~/"));
      if (!tops.includes(cur)) tops.push(cur);
      if (dir !== root) {
        let acc = root;
        for (const seg of dir.slice(root.length + 1).split("/")) {
          acc += "/" + seg;
          const child = ensure(acc, seg);
          if (!cur.folders.includes(child)) cur.folders.push(child);
          cur = child;
        }
      }
      cur.files.push(f);
    }
    const finish = (n: FolderNode): FolderNode => {
      // merge empty single-child folders into their parent's label
      while (n.files.length === 0 && n.folders.length === 1) {
        const only = n.folders[0];
        n = { ...only, name: `${n.name}/${only.name}` };
      }
      n.folders = n.folders.map(finish);
      n.count = n.files.length + n.folders.reduce((sum, c) => sum + c.count, 0);
      n.newest = [n.files[0]?.mtime ?? "", ...n.folders.map((c) => c.newest)]
        .reduce((a, b) => (b > a ? b : a), "");
      n.folders.sort((a, b) =>
        Number(starred.includes(b.full)) - Number(starred.includes(a.full)) ||
        b.newest.localeCompare(a.newest)
      );
      return n;
    };
    return tops.map(finish).sort((a, b) =>
      Number(starred.includes(b.full)) - Number(starred.includes(a.full)) ||
      b.newest.localeCompare(a.newest)
    );
  }, [shownFiles, starred, roots]);

  // visible files in display order (search forces every folder open)
  const visibleFiles = useMemo(() => {
    const out: FileHit[] = [];
    const walk = (n: FolderNode) => {
      if (!needle && collapsed.has(n.full)) return;
      for (const c of n.folders) walk(c);
      out.push(...n.files);
    };
    for (const n of tree) walk(n);
    return out;
  }, [tree, collapsed, needle]);

  // ↑/↓ moves the selection through the visible list (reports then files, display order)
  const flat = [
    ...shownReports.map((r) => ({ key: `db:${r.id}`, sel: () => selectDb(r) })),
    ...visibleFiles.map((f) => ({ key: `file:${f.path}`, sel: () => selectFile(f) })),
  ];
  const flatRef = useRef(flat);
  flatRef.current = flat;
  const selKeyRef = useRef(selKey);
  selKeyRef.current = selKey;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "Delete") {
        // Suppr deletes the selected file — but never while typing
        if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") return;
        deleteRef.current();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (t.tagName === "TEXTAREA") return;
      if (t.tagName === "INPUT" && t.getAttribute("data-nav") !== "1") return;
      const list = flatRef.current;
      if (!list.length) return;
      e.preventDefault();
      const idx = list.findIndex((f) => f.key === selKeyRef.current);
      const next = idx === -1
        ? 0
        : e.key === "ArrowDown"
        ? Math.min(idx + 1, list.length - 1)
        : Math.max(idx - 1, 0);
      const item = list[next];
      item.sel();
      requestAnimationFrame(() =>
        document.querySelector(`[data-key="${CSS.escape(item.key)}"]`)?.scrollIntoView({ block: "nearest" })
      );
    };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, []);

  const openExternal = () => {
    if (!selected) return;
    const target = selected.kind === "db"
      ? `/report/${selected.id}`
      : `/report-file?path=${encodeURIComponent(selected.path!)}`;
    openInBrowser(target);
  };

  // delete the selected FILE (button or Suppr key) — trash when available, neighbor selected after
  const deleteCurrent = async () => {
    if (!selected || selected.kind !== "file" || !selected.path) return;
    if (!(await appConfirm(`Delete ${selected.title}?\n(moved to the system trash when available)`))) return;
    const list = flatRef.current;
    const idx = list.findIndex((f) => f.key === selKeyRef.current);
    const neighbor = list[idx + 1] ?? list[idx - 1] ?? null;
    deleteReportFile(selected.path).then((r) => {
      if (!r.ok) return;
      if (neighbor) neighbor.sel();
      else {
        setSelected(null);
        setSelKey("");
      }
      load(true);
    }).catch(() => {});
  };
  const deleteRef = useRef(deleteCurrent);
  deleteRef.current = deleteCurrent;

  const sectionLbl = "px-2 pb-1 pt-3 text-[10px] font-medium tracking-[0.7px] text-ink-muted/70";

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[330px] shrink-0 flex-col overflow-y-auto border-r border-line p-3">
        <div className="mb-1 flex gap-1.5">
          <input
            data-nav="1"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search reports & files…  (↑↓ to browse)"
            className="min-w-0 flex-1 rounded-md border border-chipline bg-transparent px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-muted/50 focus:border-copper/60"
          />
          <button type="button"
            onClick={toggleFilter}
            disabled={refreshing}
            title={htmlFilter === "smart"
              ? "smart: only self-contained reports (app/build html hidden) — click to show all"
              : "all: every html file — click to filter to reports only"}
            className={`rounded-md border px-2 text-[10.5px] disabled:opacity-40 ${
              htmlFilter === "smart"
                ? "border-copper/50 text-copper"
                : "border-chipline text-ink-muted hover:text-ink-soft"
            }`}
          >
            {htmlFilter}
          </button>
          <button type="button"
            onClick={cycleKind}
            title={`showing ${kindFilter === "both" ? "html & excalidraw" : kindFilter} files — click to cycle`}
            className={`rounded-md border px-2 text-[10.5px] ${
              kindFilter === "both"
                ? "border-chipline text-ink-muted hover:text-ink-soft"
                : "border-copper/50 text-copper"
            }`}
          >
            {kindFilter === "both" ? "◧◨" : kindFilter === "html" ? "html" : "excal"}
          </button>
          <button type="button"
            onClick={() => load(true)}
            disabled={refreshing}
            title="Rescan folders"
            className="rounded-md border border-chipline px-2 text-[13px] text-ink-muted hover:text-ink-soft disabled:opacity-40"
          >
            <span className={refreshing ? "inline-block animate-spin" : ""}>↻</span>
          </button>
        </div>
        {shownReports.length > 0 && <div className={sectionLbl}>PUBLISHED</div>}
        {shownReports.map((r) => {
          const client = board.clients.find((c) => c.id === r.client_id);
          const active = selKey === `db:${r.id}`;
          return (
            <button type="button"
              key={r.id}
              data-key={`db:${r.id}`}
              onClick={() => selectDb(r)}
              className={`flex flex-col items-start gap-1 rounded-lg px-2.5 py-2 text-left ${
                active ? "bg-[#1a1d26]" : "hover:bg-[#14161c]"
              }`}
            >
              <span className={`text-[12.5px] font-medium leading-snug ${active ? "" : "text-[#c7cbd4]"}`}>
                {r.title}
              </span>
              <span className="flex items-center gap-1.5">
                {client && <ClientChip name={client.name} color={client.color} />}
                <span className="text-[10.5px] text-ink-muted">{timeAgo(r.created_at)}</span>
              </span>
            </button>
          );
        })}
        {tree.length > 0 && <div className={sectionLbl}>FILES</div>}
        {tree.map((n) => (
          <FolderRow
            key={n.full}
            node={n}
            depth={0}
            collapsed={collapsed}
            forceOpen={!!needle}
            starred={starred}
            selKey={selKey}
            onToggle={toggleFolder}
            onStar={toggleStar}
            onIgnore={ignoreFolder}
            onSelect={selectFile}
          />
        ))}
        {files.length === 0 && (
          <p className="px-2 py-2 text-[11px] leading-relaxed text-ink-muted/80">
            No indexed files —{" "}
            <button type="button" className="text-ink-soft underline underline-offset-2 hover:text-copper" onClick={onOpenSettings}>
              configure folders
            </button>{" "}
            to search HTML reports and .excalidraw drawings on disk.
          </p>
        )}
        {reports.length === 0 && (
          <p className="px-2 py-2 text-[11px] leading-relaxed text-ink-muted/80">
            No published reports yet — ask Claude to use the <code>trame_report</code> MCP tool.
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected
          ? (
            <>
              <div className="flex items-center gap-2.5 border-b border-line px-5 py-2.5">
                <span className="text-[12.5px] font-medium text-[#d9dde5]">{selected.title}</span>
                {selected.path && (
                  <span className="max-w-[380px] truncate text-[10.5px] text-ink-muted" title={selected.path}>
                    {selected.path.replace(HOME_RE, "~/")}
                  </span>
                )}
                {selected.date && <span className="text-[11px] text-ink-muted">{timeAgo(selected.date)}</span>}
                <span className="flex-1" />
                {selected.kind === "file" && (
                  <button type="button"
                    className="text-[11.5px] text-ink-muted hover:text-blocked"
                    title="delete file (Suppr) — system trash when available"
                    onClick={deleteCurrent}
                  >
                    🗑 Delete
                  </button>
                )}
                <button type="button" className="text-[11.5px] text-ink-muted hover:text-ink-soft" onClick={openExternal}>
                  ↗ Open in browser
                </button>
              </div>
              <div className="min-h-0 flex-1 p-5">
                <iframe
                  sandbox=""
                  srcDoc={selected.html}
                  className="h-full w-full rounded-[10px] border-0 bg-[#f6f5f2]"
                  title={selected.title}
                />
              </div>
            </>
          )
          : <p className="p-6 text-ink-muted">Select a report</p>}
      </div>
    </div>
  );
}

function FolderRow(
  { node, depth, collapsed, forceOpen, starred, selKey, onToggle, onStar, onIgnore, onSelect }: {
    node: FolderNode;
    depth: number;
    collapsed: Set<string>;
    forceOpen: boolean;
    starred: string[];
    selKey: string;
    onToggle: (full: string) => void;
    onStar: (full: string) => void;
    onIgnore: (full: string) => void;
    onSelect: (f: FileHit) => void;
  },
) {
  const open = forceOpen || !collapsed.has(node.full);
  const isStarred = starred.includes(node.full);
  return (
    <div className="flex flex-col">
      <div
        className="group flex items-center gap-1 rounded px-1 pb-0.5 pt-1.5"
        style={{ paddingLeft: 4 + depth * 12 }}
      >
        <button type="button"
          onClick={() => onToggle(node.full)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          title={node.full}
        >
          <span className="w-[11px] shrink-0 text-[9px] text-ink-muted/70">{open ? "▾" : "▸"}</span>
          <span className="min-w-0 truncate text-[10.5px] text-ink-muted/80">{node.name}</span>
          {!open && <span className="shrink-0 text-[9.5px] text-ink-muted/50">{node.count}</span>}
        </button>
        <button type="button"
          onClick={() => onStar(node.full)}
          title={isStarred ? "unstar" : "star — pin this folder on top"}
          className={`text-[11px] leading-none ${
            isStarred ? "text-copper" : "text-ink-muted/40 opacity-0 group-hover:opacity-100"
          } hover:text-copper`}
        >
          ★
        </button>
        <button type="button"
          onClick={() => onIgnore(node.full)}
          title="ignore this folder"
          className="text-[11px] leading-none text-ink-muted/40 opacity-0 hover:text-blocked group-hover:opacity-100"
        >
          ⊘
        </button>
      </div>
      {open && node.folders.map((c) => (
        <FolderRow
          key={c.full}
          node={c}
          depth={depth + 1}
          collapsed={collapsed}
          forceOpen={forceOpen}
          starred={starred}
          selKey={selKey}
          onToggle={onToggle}
          onStar={onStar}
          onIgnore={onIgnore}
          onSelect={onSelect}
        />
      ))}
      {open && node.files.map((f) => {
        const active = selKey === `file:${f.path}`;
        return (
          <button type="button"
            key={f.path}
            data-key={`file:${f.path}`}
            onClick={() => onSelect(f)}
            className={`flex items-center gap-2 rounded-lg py-1.5 pr-2.5 text-left ${
              active ? "bg-[#1a1d26]" : "hover:bg-[#14161c]"
            }`}
            style={{ paddingLeft: 16 + depth * 12 }}
          >
            <span
              className={`min-w-0 flex-1 truncate text-[12.5px] font-medium leading-snug ${
                active ? "" : "text-[#c7cbd4]"
              }`}
            >
              {f.name}
            </span>
            {f.mtime && <span className="shrink-0 text-[10px] text-ink-muted">{timeAgo(f.mtime)}</span>}
          </button>
        );
      })}
    </div>
  );
}

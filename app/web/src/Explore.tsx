import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
import { appConfirm, ClientChip, Popover, timeAgo } from "./ui";
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
// section headers share the folder "collapsed" set under sentinel keys
const SEC_PUBLISHED = "§published";
const SEC_FILES = "§files";

type FolderNode = {
  name: string;
  full: string;
  folders: FolderNode[];
  files: FileHit[];
  newest: string;
  count: number;
};

export function Explore(
  { board, onOpenSettings, initialPath, onConsumed, onBack }: {
    board: BoardData;
    onOpenSettings?: () => void;
    initialPath?: string | null;
    onConsumed?: () => void;
    onBack?: () => void;
  },
) {
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Selected | null>(null);
  const [selKey, setSelKey] = useState("");
  const [multi, setMulti] = useState<Set<string>>(new Set()); // extra file paths (ctrl/shift-click)
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
  const persistCollapsed = (next: Set<string>) => {
    localStorage.setItem("trame:explore-collapsed", JSON.stringify([...next]));
    return next;
  };
  const toggleFolder = (full: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(full) ? next.delete(full) : next.add(full);
      return persistCollapsed(next);
    });
  const [htmlFilter, setHtmlFilter] = useState<"smart" | "all">("smart");
  const [kindFilter, setKindFilter] = useState<"both" | "html" | "excalidraw">("both");
  const [kindMenu, setKindMenu] = useState(false);

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
  const toggleStar = (dir: string) => {
    const next = starred.includes(dir) ? starred.filter((d) => d !== dir) : [...starred, dir];
    setStarred(next);
    patchSettings({ starredPaths: next });
  };
  const ignoreFolder = async (dir: string) => {
    // warn only on first use — afterwards ⊘ applies immediately (undo lives in Settings)
    if (!localStorage.getItem("trame:ignore-warned")) {
      if (!(await appConfirm(`Ignore ${dir}?\n\nIgnored folders can be restored in Settings.\n(This warning is only shown once.)`, "Ignore"))) {
        return;
      }
      localStorage.setItem("trame:ignore-warned", "1");
    }
    getSettings()
      .then((s) => patchSettings({ ignorePaths: [...(s.ignore ?? []), dir] }))
      .then(() => load(true));
  };

  const selectDb = (r: ReportMeta) => {
    setMulti(new Set());
    setSelKey(`db:${r.id}`);
    getReport(r.id).then((full) =>
      setSelected({ kind: "db", id: r.id, title: full.title, date: full.created_at, html: full.html })
    );
  };
  const selectFile = (f: FileHit, e?: MouseEvent) => {
    if (e?.ctrlKey || e?.metaKey) {
      setMulti((prev) => {
        const next = new Set(prev);
        if (selKey.startsWith("file:")) next.add(selKey.slice(5));
        next.has(f.path) ? next.delete(f.path) : next.add(f.path);
        return next;
      });
      return;
    }
    if (e?.shiftKey && selKey.startsWith("file:")) {
      const list = visibleRef.current.map((v) => v.path);
      const [a, b] = [list.indexOf(selKey.slice(5)), list.indexOf(f.path)].sort((x, y) => x - y);
      if (a >= 0) {
        setMulti(new Set(list.slice(a, b + 1)));
        return;
      }
    }
    setMulti(new Set());
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

  // Pre-open a file requested from elsewhere (e.g. a folder block's "Explore" button).
  useEffect(() => {
    if (!initialPath) return;
    const hit = files.find((f) => f.path === initialPath);
    if (hit) selectFile(hit);
    else {
      setSelKey(`file:${initialPath}`);
      getReportFileContent(initialPath)
        .then((c) => setSelected({ kind: "file", title: initialPath.split("/").pop() ?? initialPath, date: "", html: c.html, path: initialPath }))
        .catch(() => {});
    }
    onConsumed?.();
  }, [initialPath, files]);

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

  const allFolders = useMemo(() => {
    const out: string[] = [];
    const walk = (n: FolderNode) => {
      out.push(n.full);
      n.folders.forEach(walk);
    };
    tree.forEach(walk);
    return out;
  }, [tree]);
  const setAllFolders = (open: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const f of allFolders) open ? next.delete(f) : next.add(f);
      return persistCollapsed(next);
    });

  // search forces every section and folder open
  const pubOpen = !!needle || !collapsed.has(SEC_PUBLISHED);
  const filesOpen = !!needle || !collapsed.has(SEC_FILES);

  // visible files in display order (search forces every folder open)
  const visibleFiles = useMemo(() => {
    const out: FileHit[] = [];
    if (!filesOpen) return out;
    const walk = (n: FolderNode) => {
      if (!needle && collapsed.has(n.full)) return;
      for (const c of n.folders) walk(c);
      out.push(...n.files);
    };
    for (const n of tree) walk(n);
    return out;
  }, [tree, collapsed, needle, filesOpen]);
  const visibleRef = useRef(visibleFiles);
  visibleRef.current = visibleFiles;

  // ↑/↓ moves the selection through the visible list (reports then files, display order)
  const flat = [
    ...(pubOpen ? shownReports : []).map((r) => ({ key: `db:${r.id}`, sel: () => selectDb(r) })),
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

  // delete the selected FILE(s) (button or Suppr key) — trash when available, neighbor selected after
  const deleteCurrent = async () => {
    const paths = multi.size ? [...multi] : selected?.kind === "file" && selected.path ? [selected.path] : [];
    if (!paths.length) return;
    const what = paths.length === 1 ? selected?.title ?? paths[0] : `${paths.length} files`;
    if (!(await appConfirm(`Delete ${what}?\n(moved to the system trash when available)`))) return;
    const list = flatRef.current;
    const idx = list.findIndex((f) => f.key === selKeyRef.current);
    const neighbor = list.slice(idx + 1).find((f) => !paths.includes(f.key.slice(5))) ??
      list.slice(0, idx).reverse().find((f) => !paths.includes(f.key.slice(5))) ?? null;
    Promise.all(paths.map((p) => deleteReportFile(p))).then((rs) => {
      if (!rs.some((r) => r.ok)) return;
      setMulti(new Set());
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

  const sectionLbl = "flex items-center gap-1 px-2 pb-1 pt-3 text-[10px] font-medium tracking-[0.7px] text-ink-muted/70";
  const sectionHeader = (key: string, label: string, open: boolean, count: number, extra?: ReactNode) => (
    <div className={sectionLbl}>
      <button type="button" onClick={() => toggleFolder(key)} className="flex items-center gap-1 hover:text-ink-soft">
        <span className="w-[11px] text-[9px]">{open ? "▾" : "▸"}</span>
        {label}
        {!open && <span className="text-ink-muted/50">{count}</span>}
      </button>
      <span className="flex-1" />
      {open && extra}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[330px] shrink-0 flex-col overflow-y-auto border-r border-line p-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mb-2 flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-[11.5px] text-ink-muted transition-colors hover:bg-panel hover:text-ink-soft"
          >
            ← Retour à la page
          </button>
        )}
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
            className={`flex h-[30px] items-center rounded-md border px-2 text-[10.5px] disabled:opacity-40 ${
              htmlFilter === "smart"
                ? "border-copper/50 text-copper"
                : "border-chipline text-ink-muted hover:text-ink-soft"
            }`}
          >
            {htmlFilter}
          </button>
          <div className="relative">
            <button type="button"
              onClick={() => setKindMenu((o) => !o)}
              title="Filter by file type"
              className={`flex h-[30px] items-center gap-1 rounded-md border px-2 text-[10.5px] ${
                kindFilter === "both"
                  ? "border-chipline text-ink-muted hover:text-ink-soft"
                  : "border-copper/50 text-copper"
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <path d="M8 2 14 5 8 8 2 5 8 2Z" />
                <path d="M2 8 8 11 14 8" />
              </svg>
              {kindFilter === "both" ? "All" : kindFilter === "html" ? "HTML" : "Excal"}
              <span className="text-[8px]">▾</span>
            </button>
            {kindMenu && (
              <Popover onClose={() => setKindMenu(false)} className="w-36">
                <div className="px-2 pb-1 pt-1 text-[9.5px] font-medium tracking-[0.8px] text-ink-muted/70">
                  FILE TYPE
                </div>
                {([["both", "All types"], ["html", "HTML"], ["excalidraw", "Excalidraw"]] as const).map(([v, label]) => (
                  <button
                    type="button"
                    key={v}
                    onClick={() => {
                      setKindFilter(v);
                      setKindMenu(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-panel ${
                      kindFilter === v ? "text-ink" : "text-ink-soft"
                    }`}
                  >
                    <span className="flex-1">{label}</span>
                    {kindFilter === v && <span className="text-[11px] text-copper">✓</span>}
                  </button>
                ))}
              </Popover>
            )}
          </div>
          <button type="button"
            onClick={() => load(true)}
            disabled={refreshing}
            title="Rescan folders"
            className="flex h-[30px] items-center rounded-md border border-chipline px-2 text-[13px] text-ink-muted hover:text-ink-soft disabled:opacity-40"
          >
            <span className={refreshing ? "inline-block animate-spin" : ""}>↻</span>
          </button>
        </div>
        {shownReports.length > 0 && sectionHeader(SEC_PUBLISHED, "PUBLISHED", pubOpen, shownReports.length)}
        {pubOpen && shownReports.map((r) => {
          const client = board.projects.find((c) => c.id === r.client_id);
          const active = selKey === `db:${r.id}`;
          return (
            <button type="button"
              key={r.id}
              data-key={`db:${r.id}`}
              onClick={() => selectDb(r)}
              className={`flex flex-col items-start gap-1 rounded-lg px-2.5 py-2 text-left ${
                active ? "bg-active-row" : "hover:bg-hover"
              }`}
            >
              <span className={`text-[12.5px] font-medium leading-snug ${active ? "" : "text-ink-soft"}`}>
                {r.title}
              </span>
              <span className="flex items-center gap-1.5">
                {client && <ClientChip name={client.name} color={client.color} />}
                <span className="text-[10.5px] text-ink-muted">{timeAgo(r.created_at)}</span>
              </span>
            </button>
          );
        })}
        {tree.length > 0 && sectionHeader(
          SEC_FILES,
          "FILES",
          filesOpen,
          shownFiles.length,
          <>
            <button type="button" onClick={() => setAllFolders(false)} className="tracking-normal hover:text-ink-soft" title="collapse all folders">
              collapse all
            </button>
            <span className="text-ink-muted/40">·</span>
            <button type="button" onClick={() => setAllFolders(true)} className="tracking-normal hover:text-ink-soft" title="open all folders">
              open all
            </button>
          </>,
        )}
        {filesOpen && (
          <div className="pl-2">
            {tree.map((n) => (
              <FolderRow
                key={n.full}
                node={n}
                depth={0}
                collapsed={collapsed}
                forceOpen={!!needle}
                starred={starred}
                selKey={selKey}
                multi={multi}
                onToggle={toggleFolder}
                onStar={toggleStar}
                onIgnore={ignoreFolder}
                onSelect={selectFile}
              />
            ))}
          </div>
        )}
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
                <span className="text-[12.5px] font-medium text-ink">{selected.title}</span>
                {selected.path && (
                  <span className="max-w-[380px] truncate text-[10.5px] text-ink-muted" title={selected.path}>
                    {selected.path.replace(HOME_RE, "~/")}
                  </span>
                )}
                {selected.date && <span className="text-[11px] text-ink-muted">{timeAgo(selected.date)}</span>}
                <span className="flex-1" />
                {(selected.kind === "file" || multi.size > 0) && (
                  <button type="button"
                    className="text-[11.5px] text-ink-muted hover:text-blocked"
                    title="delete file(s) (Suppr) — system trash when available; ctrl/shift-click to select several"
                    onClick={deleteCurrent}
                  >
                    🗑 Delete{multi.size > 1 ? ` ${multi.size}` : ""}
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
  { node, depth, collapsed, forceOpen, starred, selKey, multi, onToggle, onStar, onIgnore, onSelect }: {
    node: FolderNode;
    depth: number;
    collapsed: Set<string>;
    forceOpen: boolean;
    starred: string[];
    selKey: string;
    multi: Set<string>;
    onToggle: (full: string) => void;
    onStar: (full: string) => void;
    onIgnore: (full: string) => void;
    onSelect: (f: FileHit, e: MouseEvent) => void;
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
          multi={multi}
          onToggle={onToggle}
          onStar={onStar}
          onIgnore={onIgnore}
          onSelect={onSelect}
        />
      ))}
      {open && node.files.map((f) => {
        const active = selKey === `file:${f.path}` || multi.has(f.path);
        return (
          <button type="button"
            key={f.path}
            data-key={`file:${f.path}`}
            onClick={(e) => onSelect(f, e)}
            className={`flex items-center gap-2 rounded-lg py-1.5 pr-2.5 text-left ${
              active ? "bg-active-row" : "hover:bg-hover"
            }`}
            style={{ paddingLeft: 16 + depth * 12 }}
          >
            <span
              className={`min-w-0 flex-1 truncate text-[12.5px] font-medium leading-snug ${
                active ? "" : "text-ink-soft"
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

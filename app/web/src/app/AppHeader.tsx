import { useState } from "react";
import { appConfirm, EntityIcon, ExpandIcon } from "../ui/ui";
import { createUdbRow, deleteUdb, type PageMeta, type Session, type UdbMeta, updateUdb } from "../api";
import { confirmDeletePage } from "../page/Page";
import { IconPicker } from "../udb/cells";
import type { View } from "./view";

export function HeaderTitle(
  { view, title, cardSession, cardCrumbs, crumbs, pages, currentPage, currentDb, starred, onToggleStar, onOpenPage, onRefresh }: {
    view: View;
    title: string;
    cardSession: Session | null;
    cardCrumbs: PageMeta[];
    crumbs: PageMeta[];
    pages: PageMeta[];
    currentPage: PageMeta | null;
    currentDb: UdbMeta | null;
    starred: Set<string>;
    onToggleStar: (id: string) => void;
    onOpenPage: (id: string) => void;
    onRefresh: () => void;
  },
) {
  const [dbIconOpen, setDbIconOpen] = useState(false);
  return (
    <>
    {view === "card" && cardSession
      ? (
        <div className="flex min-w-0 items-center gap-1 text-[13px] text-ink-muted">
          {cardCrumbs.map((c) => (
            <span key={c.id} className="flex items-center gap-1">
              <button
                type="button"
                className="flex max-w-[160px] items-center gap-1 hover:text-ink-soft"
                onClick={() => onOpenPage(c.id)}
              >
                <EntityIcon icon={c.icon} className="shrink-0 text-[11px]" size={14} />
                <span className="truncate">{c.title || "Untitled"}</span>
              </button>
              <span className="text-ink-muted/50">/</span>
            </span>
          ))}
          <span className="flex min-w-0 items-center gap-1 font-medium text-ink">
            <EntityIcon
              icon={pages.find((x) => x.id === cardSession.specs_page_id)?.icon}
              fallback="▦"
              className="shrink-0 text-[11px]"
              size={14}
            />
            <span className="truncate">{cardSession.title}</span>
          </span>
        </div>
      )
      : view === "page" && currentPage
      ? (
        <div className="flex min-w-0 items-center gap-1 text-[13px] text-ink-muted">
          {crumbs.map((c) => (
            <span key={c.id} className="flex items-center gap-1">
              <button
                type="button"
                className="flex max-w-[160px] items-center gap-1 hover:text-ink-soft"
                onClick={() =>
                  onOpenPage(c.id)}
              >
                <EntityIcon icon={c.icon} className="shrink-0 text-[11px]" size={14} />
                <span className="truncate">{c.title || "Untitled"}</span>
              </button>
              <span className="text-ink-muted/50">/</span>
            </span>
          ))}
          <span className="flex min-w-0 items-center gap-1 font-medium text-ink">
            <EntityIcon icon={currentPage.icon} className="shrink-0 text-[11px]" size={14} />
            <span className="truncate">{currentPage.title || "Untitled"}</span>
          </span>
          <button
            type="button"
            className={`ml-1 shrink-0 text-[13px] hover:text-copper ${
              starred.has(currentPage.id) ? "text-copper" : "text-ink-muted/40"
            }`}
            title={starred.has(currentPage.id) ? "unstar" : "star — pin this page in the sidebar"}
            onClick={() => onToggleStar(currentPage.id)}
          >
            ★
          </button>
        </div>
      )
      : view === "database" && currentDb
      ? (
        <div className="flex items-center gap-1">
          <div className="relative">
            <button
              type="button"
              className="rounded-md p-1 text-[15px] leading-none transition-colors hover:bg-panel"
              title="database icon"
              onClick={() => setDbIconOpen(true)}
            >
              <EntityIcon
                icon={currentDb.icon}
                fallback="⌗"
                className={currentDb.icon ? "" : "text-ink-muted"}
              />
            </button>
            {dbIconOpen && (
              <IconPicker
                current={currentDb.icon}
                onPick={(icon) =>
                  updateUdb(currentDb.id, { icon }).then(onRefresh)}
                onClose={() => setDbIconOpen(false)}
              />
            )}
          </div>
          <input
            key={currentDb.id}
            className="rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[15px] font-semibold text-ink outline-none transition-colors hover:bg-panel/60 focus:border-chipline focus:bg-panel"
            defaultValue={currentDb.name}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== currentDb.name) {
                updateUdb(currentDb.id, {
                  name: v,
                }).then(onRefresh);
              }
            }}
            onKeyDown={(e) =>
              e.key === "Enter" &&
              (e.target as HTMLInputElement).blur()}
          />
        </div>
      )
      : <h1 className="text-[15px] font-semibold">{title}</h1>}
    </>
  );
}

export function PageActions(
  { view, currentPage, setZen, setSharePageId, sharePage, shareFlash, openPage, setView, setPageId, refresh }: {
    view: View;
    currentPage: PageMeta | null;
    setZen: (v: boolean) => void;
    setSharePageId: (id: string) => void;
    sharePage: (id: string) => void;
    shareFlash: string | null;
    openPage: (id: string) => void;
    setView: (v: View) => void;
    setPageId: (id: string | null) => void;
    refresh: () => void;
  },
) {
  return (
    <>
    {view === "page" && currentPage && (
      <button
        type="button"
        onClick={() => setZen(true)}
        title="Full screen — hide the sidebar and this bar"
        className="flex shrink-0 items-center rounded-md border border-line px-2 py-[5px] text-ink-muted hover:text-ink-soft"
      >
        <ExpandIcon open={false} />
      </button>
    )}
    {view === "page" && currentPage && (
      <button
        type="button"
        onClick={() => setSharePageId(currentPage.id)}
        title="Share this page's subtree with a guest user (live sync, viewer or editor)"
        className="shrink-0 whitespace-nowrap rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
      >
        Share
      </button>
    )}
    {view === "page" && currentPage && (
      <button
        type="button"
        onClick={() => sharePage(currentPage.id)}
        title="Export this page — with its sub-pages and databases — to a file another Trame user can import"
        className="shrink-0 whitespace-nowrap rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
      >
        {shareFlash ?? "Export"}
      </button>
    )}
    {view === "page" && currentPage && (
      <button
        type="button"
        onClick={() =>
          confirmDeletePage(currentPage).then((ok) => {
            if (!ok) return;
            // a sub-page lands on its parent; a root page on the board
            if (currentPage.parent_id) openPage(currentPage.parent_id);
            else {
              setView("board");
              setPageId(null);
            }
            refresh();
          })}
        className="rounded-md border border-blocked/40 px-2.5 py-1 text-[11.5px] text-blocked/80 hover:bg-blocked/15 hover:text-blocked"
      >
        Delete
      </button>
    )}
    </>
  );
}

// the db delete + the primary "New row" / "New session" button
export function DbActions(
  { view, currentDb, dbId, dbReadOnly, isSessions, setView, setDbId, refresh, setUdbEpoch, setModal }: {
    view: View;
    currentDb: UdbMeta | null;
    dbId: string | null;
    dbReadOnly: boolean;
    isSessions: boolean;
    setView: (v: View) => void;
    setDbId: (id: string | null) => void;
    refresh: () => void;
    setUdbEpoch: (f: (e: number) => number) => void;
    setModal: (m: "session") => void;
  },
) {
  return (
    <>
    {view === "database" && currentDb && (
      <button
        type="button"
        onClick={async () => {
          if (
            await appConfirm(
              `Delete database "${currentDb.name}" and all its rows?`,
            )
          ) {
            deleteUdb(currentDb.id).then(() => {
              setView("board");
              setDbId(null);
              refresh();
            });
          }
        }}
        className="rounded-md border border-blocked/40 px-2.5 py-1 text-[11.5px] text-blocked/80 hover:bg-blocked/15 hover:text-blocked"
      >
        Delete
      </button>
    )}
    {view === "database" && !dbReadOnly
      ? (
        <button
          type="button"
          onClick={() =>
            dbId &&
            createUdbRow(dbId).then(() => setUdbEpoch((e) => e + 1))}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-copper px-3 py-1.5 text-[12.5px] font-medium text-copper-ink hover:brightness-110"
        >
          <span>＋</span> New row
        </button>
      )
      : isSessions && (
        <button
          type="button"
          onClick={() => setModal("session")}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-copper px-3 py-1.5 text-[12.5px] font-medium text-copper-ink hover:brightness-110"
        >
          <span>＋</span> New session
        </button>
      )}
    </>
  );
}

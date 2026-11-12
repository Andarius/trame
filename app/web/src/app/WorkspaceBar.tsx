import { useState } from "react";
import type { Session } from "../api";
import { useAgents } from "../agents/agents";
import { MenuRow, Popover } from "../ui/ui";
import { RailTip } from "./Rail";
import { closeWorkspaces, HOME, move, rename, setWorkspaces, switchWorkspace, useWorkspaces, type Workspace } from "./workspaces";

// two letters for a square: the name's or the card title's first two words
const initials = (s: string) => {
  const words = s.replace(/^[^—]*—\s*/, "").match(/[\p{L}\p{N}]+/gu) ?? [];
  const [a = "?", b] = words;
  return (b ? a[0] + b[0] : a.slice(0, 2)).toUpperCase();
};

export const workspaceName = (w: Workspace, cards: readonly Session[] | undefined) =>
  w.id === HOME ? "Home" : w.name ?? cards?.find((c) => c.id === w.id)?.title ?? "Card";

// The rail's top: ⌂ Home, then one square per card workspace (Ctrl+1…9), its agent's state as a dot
export function WorkspaceBar({ cards }: { cards: readonly Session[] | undefined }) {
  const ws = useWorkspaces();
  const { live } = useAgents();
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const stateOf = (id: string) => {
    const mine = live.filter((l) => l.a.session_id === id);
    return mine.some((l) => l.state === "waiting") ? "var(--color-wait)" : mine.length ? "var(--color-live)" : null;
  };
  return (
    <div className="flex flex-col items-center gap-1">
      {ws.list.map((w, i) => {
        const name = workspaceName(w, cards);
        const dot = w.id === HOME ? null : stateOf(w.id);
        const active = w.id === ws.active;
        return (
          <div key={w.id} className="relative">
            <button
              type="button"
              aria-label={name}
              aria-current={active ? "true" : undefined}
              onClick={() => switchWorkspace(w.id)}
              onContextMenu={(e) => {
                if (w.id === HOME) return;
                e.preventDefault();
                setMenu(w.id);
              }}
              className={`group/rail relative grid h-8 w-8 place-items-center rounded-md text-[11px] font-semibold ${
                active ? "bg-active-row text-ink outline outline-1 outline-copper" : "text-ink-muted hover:bg-hover hover:text-ink"
              }`}
            >
              {w.id === HOME ? <span className="text-[15px]">⌂</span> : initials(name)}
              {dot && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-panel" style={{ background: dot }} />}
              <RailTip label={name} hint={i < 9 ? `Ctrl+${i + 1}` : undefined} />
            </button>
            {menu === w.id && (
              <Popover portal onClose={() => setMenu(null)} className="w-44">
                {renaming === w.id
                  ? (
                    <input
                      autoFocus
                      defaultValue={w.name ?? ""}
                      placeholder={cards?.find((c) => c.id === w.id)?.title ?? "name"}
                      className="w-full rounded border border-line bg-transparent px-2 py-1 text-xs text-ink outline-none focus:border-copper/60"
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        setWorkspaces((s) => rename(s, w.id, e.currentTarget.value));
                        setRenaming(null);
                        setMenu(null);
                      }}
                    />
                  )
                  : (
                    <>
                      <MenuRow onClick={() => setRenaming(w.id)}>Rename…</MenuRow>
                      <MenuRow disabled={i < 2} onClick={() => setWorkspaces((s) => move(s, w.id, -1))}>Move up</MenuRow>
                      <MenuRow disabled={i === ws.list.length - 1} onClick={() => setWorkspaces((s) => move(s, w.id, 1))}>Move down</MenuRow>
                      <MenuRow
                        onClick={() => {
                          setMenu(null);
                          closeWorkspaces([w.id]);
                        }}
                      >
                        Close
                      </MenuRow>
                    </>
                  )}
              </Popover>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Minimal per-page sharing modal (phase 7): grant a guest viewer/editor access to
// this page's subtree, change the role, revoke. Grants are normal synced rows; the
// hub API enforces them — this UI only edits data.
import { useEffect, useState } from "react";
import {
  listShares,
  listUsers,
  type PageShare,
  revokeShare,
  setShare,
  type UserInfo,
} from "./api";

export function ShareModal(
  { pageId, onClose }: { pageId: string; onClose: () => void },
) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [shares, setShares] = useState<PageShare[]>([]);
  const [picked, setPicked] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("editor");

  const reload = () => listShares(pageId).then(setShares);
  useEffect(() => {
    listUsers().then(setUsers);
    reload();
  }, [pageId]);

  const guests = users.filter((u) =>
    u.role === "guest" && !shares.some((s) => s.user_id === u.id)
  );

  const add = () => {
    if (!picked) return;
    setShare({ page_id: pageId, user_id: picked, role }).then(() => {
      setPicked("");
      reload();
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[16vh]"
      onClick={onClose}
    >
      <div
        className="w-[400px] rounded-xl border border-line bg-panel p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[13px] font-semibold text-ink">
          Share this page
        </div>
        <div className="mb-3 text-[11.5px] text-ink-muted">
          Grants cover the page, its sub-pages and attached databases. Viewers
          read; editors can also write and comment.
        </div>

        {shares.length > 0 && (
          <div className="mb-3 space-y-1.5">
            {shares.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-[12.5px]">
                <span className="flex-1 truncate text-ink-soft">{s.name}</span>
                <select
                  value={s.role}
                  onChange={(e) =>
                    setShare({
                      page_id: pageId,
                      user_id: s.user_id,
                      role: e.target.value as "viewer" | "editor",
                    }).then(reload)}
                  className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-[11.5px] text-ink-soft"
                >
                  <option value="editor">editor</option>
                  <option value="viewer">viewer</option>
                </select>
                <button
                  type="button"
                  title="Revoke — their copy is purged on their next sync"
                  onClick={() =>
                    revokeShare(s.id).then(reload)}
                  className="rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-ink-muted hover:text-blocked"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {guests.length > 0
          ? (
            <div className="flex items-center gap-2">
              <select
                value={picked}
                onChange={(e) => setPicked(e.target.value)}
                className="flex-1 rounded-md border border-line bg-panel px-1.5 py-1 text-[12px] text-ink-soft"
              >
                <option value="">Add a guest…</option>
                {guests.map((u) => (
                  <option key={u.id} value={u.id}>{u.name || u.id}</option>
                ))}
              </select>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
                className="rounded-md border border-line bg-panel px-1.5 py-1 text-[11.5px] text-ink-soft"
              >
                <option value="editor">editor</option>
                <option value="viewer">viewer</option>
              </select>
              <button
                type="button"
                onClick={add}
                disabled={!picked}
                className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-muted hover:text-ink-soft disabled:opacity-50"
              >
                Share
              </button>
            </div>
          )
          : shares.length === 0 && (
            <div className="text-[11.5px] text-ink-muted">
              No guests yet — invite one on the hub:
              <code className="mt-1 block rounded bg-black/20 px-1.5 py-1 text-[10.5px]">
                docker exec tracker-api deno run -A --config
                /srv/hub/api/deno.json /srv/hub/api/main.ts invite "Name"
                their-node-id
              </code>
            </div>
          )}

        <div className="mt-4 text-right">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-muted hover:text-ink-soft"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

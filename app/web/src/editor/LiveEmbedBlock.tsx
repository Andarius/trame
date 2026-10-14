import { useEffect, useState } from "react";
import { type Block, getSettings, openInBrowser } from "../api";
import { IconButton, LIVE_PILL } from "../ui/ui";
import { allowedEmbedHost, EMBED_DEFAULT_HEIGHT } from "./embed";

type EmbedB = Extract<Block, { type: "embed" }>;

export function LiveEmbedBlock(
  { block, onPatch, onRemove }: {
    block: EmbedB;
    onPatch: (patch: Partial<EmbedB>) => void;
    onRemove: () => void;
  },
) {
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [editing, setEditing] = useState(!block.url);
  const [draft, setDraft] = useState(block.url);

  useEffect(() => {
    let live = true;
    getSettings().then((s) => live && setHosts(s.embedHosts ?? [])).catch(() => live && setHosts([]));
    return () => {
      live = false;
    };
  }, []);

  const host = hosts && block.url ? allowedEmbedHost(block.url, hosts) : null;
  const commit = () => {
    const v = draft.trim();
    setEditing(false);
    if (v !== block.url) onPatch({ url: v });
  };

  let body = null;
  if (!block.url) body = "Paste an https URL above.";
  else if (hosts && !host) {
    let hostname = "";
    try {
      hostname = new URL(block.url).hostname;
    } catch { /* shown as invalid below */ }
    body = hostname && block.url.startsWith("https://")
      ? `⚠ ${hostname} is not an allowed embed host — add it under Settings › Embeds.`
      : "⚠ Only https URLs can be embedded.";
  }

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-line bg-block">
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
        <span className="text-sm">🔗</span>
        {editing
          ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setDraft(block.url);
                  setEditing(false);
                }
              }}
              placeholder="https://grafana.example.com/d/…"
              className="min-w-0 flex-1 border-none bg-transparent font-mono text-[11.5px] text-ink-soft outline-none placeholder:text-ink-muted/40"
            />
          )
          : (
            <button
              type="button"
              onClick={() => {
                setDraft(block.url);
                setEditing(true);
              }}
              className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-ink-soft hover:text-ink"
              title={block.url}
            >
              {host ?? block.url}
            </button>
          )}
        {host && <span className={LIVE_PILL}>live</span>}
        {host && (
          <button
            type="button"
            onClick={() => openInBrowser(block.url)}
            className="shrink-0 rounded-md border border-chipline bg-panel px-2 py-[2px] text-[11px] font-medium text-ink-soft hover:border-copper hover:text-copper"
          >
            open in browser
          </button>
        )}
        <IconButton
          onClick={onRemove}
          title="remove block"
          className="shrink-0 rounded px-1 text-ink-muted/60 hover:bg-panel hover:text-blocked"
        >
          ×
        </IconButton>
      </div>
      {body && <div className="px-3 py-3 text-[11.5px] text-ink-muted">{body}</div>}
      {host && (
        // no sandbox: apps like Grafana need scripts, same-origin and cookies; the host allowlist is the gate
        <iframe
          src={block.url}
          title={`Embed ${host}`}
          referrerPolicy="no-referrer"
          loading="lazy"
          className="block w-full border-0 bg-white"
          style={{ height: block.height ?? EMBED_DEFAULT_HEIGHT }}
        />
      )}
    </div>
  );
}

import { useState } from "react";
import type { BoardData } from "../api";
import { Modal, SECTION_LABEL, StatusDot, timeAgo } from "../ui/ui";
import { linkTermCard } from "./term-api";

// Link to card: pick the card a running shell works for, or unlink it
export function LinkCardDialog(
  { board, term, card, onClose, onLinked }: {
    board: BoardData | null;
    term: string;
    card: string | null; // its card now
    onClose: () => void;
    onLinked: (card: string | null) => void;
  },
) {
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needle = q.trim().toLowerCase();
  const cards = (board?.sessions ?? [])
    .filter((s) => !needle || s.title.toLowerCase().includes(needle))
    .sort((a, b) => b.last_touched.localeCompare(a.last_touched))
    .slice(0, 30);
  const link = async (to: string | null) => {
    try {
      await linkTermCard(term, to);
      onLinked(to);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const choice = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink-soft outline-none hover:bg-active-row hover:text-ink focus-visible:bg-active-row focus-visible:text-ink";
  return (
    <Modal label="Link to card" width={480} onClose={onClose}>
      <div className="flex flex-col gap-3 p-1">
        <h2 className="text-[15px] font-semibold">Link to card</h2>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && cards[0] && void link(cards[0].id)}
          placeholder="Search cards"
          className="rounded-md border border-line bg-transparent px-2 py-1.5 text-[13px] outline-none focus:border-copper/60"
        />
        <div className={`px-2 ${SECTION_LABEL}`}>{needle ? "MATCHING, LATEST MODIFIED FIRST" : "LATEST MODIFIED"}</div>
        <div className="-mt-2 flex max-h-[50vh] flex-col overflow-y-auto">
          {cards.map((s) => (
            <button key={s.id} type="button" className={choice} onClick={() => void link(s.id)}>
              <StatusDot status={s.status} size={7} />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              {s.id === card && <span className="text-[11px] text-copper">linked</span>}
              <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">{timeAgo(s.last_touched)}</span>
            </button>
          ))}
          {cards.length === 0 && <p className="px-2 py-1.5 text-[12px] text-ink-muted">No card matches.</p>}
        </div>
        {card && (
          <button type="button" className={`${choice} text-ink-muted`} onClick={() => void link(null)}>
            Unlink from its card
          </button>
        )}
        {error && <p className="text-[12px] text-wait">{error}</p>}
      </div>
    </Modal>
  );
}

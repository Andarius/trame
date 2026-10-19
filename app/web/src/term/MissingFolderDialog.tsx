import { useEffect, useState } from "react";
import { getStatus } from "../api";
import { Modal } from "../ui/ui";
import { cloneUrl } from "./clone-url";
import { openTerminal, pickFolder } from "./term-api";

export type MissingFolder = {
  asked: string; // the card's folder, as recorded
  repo: string; // the repo it belongs to (a worktree's parent)
  suggested: string; // where that repo would live on this machine
  command: string; // what the card wanted to run
  title: string;
  prUrl: string | null;
  origin: string | null; // the machine that last tracked the card
  card: string; // the card the shell is for
};

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// The card's folder isn't on this machine: say why, and offer the ways forward.
export function MissingFolderDialog(
  { m, onClose, onOpened }: { m: MissingFolder; onClose: () => void; onOpened?: () => void },
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clone = cloneUrl(m.prUrl);
  // named only when it's another machine: a card edited here last says nothing
  const [elsewhere, setElsewhere] = useState<string | null>(null);
  useEffect(() => {
    if (m.origin) void getStatus().then((s) => setElsewhere(s.nodeId !== m.origin ? m.origin : null), () => {});
  }, [m.origin]);
  const parent = m.suggested.replace(/\/[^/]+$/, "");

  const run = async (step: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await step();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };
  const choose = () =>
    run(async () => {
      const picked = await pickFolder(m.repo);
      if ("cancelled" in picked) throw new Error("no folder chosen");
      if ("error" in picked) throw new Error(picked.error);
      await openTerminal({ cwd: m.asked, command: m.command, title: m.title, card: m.card });
      onOpened?.();
    });

  const option = "flex w-full flex-col items-start rounded-lg border border-line px-3 py-2 text-left hover:border-chipline hover:bg-panel disabled:opacity-50";
  return (
    <Modal label="Card folder not found" width={520} onClose={onClose}>
      <div className="text-sm font-semibold text-ink">This card's folder isn't on this machine</div>
      <div className="text-xs leading-relaxed text-ink-soft">
        <code className="break-all rounded bg-well px-1 py-0.5 text-[11px]">{m.asked}</code>
        <div className="pt-1.5">
          {elsewhere
            ? <>This card was last tracked on <span className="font-semibold text-ink">{elsewhere}</span>; its folder lives there.</>
            : "It was probably created on another machine, or its worktree was deleted."} Pick where to run it here:
        </div>
      </div>
      <button type="button" disabled={busy} className={option} onClick={choose}>
        <span className="text-xs text-ink">Choose folder…</span>
        <span className="text-[11px] text-ink-muted">
          Point Trame at your checkout of this repo. It remembers the choice for every card of {m.repo.split("/").pop()}.
        </span>
      </button>
      {clone && (
        <button
          type="button"
          disabled={busy}
          className={option}
          onClick={() =>
            run(async () => {
              await openTerminal({
                cwd: null,
                command: `mkdir -p ${shq(parent)} && git clone ${shq(clone.url)} ${shq(m.suggested)} && cd ${shq(m.suggested)} && ${m.command}`,
                title: m.title,
                card: m.card,
              });
              onOpened?.();
            })}
        >
          <span className="text-xs text-ink">Clone {clone.name}, then open</span>
          <span className="break-all text-[11px] text-ink-muted">
            Runs <code>git clone</code> into {m.suggested} in a new terminal you can watch, then starts the agent there.
          </span>
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        className={option}
        onClick={() => run(() => openTerminal({ cwd: null, command: m.command, title: m.title }))}
      >
        <span className="text-xs text-ink">Open in home folder</span>
        <span className="text-[11px] text-ink-muted">Starts the agent in your home folder instead.</span>
      </button>
      {error && <div className="text-[11px] text-blocked">{error}</div>}
      <div className="flex justify-end">
        <button type="button" className="text-xs text-ink-muted hover:text-ink" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

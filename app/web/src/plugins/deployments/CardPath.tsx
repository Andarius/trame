// Card view row: where this card's PR stands on its way to prod (PR → backport → release → env).
import { useEffect, useState } from "react";
import { openInBrowser, type Session } from "../../api";
import { FieldRow, timeAgo } from "../../ui/ui";
import type { DeploymentsState, PendingDeployment } from "./Panel";

function Step({ label, state, onClick, title }: {
  label: string;
  state: "done" | "here" | "next";
  onClick?: () => void;
  title?: string;
}) {
  const cls = state === "done"
    ? "border-active/60 text-active"
    : state === "here"
    ? "border-copper text-copper"
    : "border-chipline text-ink-muted";
  return (
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick}
      title={title}
      className={`whitespace-nowrap rounded-full border px-2 py-px text-[11px] ${cls} ${onClick ? "hover:brightness-125" : "cursor-default"}`}
    >
      {label}
    </button>
  );
}

const Link = () => <span className="h-px w-3.5 shrink-0 bg-chipline" />;

export function DeploymentsCardPath({ session }: { session: Session }) {
  const [items, setItems] = useState<PendingDeployment[]>([]);
  useEffect(() => {
    // 403 while the plugin is disabled → no row
    fetch("/api/plugins/deployments/state")
      .then((r) => r.ok ? r.json() as Promise<DeploymentsState> : null)
      .then((s) => setItems(s?.items.filter((i) => i.ships?.some((c) => c.card_id === session.id)) ?? []))
      .catch(() => setItems([]));
  }, [session.id]);
  if (!items.length) return null;
  return (
    <div className="col-span-full">
      <FieldRow label="Path to prod">
        <div className="flex flex-col gap-1.5">
          {items.map((i) => {
            const ship = i.ships!.find((c) => c.card_id === session.id)!;
            const ref = (n: number) => i.source === "github" ? `PR #${n}` : `MR !${n}`;
            return (
              <div key={i.url + i.environment} className="flex flex-wrap items-center">
                <Step label={ref(ship.pr)} state="done" onClick={() => openInBrowser(ship.prUrl)} title="merged" />
                {ship.via && (
                  <>
                    <Link />
                    <Step
                      label={`backport ${ref(ship.via)}`}
                      state="done"
                      onClick={() => ship.viaUrl && openInBrowser(ship.viaUrl)}
                    />
                  </>
                )}
                <Link />
                <Step
                  label={`${i.title} · waiting`}
                  state="here"
                  onClick={() => openInBrowser(i.url)}
                  title={`waiting since ${timeAgo(i.waitingSince)} — open the approval page`}
                />
                <Link />
                <Step label={i.environment} state="next" />
              </div>
            );
          })}
        </div>
      </FieldRow>
    </div>
  );
}

import type { ReactNode } from "react";
import type { UdbMeta } from "../api";
import { DatabaseView } from "../udb/DatabaseTable";
import { EntityIcon } from "../ui/ui";

// A database shown on a page: placed by a {{trame:db=…}} block, or attached and listed at
// the end. Breakout: it uses the pane's width (100cqw minus the px-8 gutters), not the
// 820px text column.
export function PageDatabase({ dbId, udbs, fallback, handle, className = "" }: {
  dbId: string;
  udbs: UdbMeta[];
  fallback?: { name: string; icon: string | null };
  handle?: ReactNode; // the editor's drag handle, when the database is a page block
  className?: string;
}) {
  const meta = udbs.find((d) => d.id === dbId) ?? fallback;
  return (
    <div className={`relative left-1/2 flex w-[min(1400px,100cqw_-_4rem)] -translate-x-1/2 flex-col gap-1 ${className}`}>
      <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
        {handle && <span className="relative -ml-6 h-5 w-[22px] shrink-0">{handle}</span>}
        <EntityIcon icon={meta?.icon ?? null} fallback="⌗" className="text-ink-muted" />
        {meta?.name ?? "Database"}
      </div>
      <DatabaseView dbId={dbId} epoch={0} udbs={udbs} />
    </div>
  );
}

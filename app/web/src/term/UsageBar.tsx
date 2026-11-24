import { useEffect, useState } from "react";
import { AgentIcon } from "../agents/agents";
import { termUsage, type UsageBar as Usage } from "./term-api";

const USAGE_POLL_MS = 60_000;

// a window's reset, as the day and hour it lands on
const resets = (at: number | null) =>
  at ? new Date(at * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";
const tone = (used: number) => (used >= 95 ? "text-blocked" : used >= 80 ? "text-wait" : "text-ink-muted");

// the Terminals column's footer: each tool's most-used plan window, this host and the others syncing with it
export function UsageBar() {
  const [bar, setBar] = useState<Usage | null>(null);
  useEffect(() => {
    const load = () => !document.hidden && termUsage().then(setBar).catch(() => {});
    load();
    const t = setInterval(load, USAGE_POLL_MS);
    return () => clearInterval(t);
  }, []);
  if (!bar) return null;
  const tools = [...new Set(bar.usage.map((u) => u.tool))];
  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-line px-5 py-2 text-[11.5px] text-ink-muted">
      {tools.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {tools.map((tool) => {
            const rows = bar.usage.filter((u) => u.tool === tool);
            const top = rows.reduce((a, b) => (b.used > a.used ? b : a));
            return (
              <span
                key={tool}
                className="inline-flex items-center gap-1.5"
                title={[tool, ...rows.map((u) => `${u.name ?? "usage"} ${Math.round(u.used)}%${u.resets_at ? `, resets ${resets(u.resets_at)}` : ""}`)].join("\n")}
              >
                <AgentIcon a={{ harness: tool, icon: null }} />
                <span className={`tabular-nums ${tone(top.used)}`}>{Math.round(top.used)}%</span>
              </span>
            );
          })}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-1.5" title={bar.hosts.length ? `also syncing: ${bar.hosts.join(", ")}` : "this machine"}>
        <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <rect x="2" y="3" width="12" height="8" rx="1.2" />
          <path d="M5.5 13.5h5M8 11v2.5" />
        </svg>
        <span className="min-w-0 truncate">{bar.host}</span>
        {bar.hosts.length > 0 && <span className="shrink-0 text-ink-faint">· {bar.hosts.length + 1} hosts</span>}
      </div>
    </div>
  );
}

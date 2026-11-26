import { SECTION_LABEL } from "../ui/ui";
import { useAgentDest } from "./agent-run";
import { useBots } from "./bot-api";
import { BotAvatar, Glyph } from "./bot-faces";
import { folderName } from "./bot-stats";

// The bots in the agents column, above the runs they start; hidden until the agent view is on or a bot exists.
// `selected` is the main pane's bot selection: "bots", "bot:<id>" or "bot:new".
export function Bots({ selected, onSelect }: { selected: string | null; onSelect: (sel: string) => void }) {
  const [claude] = useAgentDest("claude");
  const [codex] = useAgentDest("codex");
  const { bots } = useBots(true);
  if (!bots.length && claude !== "agent" && codex !== "agent" && !selected) return null;
  return (
    <section className="flex flex-col gap-0.5">
      <div className="flex items-center px-2 pb-1">
        <button
          type="button"
          title="all bots: their activity over four weeks"
          className={`${SECTION_LABEL} hover:text-ink-soft ${selected === "bots" ? "text-ink-soft" : ""}`}
          onClick={() => onSelect("bots")}
        >
          BOTS
        </button>
        <button
          type="button"
          title="new bot: an agent that Slack, a hook or you can start in one folder"
          aria-label="new bot"
          className={`ml-auto rounded px-1 text-[12px] leading-none hover:bg-hover hover:text-ink ${
            selected === "bot:new" ? "text-ink" : "text-ink-faint"
          }`}
          onClick={() => onSelect("bot:new")}
        >
          +
        </button>
      </div>
      {bots.map((b) => (
        <button
          key={b.id}
          type="button"
          title={b.cwd}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] ${
            selected === `bot:${b.id}` ? "bg-active-row text-ink" : "text-ink-soft hover:bg-hover hover:text-ink"
          }`}
          onClick={() => onSelect(`bot:${b.id}`)}
        >
          <BotAvatar bot={b} state={b.working > 0 ? "working" : "idle"} ring="border-sidebar" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{b.name}</span>
            <span className="truncate text-[11px] text-ink-faint">{b.role || folderName(b.cwd)}</span>
          </span>
          <span className="ml-auto flex shrink-0 gap-1 text-ink-faint">
            {b.slack && <span title="Slack mentions start it"><Glyph name="slack" /></span>}
            <span title="a hook can start it"><Glyph name="hook" /></span>
          </span>
        </button>
      ))}
    </section>
  );
}

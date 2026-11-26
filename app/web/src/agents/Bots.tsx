import { useState } from "react";
import { pickTermFolder } from "../term/term-api";
import { appConfirm, Button, ErrorNote, Field, Modal, SECTION_LABEL, SegToggle, TextArea, TextInput } from "../ui/ui";
import { CheckRow, Footer } from "../modals/modal-ui";
import { MODES, type Provider, useAgentDest } from "./agent-run";
import { AgentIcon } from "./agents";
import {
  type Bot,
  BOT_NAME,
  botHook,
  botName,
  createBot,
  deleteBot,
  hookCommand,
  rotateBotHook,
  runBot,
  updateBot,
  useBots,
} from "./bot-api";

// The bots in the agents column, above the runs they start; hidden until the agent view is on or a bot exists.
export function Bots({ onOpenRun }: { onOpenRun: (run: string) => void }) {
  const [claude] = useAgentDest("claude");
  const [codex] = useAgentDest("codex");
  const { bots, reload } = useBots(true);
  const [editing, setEditing] = useState<Bot | "new" | null>(null);
  if (!bots.length && claude !== "agent" && codex !== "agent") return null;
  return (
    <section className="flex flex-col gap-0.5">
      <div className={`flex items-center px-2 pb-1 ${SECTION_LABEL}`}>
        BOTS
        <button
          type="button"
          title="new bot: an agent that Slack, a hook or you can start in one folder"
          aria-label="new bot"
          className="ml-auto rounded px-1 text-[12px] leading-none text-ink-faint hover:bg-hover hover:text-ink"
          onClick={() => setEditing("new")}
        >
          +
        </button>
      </div>
      {bots.map((b) => (
        <button
          key={b.id}
          type="button"
          title={b.cwd}
          className="flex w-full items-start gap-1.5 rounded-md px-2 py-1 text-left text-[12.5px] text-ink-muted hover:text-ink-soft"
          onClick={() => setEditing(b)}
        >
          <span className="mt-0.5 shrink-0">
            <AgentIcon a={{ harness: b.provider, icon: null }} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{b.name}</span>
            <span className="truncate text-[11px] text-ink-faint">
              {b.cwd.split("/").pop()}
              {b.slack && " · Slack"}
              {b.live > 0 && ` · ${b.live} running`}
            </span>
          </span>
        </button>
      ))}
      {editing && (
        <BotDialog
          bot={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => (reload(), setEditing(null))}
          onRun={(run) => (reload(), setEditing(null), onOpenRun(run))}
        />
      )}
    </section>
  );
}

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
];

function BotDialog(
  { bot, onClose, onSaved, onRun }: {
    bot: Bot | null;
    onClose: () => void;
    onSaved: () => void;
    onRun: (run: string) => void;
  },
) {
  const [name, setName] = useState(bot?.name ?? "");
  const [cwd, setCwd] = useState(bot?.cwd ?? "");
  const [provider, setProvider] = useState<Provider>(bot?.provider ?? "claude");
  const [mode, setMode] = useState(bot?.mode === "default" ? "manual" : bot?.mode ?? "auto");
  const [slack, setSlack] = useState(bot?.slack ?? false);
  const [task, setTask] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const valid = BOT_NAME.test(name) && cwd.startsWith("/");
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const choose = async () => {
    const picked = await pickTermFolder(cwd || null).catch((e: Error) => ({ error: e.message }));
    if (typeof picked === "string") {
      const folder = picked.replace(/\/+$/, "");
      setCwd(folder);
      if (!name) setName(botName(folder));
    } else if ("error" in picked) setError(picked.error);
  };
  const save = async () => {
    if (!valid) return;
    const body = { name, cwd, provider, mode: provider === "claude" ? mode : null, slack };
    try {
      await (bot ? updateBot(bot.id, body) : createBot(body));
      onSaved();
    } catch (e) {
      fail(e);
    }
  };
  const copyHook = (fresh: boolean) =>
    (fresh ? rotateBotHook(bot!.id) : botHook(bot!.id))
      .then((h) => navigator.clipboard.writeText(hookCommand(h)))
      .then(() => setNotice(fresh ? "new secret: the old hook command stops working. Copied." : "hook command copied"), fail);
  const run = () =>
    task.trim() && bot && runBot(bot.id, task.trim()).then((r) => onRun(r.id), fail);
  const remove = async () => {
    if (bot && await appConfirm(`Delete the bot ${bot.name}? Its runs stay.`)) {
      deleteBot(bot.id).then(onSaved, fail);
    }
  };

  return (
    <Modal width={520} label={bot ? `Bot ${bot.name}` : "New bot"} onClose={onClose} onSubmit={() => void save()}>
      <div className="text-[14px] font-semibold text-ink">{bot ? bot.name : "New bot"}</div>
      <Field label="FOLDER" hint="where its runs work" group>
        <div className="flex gap-1.5">
          <TextInput mono value={cwd} placeholder="/path/to/project" onChange={(e) => setCwd(e.target.value)} />
          <Button onClick={() => void choose()}>Choose…</Button>
        </div>
      </Field>
      <Field label="NAME" hint={<>in Slack: <code>@Trame {name || "name"}: task</code></>}>
        <TextInput mono value={name} placeholder="my-project" onChange={(e) => setName(e.target.value.toLowerCase())} />
      </Field>
      <Field label="AGENT" group>
        <div className="flex flex-wrap gap-1">
          <SegToggle options={PROVIDERS} value={provider} onChange={setProvider} />
        </div>
      </Field>
      {provider === "claude" && (
        <Field label="MODE" hint={MODES.find((m) => m.mode === mode)?.hint} group>
          <div className="flex flex-wrap gap-1">
            <SegToggle<string> options={MODES.map((m) => ({ value: m.mode, label: m.label }))} value={mode} onChange={setMode} />
          </div>
        </Field>
      )}
      <Field label="STARTED BY" group>
        <CheckRow on={slack} label="Slack mentions" onChange={setSlack} />
        {bot && (
          <div className="flex items-center gap-2 text-[13px] text-ink-soft">
            <span className="flex-1">A hook (cron, CI, script)</span>
            <Button size="sm" onClick={() => void copyHook(false)}>Copy hook command</Button>
            <Button size="sm" variant="ghost" title="make a new secret; the old command stops working" onClick={() => void copyHook(true)}>
              New secret
            </Button>
          </div>
        )}
      </Field>
      {bot && (
        <Field label="RUN NOW" group>
          <div className="flex items-end gap-1.5">
            <TextArea rows={2} value={task} placeholder="What should it do?" onChange={(e) => setTask(e.target.value)} />
            <Button disabled={!task.trim()} onClick={() => void run()}>Run</Button>
          </div>
        </Field>
      )}
      {notice && <div className="text-[11.5px] text-ink-muted">{notice}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex items-center">
        {bot && <Button variant="danger" onClick={() => void remove()}>Delete bot</Button>}
      </div>
      <Footer
        hint={bot?.live ? `${bot.live} running` : "each trigger starts a fresh run"}
        action={bot ? "Save" : "Create bot"}
        onClose={onClose}
        onSubmit={() => void save()}
        disabled={!valid}
      />
    </Modal>
  );
}

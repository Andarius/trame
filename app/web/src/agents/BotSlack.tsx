import { type ReactNode, useRef, useState } from "react";
import { openInBrowser } from "../api";
import { appConfirm, Button, ErrorNote, Field, TextInput } from "../ui/ui";
import {
  type Bot,
  botSlack,
  type BotSlack,
  connectBotSlack,
  disconnectBotSlack,
  sharedSlack,
  updateBotSlack,
  usePoll,
} from "./bot-api";
import { BotIconSvg, downloadBotIcon, Glyph } from "./bot-faces";
import { memberIds } from "./bot-stats";

const CHIP = "inline-flex max-w-full items-center gap-1 rounded-full border border-chipline px-2 py-[2px] text-[11px] text-ink-soft";
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

// The Slack trigger's body: the bot's own Slack app (connect it, or who may ask it), and the shared @Trame app.
export function BotSlackSetup({ bot, reload }: { bot: Bot; reload: () => void }) {
  const { data: slack, error, reload: refresh } = usePoll(() => botSlack(bot.id), 15000, bot.id);
  const changed = () => (refresh(), reload());
  if (!slack) return error ? <ErrorNote className="mt-1.5">{error}</ErrorNote> : <span>…</span>;
  return slack.connected
    ? <Connected bot={bot} slack={slack} onChange={changed} />
    : <Connect bot={bot} slack={slack} onChange={changed} />;
}

// how a bot without its own app is reached: the shared app, when this machine holds one
function SharedApp({ bot }: { bot: Bot }) {
  const { data } = usePoll(sharedSlack, 60000, "shared");
  if (!data) return null;
  if (!data.shared) return <div>No shared @Trame app on this machine; give {bot.name} its own:</div>;
  return (
    <div>
      <span className="font-mono">@Trame {bot.name}: …</span> in the channel set for Trame
    </div>
  );
}

function Connected({ bot, slack, onChange }: { bot: Bot; slack: BotSlack; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = slack.botName || bot.name;
  const disconnect = async () => {
    if (!await appConfirm(`Disconnect @${name}? Trame forgets its tokens; the app stays in Slack.`, "Disconnect")) return;
    disconnectBotSlack(bot.id).then(onChange, (e) => setError(message(e)));
  };
  const state = !bot.slack
    ? "paused"
    : !slack.listening && !slack.error
    ? "not listening on this machine (Trame runs offline or isolated)"
    : null;
  return (
    <>
      <div>
        <span className="font-mono text-ink-soft">@{name}</span> in {slack.teamName} · mention it in any channel it's invited to
        {state && <span className="text-ink-muted"> · {state}</span>}
      </div>
      {editing
        ? (
          <WhoMayAsk
            initial={slack}
            action="Save"
            onCancel={() => setEditing(false)}
            onSubmit={(who) =>
              updateBotSlack(bot.id, who).then(() => (setEditing(false), onChange()))}
          />
        )
        : (
          <>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {slack.anyone
                ? (
                  <span className={CHIP}>
                    <Glyph name="people" /> anyone in {slack.teamName}
                  </span>
                )
                : slack.allowed?.map((u) => (
                  <span key={u} className={`${CHIP} font-mono`}>
                    <Glyph name="person" /> {u}
                  </span>
                ))}
            </div>
            <div className="mt-2 flex gap-1.5">
              <Button size="sm" onClick={() => setEditing(true)}>Edit who may ask</Button>
              <Button size="sm" variant="danger" onClick={() => void disconnect()}>Disconnect</Button>
            </div>
          </>
        )}
      {slack.error && <ErrorNote className="mt-1.5">{slack.error}: connect it again with fresh tokens.</ErrorNote>}
      {error && <ErrorNote className="mt-1.5">{error}</ErrorNote>}
    </>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-chart-5/15 text-[10px] font-semibold text-chart-5">
        {n}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function Connect({ bot, slack, onChange }: { bot: Bot; slack: BotSlack; onChange: () => void }) {
  const icon = useRef<SVGSVGElement>(null);
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <SharedApp bot={bot} />
      <div className="mt-2.5 text-[12px] font-semibold text-ink">Connect @{bot.name} to Slack</div>
      <div className="mb-1.5">its own app: mention it in any channel, no name prefix</div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        <Step n={1}>
          <Button size="sm" className="inline-flex items-center gap-1" onClick={() => void openInBrowser(slack.manifestUrl)}>
            <Glyph name="slack" /> Create in Slack
          </Button>
          <span className="ml-1.5">pick the workspace, then Create</span>
          <div className="mt-1 flex items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="inline-flex items-center gap-1"
              onClick={() => downloadBotIcon(bot, icon.current).catch((e) => setError(message(e)))}
            >
              <Glyph name="download" /> Download icon
            </Button>
            <span>upload it in the app's Basic Information → Display Information</span>
            <BotIconSvg bot={bot} svgRef={icon} />
          </div>
        </Step>
        <Step n={2}>
          In <b>Basic Information</b>, generate an <b>App-Level Token</b> with the <code>connections:write</code> scope
        </Step>
        <Step n={3}>
          <b>Install to Workspace</b>, then copy the <b>Bot User OAuth Token</b> from OAuth &amp; Permissions
        </Step>
        <Step n={4}>
          Paste both here
          <div className="mt-1.5 flex flex-col gap-1.5">
            <TextInput
              mono
              type="password"
              autoComplete="off"
              placeholder="xapp-… app-level token"
              aria-label="app-level token"
              value={appToken}
              onChange={(e) => setAppToken(e.target.value)}
            />
            <TextInput
              mono
              type="password"
              autoComplete="off"
              placeholder="xoxb-… bot token"
              aria-label="bot token"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
          </div>
          <WhoMayAsk
            action="Connect"
            onSubmit={(who) => connectBotSlack(bot.id, { appToken, botToken, ...who }).then(onChange)}
          />
        </Step>
      </ol>
      {error && <ErrorNote className="mt-1.5">{error}</ErrorNote>}
    </>
  );
}

// "Who may ask": Slack member IDs or anyone; `onSubmit` rejects with the error to show
function WhoMayAsk(
  { initial, action, onSubmit, onCancel }: {
    initial?: Pick<BotSlack, "allowed" | "anyone">;
    action: string;
    onSubmit: (who: { allowed: string[]; anyone: boolean }) => Promise<unknown>;
    onCancel?: () => void;
  },
) {
  const [members, setMembers] = useState(initial?.allowed?.join(", ") ?? "");
  const [anyone, setAnyone] = useState(initial?.anyone ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    setBusy(true);
    onSubmit({ allowed: memberIds(members), anyone })
      .then(() => setError(null), (e) => setError(message(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <Field label="WHO MAY ASK" hint="Profile → ⋯ → Copy member ID">
        <TextInput
          mono
          placeholder="U0123ABCD, U0456EFGH"
          value={members}
          disabled={anyone}
          onChange={(e) => setMembers(e.target.value)}
        />
      </Field>
      <label className="inline-flex items-center gap-1.5">
        <input type="checkbox" checked={anyone} onChange={(e) => setAnyone(e.target.checked)} />
        <Glyph name="people" /> anyone in the workspace
      </label>
      <div className="flex gap-1.5">
        <Button size="sm" variant="primary" disabled={busy} onClick={submit}>{busy ? `${action}…` : action}</Button>
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

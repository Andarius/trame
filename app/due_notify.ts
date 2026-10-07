import { APP_CTX } from "./ctx.ts";
import { PORT_FILE } from "./config.ts";
import { daysUntil, type DueTodo, isShownDue, listDue } from "../core/due.ts";
import { todayMark } from "../core/todo-marks.ts";

// The morning digest: from 9:00, once a day, one system notification listing the todos
// that are late or due within a week. Changing a todo's date is the snooze.

const NOTIFY_FROM_HOUR = 9;
const CHECK_EVERY_MS = 10 * 60_000;
const SENT_FILE = PORT_FILE.replace(/[^/]+$/, "due-notified");

export function digest(due: DueTodo[], today: string): { title: string; body: string } | null {
  const shown = due.filter((d) => isShownDue(d.due, today));
  if (!shown.length) return null;
  const late = shown.filter((d) => daysUntil(d.due, today) < 0).length;
  const soon = shown.length - late;
  const title = `Trame · ${[late && `${late} late`, soon && `${soon} due this week`].filter(Boolean).join(", ")}`;
  const when = (d: DueTodo) => {
    const n = daysUntil(d.due, today);
    return n < 0 ? `${-n}d late` : n === 0 ? "today" : n === 1 ? "tomorrow" : d.due;
  };
  const body = shown.slice(0, 5).map((d) => `⚑ ${d.text} (${when(d)})`).join("\n") +
    (shown.length > 5 ? `\n+${shown.length - 5} more` : "");
  return { title, body };
}

async function run(argv: string[]): Promise<string> {
  const out = await new Deno.Command(argv[0], { args: argv.slice(1), stdout: "piped", stderr: "null" }).output();
  return new TextDecoder().decode(out.stdout).trim();
}

async function notify({ title, body }: { title: string; body: string }): Promise<void> {
  const { port } = JSON.parse(await Deno.readTextFile(PORT_FILE)) as { port: number };
  const url = `http://127.0.0.1:${port}/`;
  if (Deno.build.os === "darwin") {
    const q = (s: string) => JSON.stringify(s);
    await run(["osascript", "-e", `display notification ${q(body)} with title ${q(title)}`]);
    return;
  }
  // --wait blocks until the notification closes; an "open" click opens Trame
  run(["notify-send", "-a", "Trame", "-A", "open=Open Trame", "--wait", title, body])
    .then(async (action) => {
      if (action === "open") await run(["xdg-open", url]);
    })
    .catch(() => {});
}

async function check(): Promise<void> {
  const now = new Date();
  const today = todayMark(now);
  if (now.getHours() < NOTIFY_FROM_HOUR) return;
  if ((await Deno.readTextFile(SENT_FILE).catch(() => "")).trim() === today) return;
  const d = digest(await listDue(APP_CTX), today);
  if (!d) return;
  await Deno.writeTextFile(SENT_FILE, today);
  await notify(d);
}

export function startDueNotifier(): void {
  const tick = () => check().catch((e) => console.warn(`due digest: ${(e as Error).message}`));
  setTimeout(tick, 30_000); // after the server wrote its port file
  setInterval(tick, CHECK_EVERY_MS);
}

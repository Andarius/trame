// Single writer for the device-local settings JSON. All mutations go through
// updateSettings(): serialized (in-process queue), atomic (tmp + rename), 0600 —
// the file holds secrets (hub password, forge tokens). Unknown keys always survive.
import { SETTINGS_FILE } from "./config.ts";

export type Settings = Record<string, unknown>;

export async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await Deno.readTextFile(SETTINGS_FILE));
  } catch {
    return {}; // no settings file yet
  }
}

let queue: Promise<unknown> = Promise.resolve();

// mutate() edits the object in place (or returns a replacement).
export function updateSettings(
  mutate: (settings: Settings) => Settings | void,
): Promise<Settings> {
  const run = queue.then(async () => {
    await Deno.mkdir(SETTINGS_FILE.replace(/\/[^/]+$/, ""), { recursive: true })
      .catch(() => {});
    const settings = await readSettings();
    const next = mutate(settings) ?? settings;
    const tmp = `${SETTINGS_FILE}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(next, null, 2), {
      mode: 0o600,
    });
    await Deno.chmod(tmp, 0o600).catch(() => {}); // mode is umask-masked on create
    await Deno.rename(tmp, SETTINGS_FILE);
    return next;
  });
  queue = run.catch(() => {}); // a failed write must not wedge the queue
  return run;
}

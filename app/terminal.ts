// Shared terminal launcher — used by /api/resume and by plugins that need an
// interactive CLI flow (e.g. `gh auth login`). Extracted from main.ts so
// plugins can import it without a module cycle.

export const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`; // POSIX single-quote

// How to place the session: a fresh "window", a "tab" in an existing terminal
// window, or type it into an already-open "existing" session (konsole D-Bus, Linux only).
export type LaunchMode = "window" | "tab" | "existing";

// A live ghostty single-instance daemon means ghostty is the user's actual terminal:
// prefer it over spawning a konsole they may not use. Checked at call time — the
// daemon can start/stop between launches.
export function ghosttyRunning(): boolean {
  try {
    return new Deno.Command("pgrep", {
      args: ["-x", "ghostty"],
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
}

// Open a terminal at `cwd` running `command` (kept open afterwards). Best-effort:
// returns false if no terminal could be launched, so the caller offers copy-to-clipboard.
// `existing` is handled by resumeInExisting() in main.ts; this covers "window" and "tab".
export function spawnTerminal(
  cwd: string,
  command: string,
  mode: LaunchMode = "window",
): boolean {
  const inner = `cd ${shq(cwd)} && ${command}`;
  try {
    if (Deno.build.os === "darwin") {
      const asStr = (s: string) =>
        `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
      // A tab needs Cmd+T on the front window first; a window is Terminal's default.
      const lines = mode === "tab"
        ? [
          `tell application "Terminal" to activate`,
          `tell application "System Events" to keystroke "t" using command down`,
          `tell application "Terminal" to do script ${
            asStr(inner)
          } in front window`,
        ]
        : [
          `tell application "Terminal" to do script ${asStr(inner)}`,
          `tell application "Terminal" to activate`,
        ];
      new Deno.Command("osascript", {
        args: lines.flatMap((l) => ["-e", l]),
        stdout: "null",
        stderr: "null",
      }).spawn();
      return true;
    }
    // Linux: first terminal emulator that exists wins; keep the shell open after the command.
    const keep = `${inner}; exec ${Deno.env.get("SHELL") ?? "bash"}`;
    // `--new-tab` (konsole) / `--tab` (gnome-terminal) attach to an existing window,
    // falling back to a new window when none is open.
    const terms: [string, string[]][] = mode === "tab"
      ? [
        ["konsole", ["--new-tab", "-e", "bash", "-lc", keep]],
        ["gnome-terminal", ["--tab", "--", "bash", "-lc", keep]],
        ["x-terminal-emulator", ["-e", "bash", "-lc", keep]],
        ["xterm", ["-e", "bash", "-lc", keep]],
      ]
      : [
        ["gnome-terminal", ["--", "bash", "-lc", keep]],
        ["konsole", ["-e", "bash", "-lc", keep]],
        ["x-terminal-emulator", ["-e", "bash", "-lc", keep]],
        ["xterm", ["-e", "bash", "-lc", keep]],
      ];
    // Ghostty can't open a tab remotely (new_tab is keybind-only), but +new-window
    // lands instantly in the running instance — the right terminal for both modes.
    if (ghosttyRunning()) {
      terms.unshift(["ghostty", ["+new-window", "-e", "bash", "-lc", keep]]);
    }
    for (const [bin, args] of terms) {
      try {
        new Deno.Command(bin, { args, stdout: "null", stderr: "null" }).spawn();
        return true;
      } catch { /* not installed — try the next */ }
    }
    return false;
  } catch {
    return false;
  }
}

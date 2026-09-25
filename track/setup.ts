// tramecli setup — install the agent skills from THIS binary. The docs are
// embedded at compile time (text imports) and call the bare `tramecli`, so a machine
// needs neither deno nor a checkout (`just setup` compiles + runs it from a dev
// checkout); setup makes that name resolve before writing them.
import trackSkill from "../skills/trame-track/SKILL.md" with { type: "text" };
import trackSkillOpenai from "../skills/trame-track/agents/openai.yaml" with {
  type: "text",
};
import pageSkill from "../skills/trame-page/SKILL.md" with { type: "text" };
import watchSkill from "../skills/trame-watch/SKILL.md" with { type: "text" };
import prePush from "./pre-push.sh" with { type: "text" };
import * as p from "@clack/prompts";
import { QUERY_SYNTAX, SETUP_HELP } from "./help.ts";

export const EMBEDS = {
  trackSkill,
  trackSkillOpenai,
  pageSkill,
  watchSkill,
  prePush,
};

/** In the hook's header: how we recognise a hook we wrote, and may overwrite. */
const HOOK_MARK = "trame pre-push guard";

// one Agent Skills layout for every agent, Claude Code included
const SKILL_FILES: Record<string, string> = {
  "trame-track/SKILL.md": trackSkill,
  "trame-track/agents/openai.yaml": trackSkillOpenai,
  "trame-page/SKILL.md": pageSkill,
  "trame-watch/SKILL.md": watchSkill,
};

export type SetupPlan = {
  claude: boolean;
  skillDirs: string[];
  home: string;
};

// Where a bare `tramecli` resolves right now, symlinks followed (null = nowhere).
async function onPath(name: string): Promise<string | null> {
  const res = await new Deno.Command("which", {
    args: [name],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!res.success) return null;
  const hit = new TextDecoder().decode(res.stdout).trim();
  return await Deno.realPath(hit).catch(() => hit);
}

// The docs call the bare `tramecli`, so point that name at THIS binary — every time.
// Skipping the link when some `tramecli` already answers is how a machine ends up
// running a months-old copy behind freshly installed docs, and the version string
// can't catch it: it tracks releases, not builds. Returns a warning to print, if any.
export async function ensureOnPath(
  home: string,
  self = Deno.execPath(),
): Promise<string | null> {
  if (self.endsWith("/deno") || self.endsWith("deno.exe")) {
    throw new Error(
      "running from source — compile first (`just setup`, or `deno task compile:cli`)",
    );
  }
  self = await Deno.realPath(self).catch(() => self);
  const dest = `${home}/.local/bin/tramecli`;
  if (await Deno.realPath(dest).catch(() => null) !== self) {
    try {
      await Deno.mkdir(`${home}/.local/bin`, { recursive: true });
      await Deno.remove(dest).catch(() => {});
      await Deno.symlink(self, dest);
      console.log(`linked ${dest} → ${self}`);
    } catch (e) {
      return `could not link ${dest} (${(e as Error).message}) — put ${self} on PATH as \`tramecli\``;
    }
  }
  const found = await onPath("tramecli");
  if (!found) {
    return `${dest} is not on PATH — add ~/.local/bin to it, or the installed docs cannot call \`tramecli\``;
  }
  if (found !== self) {
    return `\`tramecli\` still resolves to ${found}, ahead of ${dest} on PATH — remove it, or agents keep running that build instead of this one`;
  }
  return null;
}

async function write(path: string, text: string) {
  await Deno.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
  await Deno.writeTextFile(path, text);
  console.log(`installed → ${path}`);
}

// the pre-skills install: /trame:track + /trame:watch slash commands
async function removeLegacyCommands(home: string) {
  const dir = `${home}/.claude/commands/trame`;
  for (const f of ["track.md", "watch.md"]) {
    if (await Deno.remove(`${dir}/${f}`).then(() => true, () => false)) {
      console.log(`removed ${dir}/${f} (now a skill)`);
    }
  }
  await Deno.remove(dir).catch(() => {});
}

/**
 * Write the pre-push guard into `cwd`'s repo, honouring core.hooksPath, and return
 * its path. A hook we did not write is never clobbered — the caller reports that.
 */
export async function installHook(cwd = Deno.cwd()): Promise<string> {
  const res = await new Deno.Command("git", {
    args: ["rev-parse", "--git-path", "hooks"],
    cwd,
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!res.success) {
    throw new Error(`not a git repository: ${cwd}`);
  }
  const dir = new TextDecoder().decode(res.stdout).trim();
  const path = `${dir.startsWith("/") ? dir : `${cwd}/${dir}`}/pre-push`;
  const existing = await Deno.readTextFile(path).catch(() => null);
  if (existing !== null && !existing.includes(HOOK_MARK)) {
    throw new Error(`${path} exists and is not ours — move it aside first`);
  }
  await Deno.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
  await Deno.writeTextFile(path, prePush);
  await Deno.chmod(path, 0o755).catch(() => {}); // no-op on Windows
  return path;
}

export async function setup(plan: SetupPlan): Promise<void> {
  const dirs = new Set(plan.skillDirs);
  if (plan.claude) {
    dirs.add(`${plan.home}/.claude/skills`);
    await removeLegacyCommands(plan.home);
  }
  for (const dir of dirs) {
    for (const [rel, text] of Object.entries(SKILL_FILES)) {
      await write(`${dir}/${rel}`, text);
    }
  }
}

// interactive target picker for a bare `tramecli setup` on a TTY
async function chooseInteractive(
  home: string,
): Promise<{ claude: boolean; skillDirs: string[] } | null> {
  p.intro(" tramecli setup ");
  const choice = await p.multiselect<"claude" | "codex" | "other">({
    message: "Which coding agents should Trame configure?",
    options: [
      {
        value: "claude",
        label: "Claude Code",
        hint: "the trame-track, trame-page and trame-watch skills in ~/.claude/skills",
      },
      {
        value: "codex",
        label: "Codex",
        hint: "the $trame-track and $trame-page skills in ~/.agents/skills",
      },
      {
        value: "other",
        label: "Other agent",
        hint: "any LLM agent CLI that reads an Agent Skills directory",
      },
    ],
    initialValues: ["claude"],
    required: true,
  });
  if (p.isCancel(choice)) {
    p.cancel("Setup cancelled.");
    return null;
  }
  const skillDirs: string[] = [];
  if (choice.includes("codex")) skillDirs.push(`${home}/.agents/skills`);
  if (choice.includes("other")) {
    const dirs = await p.text({
      message: "Skills directory of that agent (comma-separated for several)",
      placeholder: "~/.gemini/skills",
      validate: (v) => v?.trim() ? undefined : "at least one directory",
    });
    if (p.isCancel(dirs)) {
      p.cancel("Setup cancelled.");
      return null;
    }
    skillDirs.push(
      ...String(dirs).split(",").map((v) =>
        v.trim().replace(/^~\//, `${home}/`)
      ).filter(Boolean),
    );
  }
  return { claude: choice.includes("claude"), skillDirs };
}

export async function run(argv: string[]): Promise<number> {
  const home = Deno.env.get("HOME");
  if (!home) {
    console.error("HOME is not set");
    return 1;
  }
  const skillDirs: string[] = [];
  let claude = false;
  let hook = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--claude") claude = true;
    else if (a === "--hook") hook = true;
    else if (a === "--codex") skillDirs.push(`${home}/.agents/skills`);
    else if (a === "--skills-dir") {
      const dir = argv[++i];
      if (!dir) {
        console.error("--skills-dir needs a directory");
        return 2;
      }
      skillDirs.push(dir.replace(/^~\//, `${home}/`));
    } else {
      console.error(`unknown flag: ${a}\n\n${SETUP_HELP}`);
      return 2;
    }
  }
  const interactive = !claude && !skillDirs.length && !hook;
  if (interactive) {
    if (!Deno.stdout.isTerminal()) {
      console.error(SETUP_HELP);
      return 2;
    }
    const picked = await chooseInteractive(home);
    if (!picked) return 1;
    claude = picked.claude;
    skillDirs.push(...picked.skillDirs);
  }
  const warning = await ensureOnPath(home);
  await setup({ claude, skillDirs, home });
  if (hook) {
    try {
      console.log(`installed → ${await installHook()}`);
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
  }
  if (warning) console.error(`warning: ${warning}`);
  console.log(`\n${QUERY_SYNTAX}`);
  if (interactive) p.outro("Trame agent integrations installed.");
  return 0;
}

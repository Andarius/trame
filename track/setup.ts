// tramecli setup — install the agent command/skills from THIS binary. The docs are
// embedded at compile time (text imports), stamped with the binary's own invocation,
// so a machine needs neither deno nor a checkout. Dev checkouts keep
// scripts/install-track.ts, which also handles the extra command files (plan/watch).
import trackCmd from "../commands/trame/track.md" with { type: "text" };
import trackSkill from "../skills/trame-track/SKILL.md" with { type: "text" };
import trackSkillOpenai from "../skills/trame-track/agents/openai.yaml" with {
  type: "text",
};
import pageSkill from "../skills/trame-page/SKILL.md" with { type: "text" };
import { SETUP_HELP } from "./help.ts";

export const EMBEDS = { trackCmd, trackSkill, trackSkillOpenai, pageSkill };

export type SetupPlan = {
  claude: boolean;
  skillDirs: string[];
  home: string;
  invocation: string;
};

async function onPath(name: string): Promise<boolean> {
  const res = await new Deno.Command("which", {
    args: [name],
    stdout: "null",
    stderr: "null",
  }).output();
  return res.success;
}

// The invocation stamped into the docs: the bare name when reachable, else this
// binary self-installed into ~/.local/bin, else its absolute path.
export async function resolveInvocation(home: string): Promise<string> {
  for (const name of ["tramecli", "trame.tramecli"]) {
    if (await onPath(name)) return name;
  }
  const self = Deno.execPath();
  if (self.endsWith("/deno") || self.endsWith("deno.exe")) {
    throw new Error(
      "running from source — use scripts/install-track.ts, or compile first (deno task compile:cli)",
    );
  }
  const dest = `${home}/.local/bin/tramecli`;
  try {
    await Deno.mkdir(`${home}/.local/bin`, { recursive: true });
    await Deno.remove(dest).catch(() => {});
    await Deno.symlink(self, dest);
    console.log(`linked ${dest} → ${self}`);
    if (await onPath("tramecli")) return "tramecli";
    return dest;
  } catch {
    return self;
  }
}

async function write(path: string, text: string, invocation: string) {
  await Deno.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
  await Deno.writeTextFile(path, text.replaceAll("__TRAMECLI__", invocation));
  console.log(`installed → ${path}`);
}

export async function setup(plan: SetupPlan): Promise<void> {
  const inv = plan.invocation;
  if (plan.claude) {
    await write(`${plan.home}/.claude/commands/trame/track.md`, trackCmd, inv);
    await write(
      `${plan.home}/.claude/skills/trame-page/SKILL.md`,
      pageSkill,
      inv,
    );
  }
  for (const dir of new Set(plan.skillDirs)) {
    await write(`${dir}/trame-track/SKILL.md`, trackSkill, inv);
    await write(`${dir}/trame-track/agents/openai.yaml`, trackSkillOpenai, inv);
    await write(`${dir}/trame-page/SKILL.md`, pageSkill, inv);
  }
}

export async function run(argv: string[]): Promise<number> {
  const home = Deno.env.get("HOME");
  if (!home) {
    console.error("HOME is not set");
    return 1;
  }
  const skillDirs: string[] = [];
  let claude = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--claude") claude = true;
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
  if (!claude && !skillDirs.length) {
    console.error(SETUP_HELP);
    return 2;
  }
  const invocation = await resolveInvocation(home);
  await setup({ claude, skillDirs, home, invocation });
  console.log(`writer binary: ${invocation}`);
  return 0;
}

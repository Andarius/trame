import * as p from "@clack/prompts";

type Target = "claude" | "codex";

const root = decodeURIComponent(new URL("../", import.meta.url).pathname);
const home = Deno.env.get("HOME");
if (!home) {
  console.error("HOME is not set");
  Deno.exit(1);
}

// installed copies must point at THIS checkout's writers
const WRITERS: Record<string, string> = {
  __TRACK_WRITER__: `${root}track/track.ts`,
  __PAGE_WRITER__: `${root}track/page.ts`,
  __COMMENT_WRITER__: `${root}track/comment.ts`,
};

function patch(text: string): string {
  for (const [placeholder, path] of Object.entries(WRITERS)) {
    text = text.replaceAll(placeholder, path);
  }
  return text;
}

async function copyDir(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const from = `${src}/${entry.name}`;
    const to = `${dest}/${entry.name}`;
    if (entry.isDirectory) await copyDir(from, to);
    else await Deno.copyFile(from, to);
  }
}

async function installPatched(src: string, dest: string): Promise<void> {
  await Deno.writeTextFile(dest, patch(await Deno.readTextFile(src)));
}

async function installClaude(): Promise<void> {
  const cmdDir = `${home}/.claude/commands/trame`;
  await Deno.mkdir(cmdDir, { recursive: true });
  await installPatched(`${root}commands/trame/track.md`, `${cmdDir}/track.md`);
  console.log(`installed → ${cmdDir}/track.md`);

  const skillDir = `${home}/.claude/skills/trame-page`;
  await Deno.mkdir(skillDir, { recursive: true });
  await installPatched(
    `${root}skills/trame-page/SKILL.md`,
    `${skillDir}/SKILL.md`,
  );
  console.log(
    `installed → ${skillDir} (auto-triggers on page/document requests)`,
  );
}

async function installCodex(): Promise<void> {
  for (const skill of ["trame-track", "trame-page"]) {
    const dest = `${home}/.agents/skills/${skill}`;
    await copyDir(`${root}skills/${skill}`, dest);
    await installPatched(`${dest}/SKILL.md`, `${dest}/SKILL.md`);
    console.log(`installed → ${dest} (invoke with $${skill})`);
  }
}

function targetsFromArgs(): Target[] | null {
  const i = Deno.args.indexOf("--target");
  if (i < 0) return null;
  const values = (Deno.args[i + 1] ?? "").split(",").map((v) => v.trim())
    .filter(Boolean);
  const invalid = values.filter((v) => v !== "claude" && v !== "codex");
  if (values.length === 0 || invalid.length > 0) {
    console.error(
      `invalid --target: ${
        Deno.args[i + 1]
      } (expected claude, codex, or claude,codex)`,
    );
    Deno.exit(2);
  }
  return [...new Set(values as Target[])];
}

async function chooseTargets(): Promise<Target[] | null> {
  p.intro(" Trame tracking ");
  const choice = await p.multiselect<Target>({
    message: "Which coding agents should Trame configure?",
    options: [
      {
        value: "claude",
        label: "Claude Code",
        hint:
          "Installs the /trame:track slash command and the trame-page skill",
      },
      {
        value: "codex",
        label: "Codex",
        hint: "Installs the $trame-track and $trame-page agent skills",
      },
    ],
    initialValues: ["claude"],
    required: true,
  });
  if (p.isCancel(choice)) {
    p.cancel("Installation cancelled.");
    return null;
  }
  return choice;
}

const targets = targetsFromArgs() ?? await chooseTargets();
if (targets) {
  if (targets.includes("claude")) await installClaude();
  if (targets.includes("codex")) await installCodex();
  if (!Deno.args.includes("--target")) {
    p.outro("Trame agent integrations installed.");
  }
}

import * as p from "@clack/prompts";

type Target = "claude" | "codex";

const root = decodeURIComponent(new URL("../", import.meta.url).pathname);
const home = Deno.env.get("HOME");
if (!home) {
  console.error("HOME is not set");
  Deno.exit(1);
}

const AGENTS_SKILLS_DIR = `${home}/.agents/skills`; // shared Agent Skills dir (Codex & friends)

// installed copies must point at THIS checkout's writers
const WRITERS: Record<string, string> = {
  __TRACK_WRITER__: `${root}track/track.ts`,
  __PAGE_WRITER__: `${root}track/page.ts`,
  __COMMENT_WRITER__: `${root}track/comment.ts`,
  __PAGE_WATCH__: `${root}track/page-watch.ts`,
};

// shared doc fragments inlined into both the command and the skill
const FRAGMENTS: Record<string, string> = {
  __TRACK_FIELDS__: (await Deno.readTextFile(
    `${root}skills/trame-track/fields.md`,
  )).trimEnd(),
};

function patch(text: string): string {
  for (const [placeholder, body] of Object.entries(FRAGMENTS)) {
    text = text.replaceAll(placeholder, body);
  }
  for (const [placeholder, path] of Object.entries(WRITERS)) {
    text = text.replaceAll(placeholder, path);
  }
  return text;
}

function expandHome(path: string): string {
  return path === "~" ? home! : path.replace(/^~\//, `${home}/`);
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
  for await (const entry of Deno.readDir(`${root}commands/trame`)) {
    if (!entry.isFile || !entry.name.endsWith(".md")) continue;
    await installPatched(
      `${root}commands/trame/${entry.name}`,
      `${cmdDir}/${entry.name}`,
    );
    console.log(`installed → ${cmdDir}/${entry.name}`);
  }

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

// works for any agent CLI that reads an Agent Skills directory
async function installSkills(base: string): Promise<void> {
  for (const skill of ["trame-track", "trame-page"]) {
    const dest = `${base}/${skill}`;
    await copyDir(`${root}skills/${skill}`, dest);
    await installPatched(`${dest}/SKILL.md`, `${dest}/SKILL.md`);
    console.log(`installed → ${dest}`);
  }
}

function argValues(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < Deno.args.length; i++) {
    if (Deno.args[i] === flag) out.push(Deno.args[i + 1] ?? "");
  }
  return out;
}

function targetsFromArgs(): Target[] | null {
  const raw = argValues("--target");
  if (raw.length === 0) return null;
  const values = raw.join(",").split(",").map((v) => v.trim()).filter(Boolean);
  const invalid = values.filter((v) => v !== "claude" && v !== "codex");
  if (values.length === 0 || invalid.length > 0) {
    console.error(
      `invalid --target: ${
        invalid.join(",")
      } (expected claude, codex, or claude,codex; other agents → --skills-dir)`,
    );
    Deno.exit(2);
  }
  return [...new Set(values as Target[])];
}

function skillDirsFromArgs(): string[] {
  return argValues("--skills-dir").join(",").split(",")
    .map((v) => expandHome(v.trim())).filter(Boolean);
}

async function chooseInteractive(): Promise<
  { claude: boolean; skillDirs: string[] } | null
> {
  p.intro(" Trame tracking ");
  const choice = await p.multiselect<Target | "other">({
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
        hint:
          "Installs the $trame-track and $trame-page skills in ~/.agents/skills",
      },
      {
        value: "other",
        label: "Other agent",
        hint: "Any LLM agent CLI that reads an Agent Skills directory",
      },
    ],
    initialValues: ["claude"],
    required: true,
  });
  if (p.isCancel(choice)) {
    p.cancel("Installation cancelled.");
    return null;
  }
  const skillDirs: string[] = [];
  if (choice.includes("codex")) skillDirs.push(AGENTS_SKILLS_DIR);
  if (choice.includes("other")) {
    const dirs = await p.text({
      message: "Skills directory of that agent (comma-separated for several)",
      placeholder: "~/.gemini/skills",
      validate: (v) => v?.trim() ? undefined : "at least one directory",
    });
    if (p.isCancel(dirs)) {
      p.cancel("Installation cancelled.");
      return null;
    }
    skillDirs.push(
      ...String(dirs).split(",").map((v) => expandHome(v.trim()))
        .filter(Boolean),
    );
  }
  return { claude: choice.includes("claude"), skillDirs };
}

const cliTargets = targetsFromArgs();
const cliDirs = skillDirsFromArgs();
const interactive = cliTargets === null && cliDirs.length === 0;

const plan = interactive ? await chooseInteractive() : {
  claude: cliTargets?.includes("claude") ?? false,
  skillDirs: [
    ...(cliTargets?.includes("codex") ? [AGENTS_SKILLS_DIR] : []),
    ...cliDirs,
  ],
};

if (plan) {
  if (plan.claude) await installClaude();
  for (const dir of new Set(plan.skillDirs)) await installSkills(dir);
  if (interactive) p.outro("Trame agent integrations installed.");
}

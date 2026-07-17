import * as p from "@clack/prompts";

type Target = "claude" | "codex";

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
        hint: "Installs the /trame:track slash command and the trame-page skill",
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

async function install(recipe: "install-cmd" | "install-skill"): Promise<void> {
  const root = decodeURIComponent(new URL("../", import.meta.url).pathname);
  const child = new Deno.Command("just", {
    args: [recipe],
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.spawn().status;
  if (!status.success) {
    throw new Error(`${recipe} failed with exit code ${status.code}`);
  }
}

const targets = targetsFromArgs() ?? await chooseTargets();
if (targets) {
  if (targets.includes("claude")) await install("install-cmd");
  if (targets.includes("codex")) await install("install-skill");
  if (!Deno.args.includes("--target")) {
    p.outro("Trame agent integrations installed.");
  }
}

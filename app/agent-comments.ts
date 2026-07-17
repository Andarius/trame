// An agent id is free-form: any model can attribute itself honestly (the running
// model, e.g. "glm", not just the harness seat). "codex"/"claude" get a branded
// avatar; anything else gets a generated initial avatar.
export type AgentKind = string;

// Reserved author_id for agent/external comments. Null means "legacy pre-identity
// row" and gets claimed by the schema.sql single-user backfill — agents must not.
export const AGENT_AUTHOR_ID = "00000000-0000-4000-8000-0000000000aa";

// Brand paths pinned from Simple Icons: OpenAI v15.0.0 (removed in later releases)
// and Anthropic v16.21.0. The surrounding circle makes both readable in Trame's
// compact comment gutter without any network fetch.
const OPENAI_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
const ANTHROPIC_PATH =
  "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z";

function avatar(title: string, path: string, background: string): string {
  const svg =
    `<svg role="img" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><title>${title}</title><circle cx="16" cy="16" r="16" fill="${background}"/><g transform="translate(5 5) scale(.9166667)" fill="white"><path d="${path}"/></g></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const AGENTS: Record<string, { name: string; avatar: string }> = {
  codex: {
    name: "Codex",
    avatar: avatar("OpenAI", OPENAI_PATH, "#111827"),
  },
  claude: {
    name: "Claude",
    avatar: avatar("Anthropic", ANTHROPIC_PATH, "#D97757"),
  },
};

// For an unbranded model: a colored circle with its initial, dependency-free.
const GEN_PALETTE = [
  "#7a9ee7",
  "#b590e7",
  "#c98a63",
  "#7bd88f",
  "#e3c567",
  "#e06c75",
  "#56b6c2",
  "#8b93a3",
];
function generatedIdentity(key: string): { name: string; avatar: string } {
  // short ids read better upper-cased (GLM), longer ones title-cased (Gemini)
  const name = key.length <= 4
    ? key.toUpperCase()
    : key[0].toUpperCase() + key.slice(1);
  const bg = GEN_PALETTE[
    [...key].reduce((a, c) => a + c.charCodeAt(0), 0) % GEN_PALETTE.length
  ];
  const initial = key[0].toUpperCase();
  const svg =
    `<svg role="img" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><title>${name}</title><circle cx="16" cy="16" r="16" fill="${bg}"/><text x="16" y="22" font-family="sans-serif" font-size="17" font-weight="600" fill="white" text-anchor="middle">${initial}</text></svg>`;
  return { name, avatar: `data:image/svg+xml;base64,${btoa(svg)}` };
}

// Any model may attribute itself. Known brands get their icon; every other model id
// gets a generated initial avatar so the author is honest, not forced to a seat name.
export function agentIdentity(agent: AgentKind): {
  name: string;
  avatar: string;
} {
  const key = agent.trim().toLowerCase();
  if (!key) throw new Error("agent is required");
  return AGENTS[key] ?? generatedIdentity(key);
}

type Block = { type?: unknown; text?: unknown; id?: unknown };

export function resolveCommentBlock(
  content: unknown,
  target: { block_id?: string; block_text?: string },
): { id: string; text: string } {
  const blocks = (Array.isArray(content) ? content : []).filter(
    (b): b is Block & { id: string; text: string } =>
      Boolean(
        b &&
          typeof b === "object" &&
          ["text", "heading", "todo"].includes(String((b as Block).type)) &&
          typeof (b as Block).id === "string" &&
          typeof (b as Block).text === "string",
      ),
  );

  if (target.block_id) {
    const hit = blocks.find((b) => b.id === target.block_id);
    if (!hit) throw new Error(`block_id "${target.block_id}" was not found`);
    return { id: hit.id, text: hit.text };
  }

  const want = target.block_text?.trim();
  if (want) {
    let matches = blocks.filter((b) => b.text.trim() === want);
    if (!matches.length) matches = blocks.filter((b) => b.text.includes(want));
    if (matches.length === 1) {
      return { id: matches[0].id, text: matches[0].text };
    }
    if (matches.length > 1) {
      throw new Error(
        `block_text "${want}" matches multiple blocks; use block_id`,
      );
    }
    throw new Error(`block_text "${want}" was not found`);
  }

  if (blocks.length === 1) return { id: blocks[0].id, text: blocks[0].text };
  const choices = blocks.slice(0, 8).map((b) =>
    `${b.id}: ${b.text.trim().replace(/\s+/g, " ").slice(0, 80)}`
  ).join("\n");
  throw new Error(
    `block_id or unique block_text is required${
      choices ? `:\n${choices}` : " (page has no commentable blocks)"
    }`,
  );
}

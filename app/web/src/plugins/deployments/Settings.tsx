// Deployments settings — rendered in the plugins manager modal. Watched repos
// as rows with a per-row forge chip; one connection card per forge with the
// resolved auth source and a live test (nothing persisted by Test).
import { useEffect, useMemo, useState } from "react";
import { getPluginSettings, savePluginSettings } from "../../api";
import { Select } from "../../ui";
import { SourceChip } from "./Panel";

type Forge = "github" | "gitlab";
type Row = { source: Forge; repo: string };
type TestResult =
  | { state: "idle" | "busy" }
  | { state: "ok"; user?: string; source?: string }
  | { state: "fail"; error?: string };
type AuthStatus = Record<
  Forge,
  { cli: boolean; source: string; loginCommand: string | null }
>;

const pill =
  "rounded-md border border-line bg-panel px-2.5 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-chipline";

// Parse a pasted forge URL into forge + repo path (+ base URL for self-hosted
// GitLab). github.com → GitHub; any other host → GitLab (GitHub Enterprise
// isn't supported). GitLab's `/-/` marks the end of the nested project path.
function parseForgeUrl(
  raw: string,
): { source: Forge; repo: string; baseUrl?: string } | null {
  const s = raw.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  let segs = u.pathname.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  const host = u.hostname.toLowerCase();
  if (host === "github.com" || host.endsWith(".github.com")) {
    return {
      source: "github",
      repo: segs.slice(0, 2).join("/").replace(/\.git$/, ""),
    };
  }
  const dash = segs.indexOf("-");
  if (dash > 1) segs = segs.slice(0, dash);
  return {
    source: "gitlab",
    repo: segs.join("/").replace(/\.git$/, ""),
    baseUrl: host === "gitlab.com" ? undefined : `${u.protocol}//${u.host}`,
  };
}

const authLabel = (s?: string) =>
  s === "settings"
    ? "saved PAT"
    : s === "env"
    ? "env token"
    : s === "cli"
    ? "cli token"
    : s ?? "";

export function DeploymentsSettings() {
  const [rows, setRows] = useState<Row[]>([]);
  const [addSource, setAddSource] = useState<Forge>("gitlab");
  const [addRepo, setAddRepo] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [glToken, setGlToken] = useState("");
  const [hasGh, setHasGh] = useState(false);
  const [hasGl, setHasGl] = useState(false);
  const [tests, setTests] = useState<
    { github: TestResult; gitlab: TestResult }
  >(
    { github: { state: "idle" }, gitlab: { state: "idle" } },
  );
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [loginHint, setLoginHint] = useState<Partial<Record<Forge, string>>>(
    {},
  );
  const [saved, setSaved] = useState<"idle" | "busy" | "done">("idle");
  const [copied, setCopied] = useState<Forge | null>(null);
  const [pollSeconds, setPollSeconds] = useState(300);

  const copyCmd = async (forge: Forge, cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      // webview clipboard blocked — legacy execCommand path
      const ta = document.createElement("textarea");
      ta.value = cmd;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(forge);
    setTimeout(() => setCopied(null), 1500);
  };

  const loadAuth = (base = "") =>
    fetch(
      `/api/plugins/deployments/auth-status${
        base ? `?gitlabBaseUrl=${encodeURIComponent(base)}` : ""
      }`,
    )
      .then((r) => r.json() as Promise<AuthStatus>)
      .then(setAuth)
      .catch(() => {});

  const login = (forge: Forge) => {
    setLoginHint((h) => ({ ...h, [forge]: "opening a terminal…" }));
    fetch("/api/plugins/deployments/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ forge, gitlabBaseUrl: baseUrl.trim() }),
    }).then((r) => r.json())
      .then((r: { launched: boolean }) =>
        setLoginHint((h) => ({
          ...h,
          [forge]: r.launched
            ? "finish the login in the terminal, then Test"
            : `couldn't open a terminal — run \`${
              forge === "github" ? "gh" : "glab"
            } auth login\` yourself`,
        }))
      )
      .catch(() => setLoginHint((h) => ({ ...h, [forge]: "request failed" })));
  };

  useEffect(() => {
    getPluginSettings("deployments").then((s) => {
      setRows([
        ...((s.githubRepos ?? []) as string[]).map((repo) => ({
          source: "github" as const,
          repo,
        })),
        ...((s.gitlabProjects ?? []) as string[]).map((repo) => ({
          source: "gitlab" as const,
          repo,
        })),
      ]);
      setBaseUrl((s.gitlabBaseUrl as string) ?? "");
      setHasGh(Boolean(s.githubHasToken));
      setHasGl(Boolean(s.gitlabHasToken));
      if (typeof s.pollIdleSeconds === "number") {
        setPollSeconds(s.pollIdleSeconds);
      }
    }).catch(() => {});
    loadAuth();
  }, []);

  // what the panel's org tabs will be, live from the watch list
  const orgs = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const org = r.repo.split("/")[0];
      if (org) m.set(org, (m.get(org) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) =>
      b[1] - a[1] || a[0].localeCompare(b[0])
    );
  }, [rows]);

  // Add a repo (owner/repo, group/project, or a full forge URL — auto-detected).
  const addEntry = (source: Forge, repo: string, baseUrl?: string) => {
    const clean = repo.trim();
    if (baseUrl) setBaseUrl(baseUrl);
    if (!clean || rows.some((r) => r.source === source && r.repo === clean)) {
      return;
    }
    setRows((r) => [...r, { source, repo: clean }]);
    setAddRepo("");
  };
  const add = () => {
    const parsed = parseForgeUrl(addRepo);
    if (parsed) addEntry(parsed.source, parsed.repo, parsed.baseUrl);
    else addEntry(addSource, addRepo);
  };

  const test = (forge: Forge) => {
    setTests((t) => ({ ...t, [forge]: { state: "busy" } }));
    fetch("/api/plugins/deployments/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        forge,
        githubToken: ghToken.trim(),
        gitlabToken: glToken.trim(),
        gitlabBaseUrl: baseUrl.trim(),
      }),
    }).then((r) => r.json())
      .then((
        r: { ok: boolean; user?: string; source?: string; error?: string },
      ) => {
        setTests((t) => ({
          ...t,
          [forge]: r.ok
            ? { state: "ok", user: r.user, source: r.source }
            : { state: "fail", error: r.error },
        }));
        if (r.ok) loadAuth(); // a login done since page-open shows up in the chip
      })
      .catch(() =>
        setTests((t) => ({
          ...t,
          [forge]: { state: "fail", error: "request failed" },
        }))
      );
  };

  const save = () => {
    setSaved("busy");
    savePluginSettings("deployments", {
      githubRepos: rows.filter((r) => r.source === "github").map((r) => r.repo),
      gitlabProjects: rows.filter((r) => r.source === "gitlab").map((r) =>
        r.repo
      ),
      gitlabBaseUrl: baseUrl.trim(),
      githubToken: ghToken.trim(), // blank = keep stored
      gitlabToken: glToken.trim(),
      pollIdleSeconds: pollSeconds,
    }).then((s) => {
      setHasGh(Boolean(s.githubHasToken));
      setHasGl(Boolean(s.gitlabHasToken));
      setGhToken("");
      setGlToken("");
      setSaved("done");
      setTimeout(() => setSaved("idle"), 2000);
    }).catch(() => setSaved("idle"));
  };

  // Test result wins; otherwise the resolved chain status; otherwise the CLI picture.
  const testChip = (forge: Forge) => {
    const t = tests[forge];
    if (t.state === "ok") {
      return (
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-active)" }}
        >
          ✓ {t.user} · {authLabel(t.source)}
        </span>
      );
    }
    if (t.state === "fail") {
      return (
        <span
          className="max-w-[160px] truncate text-[10.5px] text-blocked"
          title={t.error}
        >
          ✕ {t.error}
        </span>
      );
    }
    const a = auth?.[forge];
    if (!a) return <span className="text-[10.5px] text-ink-muted/70">…</span>;
    if (a.source !== "none") {
      return (
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-active)" }}
        >
          ● connected · {authLabel(a.source)}
        </span>
      );
    }
    const cli = forge === "github" ? "gh" : "glab";
    return (
      <span className="text-[10.5px] text-paused">
        {a.cli ? `${cli} installed — not logged in` : `${cli} not installed`}
      </span>
    );
  };

  // Login affordances, only while disconnected: the login button when the CLI
  // is there to run it, plus the copyable command chip.
  const loginRow = (forge: Forge) => {
    const a = auth?.[forge];
    if (!a || a.source !== "none") return null; // connected — nothing to show
    const cli = forge === "github" ? "gh" : "glab";
    return (
      <div className="mt-1.5 flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          {a.cli
            ? (
              <button
                type="button"
                className="rounded-md border border-copper/50 px-2 py-1 text-[11px] text-copper hover:bg-copper/10"
                onClick={() => login(forge)}
              >
                Log in with {cli}
              </button>
            )
            : (
              <span className="text-[10px] text-ink-muted/80">
                install <span className="font-mono">{cli}</span> or paste a PAT
              </span>
            )}
          {loginHint[forge] && (
            <span className="min-w-0 truncate text-[10px] text-ink-muted">
              {loginHint[forge]}
            </span>
          )}
        </div>
        {a.loginCommand && (
          <button
            type="button"
            title="click to copy the login command"
            onClick={() => copyCmd(forge, a.loginCommand!)}
            className="w-full whitespace-normal break-all rounded border border-line-soft bg-card/50 px-1.5 py-1 text-left font-mono text-[10px] leading-relaxed text-ink-muted hover:border-chipline hover:text-ink-soft"
          >
            $ {a.loginCommand}{" "}
            <span className={copied === forge ? "text-copper" : "opacity-60"}>
              {copied === forge ? "✓ copied" : "⧉"}
            </span>
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12.5px] font-semibold">Watched repositories</div>
      <div>
        {rows.map((r) => (
          <div
            key={r.source + r.repo}
            className="flex items-center gap-2 py-1.5"
          >
            <SourceChip source={r.source} />
            <span className="flex-1 truncate text-[11.5px]">
              <span className="text-ink-muted">{r.repo.split("/")[0]}/</span>
              {r.repo.split("/").slice(1).join("/")}
            </span>
            <button
              type="button"
              className="text-[11px] text-ink-muted hover:text-blocked"
              onClick={() => setRows((rs) => rs.filter((x) => x !== r))}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="mt-1.5 flex gap-2">
          <div className="w-[92px] shrink-0">
            <Select
              value={addSource}
              onChange={(v) => setAddSource(v as Forge)}
              options={[
                { value: "gitlab", label: "GitLab" },
                { value: "github", label: "GitHub" },
              ]}
              className="rounded-md border border-line bg-panel px-2 py-1.5 text-[11.5px] text-ink outline-none focus:border-chipline"
            />
          </div>
          <input
            className={`${pill} min-w-0 flex-1`}
            placeholder={addSource === "github"
              ? "owner/repo or paste a URL"
              : "group/project or paste a URL"}
            value={addRepo}
            spellCheck={false}
            onPaste={(e) => {
              const parsed = parseForgeUrl(e.clipboardData.getData("text"));
              if (!parsed) return; // normal paste
              e.preventDefault(); // a full URL → add it straight away
              setAddSource(parsed.source);
              addEntry(parsed.source, parsed.repo, parsed.baseUrl);
            }}
            onChange={(e) => {
              const parsed = parseForgeUrl(e.target.value);
              if (parsed) { // typed/dropped a URL → fill forge + path
                setAddSource(parsed.source);
                setAddRepo(parsed.repo);
                if (parsed.baseUrl) setBaseUrl(parsed.baseUrl);
              } else setAddRepo(e.target.value);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
          />
          <button
            type="button"
            className="rounded-md border border-chipline px-2.5 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
            onClick={add}
          >
            ＋ Add
          </button>
        </div>
        {orgs.length > 0 && (
          <div className="mt-2 text-[10.5px] text-ink-muted">
            panel tabs → {orgs.map(([o, n], i) => (
              <span key={o}>
                {i > 0 && " · "}
                <span className="text-copper">{o}</span> ({n})
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="h-px bg-line" />
      <div className="text-[12.5px] font-semibold">Connections</div>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-[10px] border border-line bg-panel p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[12px] font-semibold">GitHub</span>
            <span className="ml-auto">{testChip("github")}</span>
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              className={`${pill} min-w-0 flex-1 bg-card/60`}
              placeholder={hasGh
                ? "•••••• (saved)"
                : "PAT — empty uses GITHUB_TOKEN or gh cli"}
              title="blank keeps the stored token"
              value={ghToken}
              onChange={(e) => setGhToken(e.target.value)}
            />
            <button
              type="button"
              className="rounded-md border border-chipline px-2 py-1 text-[11px] text-ink-muted hover:text-ink-soft disabled:opacity-40"
              disabled={tests.github.state === "busy"}
              onClick={() => test("github")}
            >
              {tests.github.state === "busy" ? "…" : "Test"}
            </button>
          </div>
          {loginRow("github")}
        </div>
        <div className="rounded-[10px] border border-line bg-panel p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[12px] font-semibold">GitLab</span>
            <span className="ml-auto">{testChip("gitlab")}</span>
          </div>
          <input
            className={`${pill} mb-2 w-full bg-card/60`}
            placeholder="https://gitlab.com"
            value={baseUrl}
            spellCheck={false}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <div className="flex gap-2">
            <input
              type="password"
              className={`${pill} min-w-0 flex-1 bg-card/60`}
              placeholder={hasGl
                ? "•••••• (saved)"
                : "PAT — empty uses GITLAB_TOKEN or glab cli"}
              title="blank keeps the stored token"
              value={glToken}
              onChange={(e) => setGlToken(e.target.value)}
            />
            <button
              type="button"
              className="rounded-md border border-chipline px-2 py-1 text-[11px] text-ink-muted hover:text-ink-soft disabled:opacity-40"
              disabled={tests.gitlab.state === "busy"}
              onClick={() => test("gitlab")}
            >
              {tests.gitlab.state === "busy" ? "…" : "Test"}
            </button>
          </div>
          {loginRow("gitlab")}
          <div className="mt-1.5 text-[10px] text-ink-muted/80">
            detects manual deploy jobs (any tier) and Premium approval gates
          </div>
        </div>
      </div>

      <div className="h-px bg-line" />
      <div className="flex items-center gap-2.5">
        <span className="text-[12.5px] font-semibold">Check every</span>
        <div className="w-[124px]">
          <Select
            value={String(pollSeconds)}
            onChange={(v) => setPollSeconds(Number(v))}
            options={[
              { value: "30", label: "30 seconds" },
              { value: "60", label: "1 minute" },
              { value: "120", label: "2 minutes" },
              { value: "300", label: "5 minutes" },
              { value: "600", label: "10 minutes" },
              { value: "1800", label: "30 minutes" },
            ]}
            className="rounded-md border border-line bg-panel px-2 py-1.5 text-[11.5px] text-ink outline-none focus:border-chipline"
          />
        </div>
        <span className="text-[10px] text-ink-muted/80">
          while a pipeline is running it checks every 10s regardless
        </span>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          className="rounded-md bg-copper px-3 py-1.5 text-[11.5px] font-medium text-copper-ink hover:brightness-110 disabled:opacity-60"
          disabled={saved === "busy"}
          onClick={save}
        >
          {saved === "busy" ? "Saving…" : "Save"}
        </button>
        {saved === "done" && (
          <span
            className="text-[11px]"
            style={{ color: "var(--color-active)" }}
          >
            ✓ saved
          </span>
        )}
      </div>
    </div>
  );
}

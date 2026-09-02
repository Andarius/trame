// Cockpit settings — connection card plus the project-mapping editor.
// The mapping list IS the privacy boundary: an empty list fetches nothing, so
// the pane leads with it rather than burying it under the credentials.
import { useEffect, useState } from "react";
import { getPluginSettings, savePluginSettings } from "../../api";
import { Select } from "../../ui";

type Mapping = { product?: string; flow?: string; pageId: string };
type Slice = {
  baseUrl: string;
  projects: Mapping[];
  hasToken: boolean;
  mirror: boolean;
  pollIdleSeconds: number;
};
type Test =
  | { state: "idle" | "busy" }
  | { state: "ok"; detail: string }
  | { state: "fail"; kind: string; detail: string };

type Page = { id: string; kind: string; title: string };

const input =
  "rounded-md border border-line bg-panel px-2.5 py-1.5 text-[11.5px] text-ink outline-none focus:border-chipline";

export function CockpitSettings() {
  const [slice, setSlice] = useState<Slice | null>(null);
  const [token, setToken] = useState("");
  const [test, setTest] = useState<Test>({ state: "idle" });
  const [projects, setProjects] = useState<Page[]>([]);

  useEffect(() => {
    getPluginSettings("cockpit").then((s) => setSlice(s as unknown as Slice));
    fetch("/api/pages")
      .then((r) => (r.ok ? r.json() : []))
      .then((all: Page[]) =>
        setProjects(all.filter((p) => p.kind === "project"))
      )
      .catch(() => {});
  }, []);

  if (!slice) return <div className="text-[12px] text-ink-muted">Loading…</div>;

  const save = async (patch: Record<string, unknown>) => {
    const next = await savePluginSettings("cockpit", patch);
    setSlice(next as unknown as Slice);
    setToken("");
    setTest({ state: "idle" });
  };

  const setMappings = (rows: Mapping[]) => save({ projects: rows });

  const runTest = async () => {
    setTest({ state: "busy" });
    const r = await fetch("/api/plugins/cockpit/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: slice.baseUrl, token }),
    });
    const out = await r.json();
    setTest(
      out.ok ? { state: "ok", detail: out.detail } : {
        state: "fail",
        kind: out.kind ?? "http",
        detail: out.detail ?? "failed",
      },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      {/* ---- Mapped projects ---- */}
      <section>
        <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-[0.8px] text-ink-muted/80">
          Mapped projects
        </div>
        <p className="mb-2 text-[11px] text-ink-muted">
          Only these Cockpit products and flows are ever requested. With none
          mapped, the plugin makes no network call at all.
        </p>

        <div className="flex flex-col gap-1.5">
          {slice.projects.map((m, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Select
                value={m.flow ? "flow" : "product"}
                options={[
                  { value: "product", label: "product" },
                  { value: "flow", label: "flow" },
                ]}
                onChange={(kind) => {
                  const slug = m.product ?? m.flow ?? "";
                  const rows = [...slice.projects];
                  rows[i] = kind === "flow"
                    ? { flow: slug, pageId: m.pageId }
                    : { product: slug, pageId: m.pageId };
                  setMappings(rows);
                }}
              />
              <input
                className={`${input} w-32`}
                placeholder="slug"
                defaultValue={m.product ?? m.flow ?? ""}
                onBlur={(e) => {
                  const slug = e.target.value.trim();
                  const rows = [...slice.projects];
                  rows[i] = m.flow
                    ? { flow: slug, pageId: m.pageId }
                    : { product: slug, pageId: m.pageId };
                  setMappings(rows);
                }}
              />
              <span className="text-[11px] text-ink-muted">→</span>
              <Select
                value={m.pageId}
                options={[
                  { value: "", label: "Trame project…" },
                  ...projects.map((p) => ({ value: p.id, label: p.title })),
                ]}
                onChange={(pageId) => {
                  const rows = [...slice.projects];
                  rows[i] = { ...m, pageId };
                  setMappings(rows);
                }}
              />
              <button
                type="button"
                title="Remove"
                onClick={() =>
                  setMappings(slice.projects.filter((_, j) =>
                    j !== i
                  ))}
                className="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-muted hover:border-chipline"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() =>
            setMappings([...slice.projects, { product: "", pageId: "" }])}
          className="mt-2 rounded-md border border-dashed border-chipline px-2 py-1 text-[11.5px] text-ink-muted hover:text-ink-soft"
        >
          ＋ Map a project
        </button>
      </section>

      {/* ---- Connection ---- */}
      <section>
        <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-[0.8px] text-ink-muted/80">
          Connection
        </div>
        <div className="flex flex-col gap-1.5">
          <input
            className={input}
            placeholder="https://cockpit.example.com"
            defaultValue={slice.baseUrl}
            onBlur={(e) => save({ baseUrl: e.target.value })}
          />
          <input
            className={input}
            type="password"
            placeholder={slice.hasToken
              ? "token saved — type to replace"
              : "bearer token"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <p className="text-[10.5px] text-ink-muted">
            A personal token from Cockpit → Réglages → Connexion MCP. Changing
            the host clears the saved token — it is never sent anywhere else.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => token && save({ token })}
              disabled={!token}
              className="rounded-md bg-copper px-2.5 py-1 text-[11.5px] text-copper-ink disabled:opacity-40"
            >
              Save token
            </button>
            <button
              type="button"
              onClick={runTest}
              disabled={test.state === "busy"}
              className="rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-soft hover:border-chipline disabled:opacity-50"
            >
              Test
            </button>
            {slice.hasToken && (
              <button
                type="button"
                onClick={() => save({ clearToken: true })}
                className="text-[11px] text-ink-muted hover:text-blocked"
              >
                Clear
              </button>
            )}
          </div>
          {test.state === "ok" && (
            <div className="text-[11px] text-active">✓ {test.detail}</div>
          )}
          {test.state === "fail" && (
            <div className="text-[11px] text-blocked">
              ✕ {test.detail}
              {
                /* The common first-run case: the token is fine, nobody has
                  granted it a scope yet. Say so instead of "forbidden". */
              }
              {test.kind === "scope" && (
                <span className="block text-ink-muted">
                  Open the token in Cockpit → Réglages → Connexion MCP and tick
                  a product or flow under “Synchro externe”. It is your own
                  token, so you can grant this yourself.
                </span>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ---- Mirroring ---- */}
      <section>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={slice.mirror}
            onChange={(e) => save({ mirror: e.target.checked })}
          />
          <span>
            <span className="text-[12px]">Mirror tickets as story pages</span>
            <span className="mt-0.5 block text-[11px] text-ink-muted">
              Writes a page per ticket under each mapping's project. These pages
              sync like any other and can be shared by link — only turn this on
              for projects you are willing to keep locally.
            </span>
          </span>
        </label>
      </section>

      {/* ---- Cadence ---- */}
      <section>
        <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-[0.8px] text-ink-muted/80">
          Poll interval
        </div>
        <div className="flex items-center gap-1.5">
          <input
            className={`${input} w-20`}
            type="number"
            min={30}
            defaultValue={slice.pollIdleSeconds}
            onBlur={(e) => save({ pollIdleSeconds: Number(e.target.value) })}
          />
          <span className="text-[11px] text-ink-muted">seconds</span>
        </div>
      </section>
    </div>
  );
}

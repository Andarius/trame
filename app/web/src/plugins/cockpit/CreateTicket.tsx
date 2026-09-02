import { useEffect, useState } from "react";

type State =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; reference: string; created: boolean }
  | { kind: "error"; detail: string };

/**
 * Push a Trame page into Cockpit as a ticket.
 *
 * Explicit and per-page on purpose: this files a row in a shared team tracker,
 * so it must never be a side effect of mapping a project. The button only
 * appears where it can work — a page under a mapped project that is not
 * already a ticket — because an action that always fails is worse than none.
 */
export function CreateTicket(
  { pageId, parentId, alreadySynced, onDone }: {
    pageId: string;
    parentId: string | null;
    /** the page already carries a Cockpit reference */
    alreadySynced: boolean;
    onDone: () => void;
  },
) {
  const [mapped, setMapped] = useState<string[]>([]);
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    setState({ kind: "idle" });
    fetch("/api/plugins/cockpit/settings")
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((s: { projects?: { pageId?: string }[] }) =>
        setMapped((s.projects ?? []).map((p) => p.pageId ?? "").filter(Boolean))
      )
      .catch(() => {});
  }, [pageId]);

  if (alreadySynced || !parentId || !mapped.includes(parentId)) return null;

  const create = () => {
    setState({ kind: "busy" });
    fetch("/api/plugins/cockpit/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageId }),
    })
      .then((r) => r.json())
      .then((d: { reference?: string; created?: boolean; error?: string }) => {
        if (d.error || !d.reference) {
          setState({ kind: "error", detail: d.error ?? "failed" });
          return;
        }
        setState({
          kind: "done",
          reference: d.reference,
          created: d.created !== false,
        });
        onDone();
      })
      .catch((e) =>
        setState({ kind: "error", detail: String(e?.message ?? e) })
      );
  };

  if (state.kind === "done") {
    return (
      <span className="text-[11px] text-ink-muted">
        {
          /* `created: false` means the server recognised this page and returned
            the ticket it already made — a retry, not a duplicate. */
        }
        {state.created ? "Created " : "Already "}
        <code className="text-ink-soft">{state.reference}</code>
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={state.kind === "busy"}
        onClick={create}
        title="Create this page as a Cockpit ticket"
        className="shrink-0 whitespace-nowrap rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-muted hover:text-ink-soft disabled:opacity-60"
      >
        {state.kind === "busy" ? "…" : "⌗ Create in Cockpit"}
      </button>
      {state.kind === "error" && (
        <span className="text-[11px] text-blocked">{state.detail}</span>
      )}
    </div>
  );
}

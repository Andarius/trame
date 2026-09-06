import { useEffect, useState } from "react";

type State =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; reference: string; created: boolean }
  | { kind: "error"; detail: string };

type Mapping = {
  pageId?: string;
  /** the tag key a page must carry — resolved server-side, cf. settingsView */
  tagKey?: string;
  /** how that tag reads, e.g. `cockpit:devops` */
  tagLabel?: string;
};

/**
 * A page's standing with Cockpit: a way in when it is filed, an offer to file
 * it when it is tagged for a mapped scope, nothing otherwise.
 *
 * One slot for both, because they are the same question asked before and
 * after. The tag is the intent: nothing is offered until you say, by tagging,
 * that this page belongs to a product Cockpit knows — and it stays an OFFER
 * rather than an automatic push, since filing a row in a shared team tracker
 * should not be a side effect of a gesture you might be using for your own
 * filing.
 */
export function CockpitTicket(
  { pageId, parentId, tags, reference, onDone }: {
    pageId: string;
    parentId: string | null;
    tags: string[];
    /** the Cockpit reference this page already carries, if any */
    reference: string | null;
    onDone: () => void;
  },
) {
  const [slice, setSlice] = useState<
    { baseUrl?: string; projects?: Mapping[]; enabled?: boolean } | null
  >(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setState({ kind: "idle" });
    setDismissed(false);
    fetch("/api/plugins/cockpit/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then(setSlice)
      .catch(() => {});
  }, [pageId]);

  const baseUrl = slice?.baseUrl?.replace(/\/+$/, "") ?? "";
  // Freshly filed counts as filed: the mark is on the page, but this component
  // was handed the content from before the write.
  const ref = state.kind === "done" ? state.reference : reference;

  if (ref) {
    if (!baseUrl) return null;
    return (
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-muted">
        <a
          href={`${baseUrl}/ticket/${encodeURIComponent(ref)}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-ink-soft transition-colors hover:border-chipline"
        >
          ⌗ Open in Cockpit <code className="text-ink-muted">{ref}</code> ↗
        </a>
        {
          /* `created: false` means the server recognised this page and returned
            the ticket it had already made — a retry, not a duplicate. */
        }
        {state.kind === "done" && !state.created && <span>already filed</span>}
      </div>
    );
  }

  if (dismissed || !parentId) return null;

  // The mapping that governs this page, and the tag it resolved to. Gated on
  // the plugin being on: /create is, so the button would only ever fail.
  const mapping = slice?.enabled
    ? slice.projects?.find((m) => m.pageId === parentId)
    : undefined;
  if (!mapping?.tagKey || !tags.includes(mapping.tagKey)) return null;

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

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-chipline px-2.5 py-1.5 text-[11.5px] text-ink-muted">
      <span>
        Tagged <code className="text-ink-soft">{mapping.tagLabel}</code>{" "}
        — file it as a Cockpit ticket?
      </span>
      <button
        type="button"
        disabled={state.kind === "busy"}
        onClick={create}
        className="rounded-md border border-line px-2 py-0.5 text-ink-soft hover:border-chipline disabled:opacity-60"
      >
        {state.kind === "busy" ? "…" : "⌗ File it"}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="text-ink-muted/70 hover:text-ink-soft"
        title="Not this page"
      >
        ✕
      </button>
      {state.kind === "error" && (
        <span className="text-blocked">{state.detail}</span>
      )}
    </div>
  );
}

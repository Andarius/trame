import { useEffect, useState } from "react";

type State =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; reference: string; created: boolean }
  | { kind: "error"; detail: string };

type Mapping = {
  product?: string;
  flow?: string;
  pageId?: string;
  tag?: string;
};

/**
 * Offer to file this page as a Cockpit ticket, once it is tagged for a mapped
 * scope.
 *
 * The tag is the intent: nothing appears until you say, by tagging, that this
 * page belongs to a product Cockpit knows. It stays an OFFER rather than an
 * automatic push — filing a row in a shared team tracker should not be a side
 * effect of a gesture you might be using for your own filing.
 *
 * Never shown on a page that already carries a reference. The mirror tags the
 * pages it creates with the very same key, so without that guard a mirrored
 * ticket would offer to file itself a second time.
 */
export function CreateTicket(
  { pageId, parentId, tags, alreadySynced, onDone }: {
    pageId: string;
    parentId: string | null;
    tags: string[];
    /** the page already carries a Cockpit reference */
    alreadySynced: boolean;
    onDone: () => void;
  },
) {
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setState({ kind: "idle" });
    setDismissed(false);
    fetch("/api/plugins/cockpit/settings")
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((s: { projects?: Mapping[] }) => setMappings(s.projects ?? []))
      .catch(() => {});
  }, [pageId]);

  if (state.kind === "done") {
    return (
      <div className="text-[11px] text-ink-muted">
        {
          /* `created: false` means the server recognised this page and returned
            the ticket it had already made — a retry, not a duplicate. */
        }
        {state.created ? "Filed as " : "Already filed as "}
        <code className="text-ink-soft">{state.reference}</code>
      </div>
    );
  }

  if (alreadySynced || dismissed || !parentId) return null;

  // The mapping that governs this page, and the tag it was configured with —
  // the scope's own slug when none was given.
  const mapping = mappings.find((m) => m.pageId === parentId);
  const slug = mapping
    ? (mapping.tag?.trim() || mapping.product || mapping.flow || "")
    : "";
  if (!slug || !tags.includes(slug)) return null;

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
        Tagged <code className="text-ink-soft">{slug}</code>{" "}
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

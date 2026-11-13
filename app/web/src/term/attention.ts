// an agent session running in a Trame shell; `named` = the user set its name with /rename,
// `waiting` = what it asks you for (Claude's permission or input prompt), null when it does not
export type TermSession = {
  term: string;
  agent: string;
  id: string;
  name: string | null;
  named: boolean;
  busy: boolean;
  waiting: string | null;
  started_at: number | null; // epoch ms, Claude only
};

// shells to flag as finished: an agent going from busy to idle joins, one busy again or gone leaves
export function nextUnseen(prev: TermSession[], next: TermSession[], unseen: ReadonlySet<string>): ReadonlySet<string> {
  const wasBusy = new Set(prev.filter((s) => s.busy).map((s) => s.term));
  const idle = new Set(next.filter((s) => !s.busy).map((s) => s.term));
  const out = new Set([...unseen].filter((t) => idle.has(t)));
  for (const t of idle) if (wasBusy.has(t)) out.add(t);
  return out;
}

// why these shells need you, if they do: an agent asking something first, else one that finished unseen
export function needsYou(shells: (TermSession | undefined)[], unseen: ReadonlySet<string>): string | null {
  const asking = shells.find((s) => s?.waiting)?.waiting;
  if (asking) return `needs you: ${asking}`;
  return shells.some((s) => s && unseen.has(s.term)) ? "finished" : null;
}

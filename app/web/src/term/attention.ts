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
  updated_at: number | null; // epoch ms of its last status change, Claude only
  done: boolean; // idle, and its last reply ended with "Follow-ups: none"
  follow_ups?: string[] | null; // idle: the items of its last reply's follow-ups list
  model?: string | null; // its latest reply's model (`claude-opus-5-5`), Claude only
  workers?: { pid: number; agent: string; model: string | null; cwd: string | null }[]; // headless runs it started (`codex exec`)
  asleep?: boolean; // restored at launch, resumes when its shell is first shown
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

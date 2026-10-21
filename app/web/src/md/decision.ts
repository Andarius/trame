// `decision` fences: a question for a human, options one per line with an optional
// trailing `| recommended`, marks on their own line. Pure — md-diagrams.tsx renders it.
//
//   Grafana path saas-dev → saas-ops
//   ingest port grafana-api (like tempo-ingest) | recommended
//   no Grafana in v1
//   {{trame:ask=@julien}} {{trame:due=2026-10-22}}
//
// Picking an option appends `{{trame:answer=<option>}}` (plus answered_by and
// completed_at) on the marks line, so the answer lives in the page like every mark.
import { readMarks, stripMarks, todayMark } from "../../../../core/todo-marks.ts";

export type DecisionOption = { label: string; recommended: boolean };
export type Decision = {
  question: string;
  options: DecisionOption[];
  marks: Record<string, string>; // ask, due, answer, answered_by, completed_at, …
};

const MARK_LINE = /^\s*(\{\{trame:[a-z_][a-z0-9_]*=[^{}\n]*\}\}\s*)+$/;

export function parseDecision(text: string): Decision {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
  const marks = readMarks(text);
  const content = lines.filter((l) => !MARK_LINE.test(l)).map((l) => stripMarks(l).trim());
  const [question = "", ...rest] = content;
  const options = rest.map((l) => {
    const parts = l.split("|").map((x) => x.trim());
    const recommended = parts.length > 1 && parts[parts.length - 1].toLowerCase() === "recommended";
    if (recommended) parts.pop();
    return { label: parts.join(" | "), recommended };
  });
  return { question, options, marks };
}

// The fence text with the answer recorded: the marks line gains `answer`, `answered_by`
// and `completed_at`; an earlier answer is replaced. Content lines are untouched.
export function answerDecision(text: string, option: string, by: string, day = todayMark()): string {
  const lines = text.split("\n");
  const kept = lines.filter((l) => !MARK_LINE.test(l.trim()));
  const marks = readMarks(text);
  delete marks.answer;
  delete marks.answered_by;
  delete marks.completed_at;
  const next = { ...marks, answer: option, answered_by: by, completed_at: day };
  const markLine = Object.entries(next).map(([k, v]) => `{{trame:${k}=${v}}}`).join(" ");
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return [...kept, markLine].join("\n");
}

export const isDecisionFence = (text: string): boolean => /^\s*```\s*decision\s*$/m.test(text);

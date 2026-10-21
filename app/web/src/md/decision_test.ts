import { expect, test } from "bun:test";
import { answerDecision, parseDecision } from "./decision.ts";

const FENCE = `
// a comment line
Grafana path saas-dev → saas-ops
ingest port grafana-api (like tempo-ingest) | recommended
no Grafana in v1
a | b | recommended
{{trame:ask=@julien}} {{trame:due=2026-10-22}}
`;

test("parseDecision: question, options with a trailing recommended, marks on their own line", () => {
  expect(parseDecision(FENCE)).toStrictEqual({
    question: "Grafana path saas-dev → saas-ops",
    options: [
      { label: "ingest port grafana-api (like tempo-ingest)", recommended: true },
      { label: "no Grafana in v1", recommended: false },
      // the label keeps its own pipes
      { label: "a | b", recommended: true },
    ],
    marks: { ask: "@julien", due: "2026-10-22" },
    multi: false,
    answers: [],
  });
});

test("multi: pick=many joins the picks, a free-text answer is cleaned and kept as one entry", () => {
  const fence = "Which channels?\n#it-alerts\n#agents\n{{trame:pick=many}}";
  const answered = answerDecision(fence, ["#agents", " both, {and} a\nnote "], "julien", "2026-10-21");
  expect(answered.split("\n").at(-1)).toBe(
    "{{trame:pick=many}} {{trame:answer=#agents ; both, and a note}} {{trame:answered_by=julien}} {{trame:completed_at=2026-10-21}}",
  );
  const d = parseDecision(answered);
  expect(d.multi).toBe(true);
  expect(d.answers).toStrictEqual(["#agents", "both, and a note"]);
  // single mode keeps the separator inside one answer
  expect(parseDecision(answerDecision("Q?\na\nb", "a ; b", "x", "2026-10-21")).answers).toStrictEqual(["a ; b"]);
});

test("answerDecision: writes answer, answered_by and completed_at, replacing an earlier answer", () => {
  const once = answerDecision(FENCE, "no Grafana in v1", "julien", "2026-10-21");
  expect(once.split("\n").at(-1)).toBe(
    "{{trame:ask=@julien}} {{trame:due=2026-10-22}} {{trame:answer=no Grafana in v1}} {{trame:answered_by=julien}} {{trame:completed_at=2026-10-21}}",
  );
  expect(parseDecision(once).options.map((o) => o.label)).toStrictEqual([
    "ingest port grafana-api (like tempo-ingest)",
    "no Grafana in v1",
    "a | b",
  ]);
  const twice = answerDecision(once, "a | b", "carlo", "2026-10-22");
  expect(parseDecision(twice).marks).toStrictEqual({
    ask: "@julien",
    due: "2026-10-22",
    answer: "a | b",
    answered_by: "carlo",
    completed_at: "2026-10-22",
  });
});

test("answerDecision: a fence without a marks line gains one", () => {
  expect(answerDecision("Which bot?\nsoren_alerts\nspatchou\n", "spatchou", "julien", "2026-10-21")).toBe(
    "Which bot?\nsoren_alerts\nspatchou\n{{trame:answer=spatchou}} {{trame:answered_by=julien}} {{trame:completed_at=2026-10-21}}",
  );
});

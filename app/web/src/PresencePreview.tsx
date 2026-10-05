import type { AgentPresenceSettings, LiveAgent } from "./api";
import { type Live, LiveLine, LiveRail, liveRingCls, liveRowCls, LiveTrail } from "./agents";

const now = Date.now();
const sample = (a: Partial<LiveAgent>): LiveAgent => ({
  session_id: "",
  state: "working",
  harness: "",
  icon: null,
  provider: null,
  model: null,
  tokens: null,
  context_max: null,
  step: null,
  question: null,
  page_id: null,
  block_id: null,
  since: now,
  at: now,
  session_title: "",
  links: [],
  ...a,
});

const SAMPLES: (Live & { text: string })[] = [
  {
    text: "SSE AES-256 on every S3 bucket, in tofu",
    state: "working",
    a: sample({
      harness: "claude-code",
      provider: "Anthropic",
      model: "Opus 5.5",
      tokens: 48_213,
      context_max: 200_000,
      step: "Edit tofu/modules/s3/main.tf",
      since: now - 252_000,
      at: now - 12_000,
      session_title: "s3-sse",
    }),
  },
  {
    text: "k3s secrets encryption in etcd",
    state: "waiting",
    a: sample({
      state: "waiting",
      harness: "codex",
      provider: "OpenAI",
      model: "gpt-5.5-codex",
      tokens: 131_904,
      context_max: 200_000,
      question: "rotate the existing secrets now or at next deploy?",
      since: now - 18 * 60_000,
      session_title: "k3s-etcd",
    }),
  },
];

// Sample todo rows rendered by the same pieces as page todos, with unsaved settings.
export function PresencePreview({ p }: { p: AgentPresenceSettings }) {
  return (
    <div className="rounded-lg border border-line bg-canvas px-1 py-1.5">
      {SAMPLES.map((s) => (
        <div key={s.text} className={`group relative flex items-start gap-2 py-0.5 pl-6 pr-2.5 text-[14px] ${liveRowCls(s.state, p)}`}>
          <LiveRail state={s.state} cfg={p} />
          <span
            className={`mt-[7px] h-3 w-3 shrink-0 rounded-full border-[1.5px] ${liveRingCls(s.state, p) ?? "border-copper"}`}
          />
          <div className="min-w-0 flex-1">
            <div className="py-1 text-ink">{s.text}</div>
            <LiveLine a={s.a} state={s.state} cfg={p} />
          </div>
          <LiveTrail a={s.a} state={s.state} cfg={p} />
        </div>
      ))}
      <div className="flex items-start gap-2 py-0.5 pl-6 pr-2.5 text-[14px]">
        <span className="mt-[7px] h-3 w-3 shrink-0 rounded-full border-[1.5px] border-copper" />
        <span className="py-1 text-ink">Falco + Falcosidekick to Alertmanager</span>
      </div>
    </div>
  );
}

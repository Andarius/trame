import { useEffect, useState } from "react";

// Who handed me a mirrored Cockpit ticket: the plugin keeps it per card id.
export type Assigner = { name: string; avatar: string | null };

let cache: { at: number; p: Promise<Record<string, Assigner>> } | null = null;
const load = () => {
  if (!cache || Date.now() - cache.at > 60_000) {
    cache = {
      at: Date.now(),
      // plugin off or not polled yet: nobody
      p: fetch("/api/plugins/cockpit/assigners").then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    };
  }
  return cache.p;
};

export function useAssigner(cardId: string): Assigner | null {
  const [a, setA] = useState<Assigner | null>(null);
  useEffect(() => {
    let live = true;
    load().then((m) => live && setA(m[cardId] ?? null));
    return () => {
      live = false;
    };
  }, [cardId]);
  return a;
}

export function AssignerAvatar({ a, size = 16 }: { a: Assigner; size?: number }) {
  const style = { width: size, height: size };
  return a.avatar
    ? <img src={a.avatar} alt={a.name} style={style} className="shrink-0 rounded-full object-cover" />
    : (
      <span
        style={{ ...style, fontSize: size * 0.5 }}
        className="flex shrink-0 items-center justify-center rounded-full bg-chipline font-medium text-ink"
      >
        {a.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
      </span>
    );
}

/** The assigner's face, for card rows and tiles; nothing on my own cards. */
export function AssignedBy({ cardId, size }: { cardId: string; size?: number }) {
  const a = useAssigner(cardId);
  return a && (
    <span title={`Assigned by ${a.name} in Cockpit`} className="inline-flex shrink-0">
      <AssignerAvatar a={a} size={size} />
    </span>
  );
}

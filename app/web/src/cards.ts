// `cards` fences: a KPI row, one `value | label` per line with an optional trailing
// color. Pure — md.tsx renders it, this file only parses.
//
//   154 | PRs merged | green
//   −1 011 €/month | legacy bill
export const CARD_COLORS: Record<string, string> = {
  green: "border-active/40 bg-active/[0.07] text-active",
  yellow: "border-paused/40 bg-paused/[0.07] text-paused",
  red: "border-blocked/40 bg-blocked/[0.07] text-blocked",
  copper: "border-copper/40 bg-copper/[0.07] text-copper",
  gray: "border-chipline bg-panel text-ink",
};

export type Card = { value: string; label: string; color: string | null };

export function parseCards(text: string): Card[] {
  return text.split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .map((l) => {
      const parts = l.split("|").map((x) => x.trim());
      // a trailing color needs a label before it — `1 | red` is a card labelled "red"
      const color = parts.length > 2 && parts[parts.length - 1] in CARD_COLORS
        ? parts.pop()!
        : null;
      const [value, ...rest] = parts;
      return { value, label: rest.join(" | "), color };
    });
}

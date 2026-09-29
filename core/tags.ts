export const tagKey = (label: string) =>
  label.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// The tag palette — the four status hues plus five neighbours. Each one is picked
// to stay legible BOTH as a tint on the light canvas and as a tint on the dark one,
// since a pill mixes the hue with the current ink rather than storing two colours.
export const TAG_COLORS = [
  "#6b7280", // slate
  "#c98a63", // copper
  "#e3c567", // amber
  "#7bd88f", // green
  "#5fc2b0", // teal
  "#6aa9e0", // blue
  "#a78bd8", // violet
  "#dd8ab8", // pink
  "#e06c75", // red
] as const;

/**
 * The colour a tag gets when nobody picked one.
 *
 * Hashed from the key rather than counted, so two nodes that create the same tag
 * offline land on the same hue — a counter would have them disagree and let LWW
 * flip the colour back and forth on every sync.
 */
export function tagColor(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length];
}

/**
 * Split a label on its first ":" — `cockpit:devops` reads as a namespace and a
 * value, and the pill dims the half that repeats on every tag from that source.
 */
export function splitTagLabel(
  label: string,
): { ns: string | null; value: string } {
  const i = label.indexOf(":");
  if (i <= 0 || i === label.length - 1) return { ns: null, value: label };
  return { ns: label.slice(0, i).trim(), value: label.slice(i + 1).trim() };
}

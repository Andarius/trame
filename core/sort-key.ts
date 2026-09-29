// Fractional order keys: returns a key strictly between a and b ("" = ±infinity).
// Generated keys never end on the alphabet's first char, so there is always room.
const AB = "0123456789abcdefghijklmnopqrstuvwxyz";
export function midKey(a: string, b: string): string {
  let i = 0, res = "";
  while (true) {
    const ca = i < a.length ? AB.indexOf(a[i]) : 0;
    const cb = i < b.length ? AB.indexOf(b[i]) : AB.length;
    if (ca === cb) {
      res += AB[ca];
      i++;
      continue;
    }
    if (cb - ca > 1) return res + AB[(ca + cb) >> 1];
    // adjacent digits: keep a's digit, then midpoint between the rest of a and +inf
    res += AB[ca];
    i++;
    while (true) {
      const c = i < a.length ? AB.indexOf(a[i]) : 0;
      if (AB.length - c > 1) return res + AB[(c + AB.length) >> 1];
      res += AB[c];
      i++;
    }
  }
}

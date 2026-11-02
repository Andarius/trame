// Image paths a shell printed (`/abs/x.png`, `~/x.png`, `file:///x.png`), with their columns in the line
export type ImageLink = { path: string; start: number; end: number };

const IMAGE = /(?<![\w./~:-])(file:\/\/)?((?:~\/|\/)[^\s'"`<>()[\]]*?\.(?:png|jpe?g|gif|webp|svg))(?![\w.-])/gi;

export function imageLinks(line: string): ImageLink[] {
  const out: ImageLink[] = [];
  for (const m of line.matchAll(IMAGE)) {
    let path = m[2];
    if (m[1]) {
      try {
        path = decodeURIComponent(path);
      } catch { /* not percent-encoded: keep as printed */ }
    }
    out.push({ path, start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

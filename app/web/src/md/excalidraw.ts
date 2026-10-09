// Renders a .excalidraw scene (JSON) into a standalone HTML document holding a
// static SVG, so the sandboxed preview iframe (scripts disabled) can display it.
// The excalidraw package is heavy — loaded lazily, Vite splits it into its own chunk.

// Fonts are inlined into the SVG from this CDN; offline the text falls back to
// system fonts (shapes render fine either way).
declare global {
  var EXCALIDRAW_ASSET_PATH: string | undefined;
}
globalThis.EXCALIDRAW_ASSET_PATH ??= "https://unpkg.com/@excalidraw/excalidraw@0.18.1/dist/prod/";

let mod: Promise<typeof import("@excalidraw/excalidraw")> | null = null;
const lib = () =>
  (mod ??= import("@excalidraw/excalidraw").catch((e) => {
    mod = null; // don't cache the failure — let the next render retry
    throw e;
  }));

export async function excalidrawToHtml(jsonText: string, title: string): Promise<string> {
  const { exportToSvg, restore } = await lib();
  // restore() fills in whatever fields the file is missing (hand-written scenes)
  const scene = restore(JSON.parse(jsonText), null, null);
  const svg = await exportToSvg({
    elements: scene.elements,
    appState: { ...scene.appState, exportBackground: true, exportEmbedScene: false },
    files: scene.files ?? null,
    exportPadding: 24,
  });
  svg.style.maxWidth = "100%";
  svg.style.height = "auto";
  const esc = title.replace(/</g, "&lt;");
  return `<!doctype html><meta charset="utf-8"><title>${esc}</title>` +
    `<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f5f2">${svg.outerHTML}</body>`;
}

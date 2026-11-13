// How big the terminal's image hover preview gets. Persisted per-machine, not synced.
import { readStore, writeStore } from "../ui/storage";

const KEY = "trame:termPreviewSize";

export const PREVIEW_SIZES = {
  small: { label: "Small", w: 320, h: 240 },
  medium: { label: "Medium", w: 640, h: 480 },
  large: { label: "Large", w: 960, h: 720 },
  xl: { label: "Extra large", w: 1440, h: 1080 },
} as const;
export type PreviewSize = keyof typeof PREVIEW_SIZES;

export function getPreviewSize(): PreviewSize {
  const v = readStore(KEY);
  return v && v in PREVIEW_SIZES ? (v as PreviewSize) : "large";
}

export const setPreviewSize = (size: PreviewSize) => writeStore(KEY, size);

// the box the thumbnail fits in, kept inside the window
export function previewBox() {
  const { w, h } = PREVIEW_SIZES[getPreviewSize()];
  return { w: Math.min(w, Math.round(innerWidth * 0.9)), h: Math.min(h, Math.round(innerHeight * 0.85)) };
}

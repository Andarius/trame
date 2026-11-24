// Keys a shell receives as other input, like Konsole's Ctrl+Shift+U → Ctrl+U. Persisted per-machine, not synced.
import { readStore, writeStore } from "../ui/storage";

const KEY = "trame:termKeyBindings";

export type KeyBinding = { keys: string; send: string };

export const DEFAULT_BINDINGS: readonly KeyBinding[] = [{ keys: "Ctrl+Shift+U", send: "^U" }];

let cache: KeyBinding[] | null = null;

export function getKeyBindings(): KeyBinding[] {
  if (cache) return cache;
  try {
    const v = JSON.parse(readStore(KEY) ?? "null");
    cache = Array.isArray(v)
      ? v.filter((b): b is KeyBinding => typeof b?.keys === "string" && typeof b?.send === "string")
      : [...DEFAULT_BINDINGS];
  } catch {
    cache = [...DEFAULT_BINDINGS];
  }
  return cache;
}

export function setKeyBindings(bindings: KeyBinding[]) {
  cache = bindings;
  writeStore(KEY, JSON.stringify(bindings));
}

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"]);

// "Ctrl+Shift+U" for a key event; null for a lone modifier
export function comboOf(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  if (MODIFIERS.has(e.key)) return null;
  const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta", key].filter(Boolean).join("+");
}

// what the shell gets: ^X caret notation (chords like ^X^S), or text with \e \n \r \t \xHH \\ escapes
export function decodeSend(s: string): string {
  if (/^(\^[@-_?a-z])+$/i.test(s)) {
    return s.replace(/\^(.)/g, (_, c: string) => (c === "?" ? "\x7f" : String.fromCharCode(c.toUpperCase().charCodeAt(0) ^ 0x40)));
  }
  return s.replace(/\\(x[0-9a-fA-F]{2}|[enrt\\])/g, (_, c: string) =>
    c[0] === "x"
      ? String.fromCharCode(parseInt(c.slice(1), 16))
      : ({ e: "\x1b", n: "\n", r: "\r", t: "\t", "\\": "\\" } as Record<string, string>)[c]);
}

// for attachCustomKeyEventHandler: true when `e` is a bound key, its input sent through `input`
export function termBindingKey(e: KeyboardEvent, input: (data: string) => void): boolean {
  const combo = comboOf(e);
  const hit = combo && getKeyBindings().find((b) => b.keys === combo && b.send);
  if (!hit) return false;
  e.preventDefault();
  if (e.type === "keydown") input(decodeSend(hit.send));
  return true;
}

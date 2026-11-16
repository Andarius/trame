import { expect, test } from "bun:test";
import { comboOf, decodeSend } from "./key-bindings.ts";

const ev = (key: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
  key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
});

test.each([
  [ev("U", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+U"],
  [ev("u", { ctrlKey: true }), "Ctrl+U"],
  [ev("ArrowLeft", { altKey: true }), "Alt+ArrowLeft"],
  [ev(" ", { ctrlKey: true }), "Ctrl+Space"],
  [ev("Shift", { shiftKey: true }), null],
])("comboOf %#", (e, combo) => expect(comboOf(e)).toBe(combo));

test.each([
  ["^U", "\x15"],
  ["^u", "\x15"],
  ["^[", "\x1b"],
  ["^?", "\x7f"],
  ["\\eb", "\x1bb"],
  ["git status\\r", "git status\r"],
  ["\\x01\\\\", "\x01\\"],
  ["^UU", "^UU"],
])("decodeSend %p", (s, out) => expect(decodeSend(s)).toBe(out));

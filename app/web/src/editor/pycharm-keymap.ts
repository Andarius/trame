// PyCharm actions → CodeMirror commands, and PyCharm keystrokes ("shift ctrl UP") → CodeMirror keys.
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorMatchingBracket,
  deleteLine,
  indentLess,
  indentMore,
  insertBlankLine,
  moveLineDown,
  moveLineUp,
  redo,
  selectAll,
  selectLine,
  selectParentSyntax,
  simplifySelection,
  toggleBlockComment,
  toggleLineComment,
  undo,
} from "@codemirror/commands";
import { foldCode, unfoldCode } from "@codemirror/language";
import { findNext, findPrevious, gotoLine, openSearchPanel, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { EditorSelection } from "@codemirror/state";
import type { Command, KeyBinding } from "@codemirror/view";

const toggleCase: Command = (view) => {
  const changes = view.state.changeByRange((range) => {
    const r = range.empty ? view.state.wordAt(range.head) ?? range : range;
    const text = view.state.sliceDoc(r.from, r.to);
    const insert = text === text.toUpperCase() ? text.toLowerCase() : text.toUpperCase();
    return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.range(r.from, r.to) };
  });
  view.dispatch(changes, { userEvent: "input" });
  return true;
};

const joinLines: Command = (view) => {
  const changes = view.state.changeByRange((range) => {
    const line = view.state.doc.lineAt(range.head);
    if (line.number >= view.state.doc.lines) return { range };
    const next = view.state.doc.line(line.number + 1);
    const lead = /^\s*/.exec(next.text)?.[0].length ?? 0;
    return { changes: { from: line.to, to: next.from + lead, insert: " " }, range: EditorSelection.cursor(line.to) };
  });
  view.dispatch(changes, { userEvent: "input" });
  return true;
};

/** The PyCharm actions a cell editor understands. */
export const ACTIONS: Record<string, Command> = {
  CommentByLineComment: toggleLineComment,
  CommentByBlockComment: toggleBlockComment,
  EditorDuplicate: copyLineDown,
  EditorDuplicateLines: copyLineDown,
  EditorDeleteLine: deleteLine,
  MoveLineUp: moveLineUp,
  MoveLineDown: moveLineDown,
  MoveStatementUp: moveLineUp,
  MoveStatementDown: moveLineDown,
  EditorSelectWord: selectParentSyntax,
  EditorUnSelectWord: simplifySelection,
  EditorSelectLine: selectLine,
  SelectNextOccurrence: selectNextOccurrence,
  SelectAllOccurrences: selectSelectionMatches,
  EditorCloneCaretAbove: addCursorAbove,
  EditorCloneCaretBelow: addCursorBelow,
  EditorIndentSelection: indentMore,
  EditorUnindentSelection: indentLess,
  EditorStartNewLine: insertBlankLine,
  EditorJoinLines: joinLines,
  EditorToggleCase: toggleCase,
  EditorMatchBrace: cursorMatchingBracket,
  EditorLineStart: cursorLineBoundaryBackward,
  EditorLineEnd: cursorLineBoundaryForward,
  CollapseRegion: foldCode,
  ExpandRegion: unfoldCode,
  Find: openSearchPanel,
  Replace: openSearchPanel,
  FindNext: findNext,
  FindPrevious: findPrevious,
  GotoLine: gotoLine,
  $Undo: undo,
  $Redo: redo,
  $SelectAll: selectAll,
  EditorDuplicateUp: copyLineUp,
};

const KEYS: Record<string, string> = {
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  slash: "/", divide: "/", back_slash: "\\", open_bracket: "[", close_bracket: "]",
  minus: "-", subtract: "-", equals: "=", add: "+", plus: "+", comma: ",", period: ".",
  semicolon: ";", colon: ":", quote: "'", back_quote: "`", multiply: "*",
  space: "Space", enter: "Enter", tab: "Tab", escape: "Escape", back_space: "Backspace",
  delete: "Delete", home: "Home", end: "End", page_up: "PageUp", page_down: "PageDown", insert: "Insert",
};
const MODS: Record<string, string> = { ctrl: "Ctrl", control: "Ctrl", shift: "Shift", alt: "Alt", meta: "Meta", altgraph: "Alt" };

/** "shift ctrl UP" → "Ctrl-Shift-ArrowUp"; null for keys a browser cannot see (numpad, chords). */
export function toCodeMirrorKey(stroke: string): string | null {
  const parts = stroke.trim().toLowerCase().split(/\s+/);
  const key = parts.pop();
  if (!key) return null;
  const mods = [...new Set(parts.map((p) => MODS[p]).filter(Boolean))];
  if (mods.length !== parts.length) return null;
  const name = KEYS[key] ?? (/^[a-z0-9]$/.test(key) ? key : /^f([1-9]|1[0-2])$/.test(key) ? key.toUpperCase() : null);
  if (!name) return null;
  const order = ["Ctrl", "Alt", "Shift", "Meta"];
  return [...order.filter((m) => mods.includes(m)), name].join("-");
}

/** CodeMirror bindings for an imported keymap; the first action listed for a key wins. */
export function bindingsFor(actions: Record<string, string[]>): KeyBinding[] {
  const out: KeyBinding[] = [];
  const seen = new Set<string>();
  for (const [action, strokes] of Object.entries(actions)) {
    const run = ACTIONS[action];
    if (!run) continue;
    for (const stroke of strokes) {
      const key = toCodeMirrorKey(stroke);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, run, preventDefault: true });
    }
  }
  return out;
}

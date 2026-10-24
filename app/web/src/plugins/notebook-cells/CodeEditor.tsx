// CodeMirror 6 for a python cell: highlighting, auto-indent, bracket matching, run on ⇧⏎/⌘⏎.
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { python, pythonLanguage } from "@codemirror/lang-python";
import { PostgreSQL } from "@codemirror/lang-sql";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers, placeholder as placeholderExt } from "@codemirror/view";
import { parseMixed } from "@lezer/common";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { useCellKeymap } from "./api";
import { bindingsFor } from "./pycharm-keymap";

// A triple-quoted string that reads like a query is parsed as PostgreSQL inside the python tree.
const SQL_START = /^\s*(select|with|insert|update|delete|create|alter|drop|explain|merge)\b/i;
const TRIPLE = /^[rRbBuUfF]{0,2}("""|''')/;
function pythonWithSql(): LanguageSupport {
  const language = pythonLanguage.configure({
    wrap: parseMixed((node, input) => {
      if (node.name !== "String") return null;
      const text = input.read(node.from, node.to);
      const open = TRIPLE.exec(text)?.[0].length;
      if (!open || text.length < open + 3 || !SQL_START.test(text.slice(open, -3))) return null;
      return { parser: PostgreSQL.language.parser, overlay: [{ from: node.from + open, to: node.to - 3 }] };
    }),
  });
  return new LanguageSupport(language, python().support);
}

// Trame's own colour tokens, so the cell follows the theme like the rest of the page.
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--color-chart-7)" },
  { tag: [tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword], color: "var(--color-chart-7)", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--color-chart-3)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--color-chart-4)" },
  { tag: [tags.comment, tags.docString], color: "var(--color-ink-muted)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--color-chart-1)" },
  { tag: [tags.definition(tags.variableName), tags.className, tags.definition(tags.className)], color: "var(--color-chart-2)" },
  { tag: tags.meta, color: "var(--color-chart-5)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--color-ink-soft)" },
  { tag: tags.self, color: "var(--color-chart-5)" },
  { tag: tags.invalid, color: "var(--color-blocked)" },
]);

const theme = EditorView.theme({
  "&": { backgroundColor: "transparent", fontSize: "12px", color: "var(--color-ink)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, monospace)", lineHeight: "1.625", padding: "6px 0" },
  ".cm-content": { padding: "0 12px 0 6px", caretColor: "var(--color-ink)", minHeight: "24px" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--color-ink-faint)", opacity: "0.7" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 10px", minWidth: "28px", fontSize: "10.5px" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 2px", fontSize: "10px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--color-panel)", border: "1px solid var(--color-chipline)", color: "var(--color-ink-muted)", margin: "0 4px", padding: "0 6px", borderRadius: "4px" },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--color-ink)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--color-copper) 28%, transparent)",
  },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--color-copper) 22%, transparent)", outline: "none" },
  ".cm-placeholder": { color: "var(--color-ink-muted)", opacity: "0.5" },
});

export function CodeEditor(
  { value, onChange, onBlur, onRun, onRunNext, onEscape, placeholder = "python…" }: {
    value: string;
    onChange: (v: string) => void;
    onBlur: () => void;
    onRun: () => void;
    onRunNext: () => void;
    onEscape: () => void;
    placeholder?: string;
  },
) {
  const host = useRef<HTMLDivElement | null>(null);
  const imported = useCellKeymap();
  const keys = useRef(new Compartment());
  const view = useRef<EditorView | null>(null);
  // handlers change every render; the editor is built once
  const handlers = useRef({ onChange, onBlur, onRun, onRunNext, onEscape });
  handlers.current = { onChange, onBlur, onRun, onRunNext, onEscape };

  useEffect(() => {
    if (!host.current) return;
    const run = () => {
      handlers.current.onRun();
      return true;
    };
    const state = EditorState.create({
      doc: value,
      extensions: [
        pythonWithSql(),
        history(),
        lineNumbers(),
        foldGutter({ openText: "⌄", closedText: "›" }),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        indentUnit.of("    "),
        EditorView.lineWrapping,
        placeholderExt(placeholder),
        syntaxHighlighting(highlight),
        theme,
        Prec.highest(keymap.of([
          { key: "Mod-Enter", run },
          { key: "Shift-Enter", run: () => (handlers.current.onRunNext(), true) },
          { key: "Escape", run: (v) => (v.contentDOM.blur(), handlers.current.onEscape(), true) },
        ])),
        // imported PyCharm shortcuts sit above the defaults, below running the cell
        keys.current.of(Prec.high(keymap.of(imported ? bindingsFor(imported.actions) : []))),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({ blur: () => handlers.current.onBlur() }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the initial doc only; later values sync below
  }, []);

  // a keymap imported or reset while the cell is open
  useEffect(() => {
    view.current?.dispatch({
      effects: keys.current.reconfigure(Prec.high(keymap.of(imported ? bindingsFor(imported.actions) : []))),
    });
  }, [imported]);

  // a cell edited elsewhere: replace the document without losing the editor
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={host} className="w-full" />;
}

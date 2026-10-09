import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useState } from "react";
import { type Block, getPresence, pingPresence, type Presence } from "../api";
import { blocksToMarkdown } from "./page-serialize";
import { clearSelection } from "../ui/ui";

/** Heartbeat that I'm on the page, and poll who else / which agents are watching. */
export function usePresence(pageId: string) {
  const [presence, setPresence] = useState<Presence[]>([]);
  useEffect(() => {
    const beat = () => {
      if (document.hidden) return;
      pingPresence(pageId);
      getPresence(pageId).then(setPresence).catch(() => {});
    };
    beat();
    const t = setInterval(beat, 8000);
    return () => clearInterval(t);
  }, [pageId]);
  return presence;
}

// "select all → copy" the whole page as Markdown. Blocks are separate textareas, so
// a second Ctrl/⌘+A (or one with nothing focused) selects the page instead of a block;
// a copy while page-selected writes Markdown to the clipboard.
export function usePageSelection(title: string | undefined, blocksRef: { current: Block[] }) {
  const [pageSelected, setPageSelected] = useState(false);
  useEffect(() => {
    if (!pageSelected) return;
    const onCopy = (e: ClipboardEvent) => {
      e.preventDefault();
      e.clipboardData?.setData(
        "text/plain",
        blocksToMarkdown(title ?? "", blocksRef.current),
      );
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, [pageSelected, title]);
  const onPageKeyDown = (e: ReactKeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "a" || e.key === "A")) {
      const el = document.activeElement as HTMLTextAreaElement | null;
      const inTextarea = el?.tagName === "TEXTAREA";
      const fullySelected = inTextarea &&
        el!.selectionStart === 0 && el!.selectionEnd === el!.value.length &&
        el!.value.length > 0;
      // first Ctrl+A selects the focused block (native); a second one selects the page
      if (!inTextarea || fullySelected) {
        e.preventDefault();
        el?.blur();
        clearSelection();
        setPageSelected(true);
      }
    } else if (e.key !== "Meta" && e.key !== "Control") {
      setPageSelected(false); // any other key drops the whole-page selection
    }
  };
  return { pageSelected, setPageSelected, onPageKeyDown };
}

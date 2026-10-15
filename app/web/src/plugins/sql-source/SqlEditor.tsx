import { useRef } from "react";
import { highlightCode } from "../../md/md-highlight";

const TEXT = "px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] whitespace-pre";

/** Transparent textarea over a highlighted <pre>; ⌘/Ctrl+Enter calls `onRun`. */
export function SqlEditor({ value, onChange, onRun, height, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
  height: string;
  placeholder?: string;
}) {
  const pre = useRef<HTMLPreElement>(null);
  return (
    <div className="relative resize-y overflow-hidden rounded-md border border-line bg-panel" style={{ height }}>
      <pre ref={pre} aria-hidden className={`pointer-events-none absolute inset-0 m-0 overflow-hidden pb-6 pr-6 ${TEXT}`}>
        {highlightCode(value, "sql")}
        {"\n"}
      </pre>
      <textarea
        aria-label="Query"
        wrap="off"
        spellCheck={false}
        className={`absolute inset-0 h-full w-full resize-none overflow-auto border-0 bg-transparent text-transparent caret-ink outline-none placeholder:text-ink-muted/50 ${TEXT}`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (!pre.current) return;
          pre.current.scrollTop = e.currentTarget.scrollTop;
          pre.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onRun();
          }
        }}
      />
    </div>
  );
}

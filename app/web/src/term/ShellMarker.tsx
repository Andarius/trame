import { useMemo } from "react";
import { liveCards, useTermDock } from "./term-api";

export function useLiveCards() {
  const { terms } = useTermDock();
  return useMemo(() => liveCards(terms), [terms]);
}

// a card's "a shell is running for it" mark (board tickets, the Terminals view's card list)
export function ShellMarker({ card }: { card: string }) {
  if (!useLiveCards().has(card)) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center rounded border border-chip-active-border bg-chip-active-bg px-1 font-mono text-[9.5px] leading-[14px] text-live"
      title="a terminal is running for this card"
      aria-label="terminal running"
    >
      ›_
    </span>
  );
}

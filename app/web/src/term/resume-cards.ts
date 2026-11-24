import { resumeCommand } from "../api";
import { openTerminal } from "./term-api";

// each card's agent session in its own Trame terminal, like the card's Resume button; returns the cards it could not open
type Card = { id: string; title: string };

export async function resumeInTerminals(cards: Card[]): Promise<Card[]> {
  const failed: Card[] = [];
  for (const card of cards) {
    let r = await resumeCommand(card.id);
    // nothing to resume here: start the card's agent on it, as the card's "Open in" does
    if (!r.ok) r = await resumeCommand(card.id, r.agent ?? "claude");
    try {
      if (!r.ok || !r.repo) throw new Error("no folder here");
      await openTerminal({ cwd: r.repo, command: r.command, title: card.title, card: card.id });
    } catch {
      failed.push(card);
    }
  }
  return failed;
}

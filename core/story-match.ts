// Near-duplicate story titles ("soren-dev cutover" vs "Migration soren-dev"): plain TS
// so the hub's Postgres needs no pg_trgm; candidates are one project's open stories.

// a story this close is the same topic: reuse it instead of minting a twin
export const STORY_REUSE = 0.8; // calibrated on the Soren board: distinct topics peak at 0.72
// below this, titles are unrelated; between the two, suggest but never merge
export const STORY_SUGGEST = 0.5;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "au",
  "aux",
  "d",
  "de",
  "des",
  "du",
  "en",
  "et",
  "for",
  "in",
  "l",
  "la",
  "le",
  "les",
  "of",
  "on",
  "pour",
  "sur",
  "the",
  "to",
  "un",
  "une",
  "vers",
  "with",
]);

export function storyWords(title: string): string[] {
  // ticket ids (GEN-7145) say nothing about the topic
  return title.replace(/\b[A-Z]+-\d+\b/g, " ").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/).filter((w) => w && !STOPWORDS.has(w));
}

function trigrams(words: string[]): Set<string> {
  const s = ` ${words.join(" ")} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

// max of word-set Jaccard and character-trigram Dice, in [0, 1]
export function storySimilarity(a: string, b: string): number {
  const wa = storyWords(a), wb = storyWords(b);
  const sa = new Set(wa), sb = new Set(wb);
  const union = new Set([...sa, ...sb]).size;
  const jaccard = union ? [...sa].filter((w) => sb.has(w)).length / union : 0;
  const ta = trigrams(wa), tb = trigrams(wb);
  const dice = ta.size + tb.size
    ? (2 * [...ta].filter((t) => tb.has(t)).length) / (ta.size + tb.size)
    : 0;
  return Math.max(jaccard, dice);
}

export type StoryCandidate = { id: string; title: string };

// best first, scores rounded to 2 decimals; only candidates at or above `min`
export function similarStories<T extends StoryCandidate>(
  title: string,
  stories: readonly T[],
  min = STORY_SUGGEST,
): (T & { score: number })[] {
  return stories
    .map((s) => ({
      ...s,
      score: Math.round(storySimilarity(title, s.title) * 100) / 100,
    }))
    .filter((s) => s.score >= min)
    .sort((x, y) => y.score - x.score);
}

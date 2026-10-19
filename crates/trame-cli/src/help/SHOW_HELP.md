tramecli show — read a card or a page

  tramecli show <session id | page id | Trame URL> [--events N] [--json]

A card (a session id, or a link with ?view=card&card= or ?session=) prints its fields,
specs and worklog (newest first, N entries, default 20; each line names the agent and
model that wrote it). A page (?page= link, or an id that is not a card) prints its
blocks as Markdown, its sub-pages and the cards anchored to it. --json prints the raw
API response. Reads only — use it instead of raw HTTP to look something up.

# Docs-site notes

General docs rules: follow the global `writing-docs` skill. Repo-specific:

- Load-bearing flows get a designed walkthrough component (see `src/components/SyncFlow.astro`, `DataModelTree.astro`): theme-aware SVG via `--sl-*` variables, uniform node sizes, Starlight `<Tabs>` steppers, short tab labels so they don't wrap.
- Simple or throwaway diagrams stay Mermaid — rendered client-side, config in `astro.config.mjs`.
- Never hand-roll UI Starlight ships (tabs, cards, asides).
- "What shipped when" goes in `src/content/docs/releases/`.
- Node labels use real schema terms (`udb_rows`, `change_log`), not invented shorthand.

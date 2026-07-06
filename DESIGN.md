# Trame design system

Dark-only, dense, keyboard-friendly. The source of truth for tokens is
`app/web/src/styles.css` (`@theme` block); this file documents the system and its mapping
to the Figma file ("Trame — local-first session tracker", page *Components*).

## Palette

| Token | Hex | Use |
|---|---|---|
| `canvas` | `#0c0d10` | app background |
| `sidebar` | `#0a0b0d` | sidebar background |
| `panel` | `#14161b` | column/panel background (modals use `#171923`) |
| `card` | `#1d2129` | session cards |
| `line` | `#232633` | panel borders, dividers |
| `line-soft` | `#1a1d24` | subtle inner dividers |
| `chipline` | `#2f3542` | pill/chip/select borders |
| `ink` | `#e6e9ef` | primary text |
| `ink-soft` | `#a9b2c3` | secondary text |
| `ink-muted` | `#8b93a3` | labels, hints, meta |
| `copper` | `#c98a63` | THE accent: primary buttons, active states, focus |
| `copper-ink` | `#120e0b` | text on copper |
| `active` | `#7bd88f` | status green |
| `paused` | `#e3c567` | status yellow |
| `blocked` | `#e06c75` | status red |
| `done` | `#6b7280` | status grey |

One accent only (copper). Status colors appear exclusively in dots and status text —
never as surfaces.

## Typography

Inter everywhere, tight sizes (px): 10/10.5 labels & meta, 11.5 pills & selects,
12–12.5 body & buttons, 13–13.5 nav & cell text, 15 header titles.
Section labels: 10–10.5px Medium, tracking 0.8px, `ink-muted/80`, UPPERCASE.

## Shape & spacing

- Radius: 6px pills/buttons, 7–8px cards/inputs, 12px modals/panels.
- Borders are 1px, never heavier; elevation via shadows only on overlays.
- Dense spacing: 4–6px inside rows, 8–12px between blocks, 20px modal padding.

## Glyph language

Unicode glyphs instead of an icon font — they inherit text color/size and mix inline
with text (`⎇ master`, `→ next step`), which an SVG icon set can't do cleanly.

| | | | |
|---|---|---|---|
| `▦` sessions | `✦` explore | `◎` project | `□` page |
| `⌗` database | `▸▾` tree / caret | `＋` new | `✕` delete/ignore |
| `↩` restore | `⇣` import | `↻` refresh | `⚙︎` settings |
| `↗` open external | `⤢` expand | `≡` drag | `⊘` exclude |
| `✓` check | `⇄` two-way relation | `⎇` branch | `↑↓` sort |
| `→` next step | `◌` no-icon placeholder | `•` bullet | `—` `…` `·` punctuation |

Rules: always `＋` (fullwidth), never ASCII `+`. Always `⚙︎` (U+2699 U+FE0E) — the bare
gear renders as colored emoji on some webviews. Page glyph is `□` (U+25A1); `▫` is too
faint at 12px.

## Components (code ↔ Figma)

| Code | Figma component | Notes |
|---|---|---|
| primary button (copper) | `Button/Primary` | copper bg, copper-ink text, ⌘↵ hint in modals |
| bordered button | `Button/Secondary` | 1px `line` border, ink-muted text |
| pill / `Select` (ui.tsx) | `Pill` (variants: default, active) | `chipline` border; active = copper border+text |
| `Section label` | `SectionLabel` | sidebar + modal headers |
| sidebar nav row | `NavItem` (variants: default, active) | active = `#1a1d26` bg, copper glyph |
| tree row (PageNode) | `TreeRow` | glyph is a text override (◎/▫/⌗) |
| `NewChip` (App.tsx) | `NewChip` | dashed `chipline` border, ＋ prefix |
| `StatusDot` | `StatusDot` (variants: active/paused/blocked/done) | |
| `Modal` shell (modals.tsx) | `ModalShell` | panel `#171923`, `#323649` border, r12, footer w/ divider |
| Sidebar (App.tsx) | `Sidebar` | composed of the above; screens embed instances |

Figma color variables live in the **Trame** collection, named exactly like the CSS
tokens. When adding UI: pick from these tokens/components first — a new color or
one-off style needs a reason.

## Hard-won rules

- The desktop webview cannot style native widgets: every select, confirm, date input,
  file dialog, and checkbox is custom (see `ui.tsx`, `udb/cells.tsx`). Never introduce a
  native one.
- All overlays live in the Figma *Trame — Overlays* frame; screens are separate frames.
- Keep Figma in sync per change: edit the component master, not per-screen copies.

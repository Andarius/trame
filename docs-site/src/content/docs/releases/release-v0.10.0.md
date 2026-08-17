---
title: "v0.10.0 — sync v3 page tree, AI sessions, database display upgrades"
sidebar:
  label: "v0.10.0"
---

The project is now **trame** (repo, data dir, remote), the legacy
clients/objectives model is gone, and everything anchors to the one pages tree.

## Sync v3 & page tree

- **Sync protocol 3**: the frozen `clients` entity and `objective_id` columns
  are dropped; hubs and other machines must update before sync resumes.
- Sidebar roots split into **Projects / Shared with me / Unfiled**; pages owned
  by another hub user group apart.
- Page writer merges revised Markdown into existing blocks so unchanged blocks
  keep their ids (and comment anchors); pasted-image assets served from
  `/api/assets/<id>`; `/trame:plan-*` commands for the plan feedback loop.
- Project pages roll up sessions from their child stories.

## AI Sessions

- Claude Sessions becomes **AI Sessions**: browse local transcripts from any
  LLM agent CLI, with a source picker, brand icons, per-project colors, and
  one-click filters on project, status, and source.
- Resume is **copy-to-clipboard** of the resume command (terminal launchers
  removed); ghostty/KDE tab quirks fixed along the way.

## Databases

- **Units on numbers** — fixed suffix (`2.1 s`) or resolved per row from a
  sibling select/text column (e.g. a Currency column).
- **Value-dependent color** — fixed swatch, continuous good→bad scale (auto or
  manual range, low/high-is-good), or threshold rules; applied as tinted text,
  pill, dot, cell wash, or the bar/ring fill.
- **Hidden columns per view tab** — ⊟ Columns popover + Hide in the column
  menu; hidden columns keep working in filters, sorts, and formulas.
- **Full-text modal** — text cells expand into a markdown modal with
  click-to-edit.

## Pages & editor

- Markdown rendered in page text blocks; bare PR/MR links become **state
  chips** (GitHub + GitLab via `glab`, including stacked-PR detection).
- Pill color autocomplete when typing `{{` in page blocks.
- **Light mode**.

## Docs & install

- Docs move to an Astro Starlight site (`docs-site/`, `just docs`) with guided
  data-model and sync-flow walkthroughs; release notes live there too.
- Curl-able quickstart script installs the packaged release per platform.

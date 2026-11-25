---
title: "v0.35.4 — Agents view"
sidebar:
  label: "v0.35.4"
---

Shells live in the Agents view, restored agents wait until you open them, and Ctrl+Enter sends now.

## Features

- **Lazy resume.** At launch, each saved shell reopens as a plain shell; its agent resumes the first time you
  open its tab or click its row, shown as "not resumed" until then (#461).
- **Agents view only.** The terminal dock no longer opens at the bottom of other views: opening or revealing a
  shell elsewhere switches to the Agents view on it, on its card when it has one (#464).
- **Ctrl+Enter sends now.** Ctrl+Enter in a terminal sends Claude Code's send-now chord (Ctrl+X Ctrl+S) by
  default (#469).
- **Insights.** Cost, card and flow stats, and a count of reopened cards (#463, #468).

## Fixes

- **Menus.** No scrollbar over the agents sidebar's menus; a project's own window orders its agents like the
  sidebar (#462).

## Other

- Licensed under MIT OR Apache-2.0 (#450); dependency updates (#459); faster release packaging (#467).

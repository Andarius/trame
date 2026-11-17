---
title: "v0.33.0 — Tab menu, numbered todos, sidebar groups"
sidebar:
  label: "v0.33.0"
---

Tidier terminals and ordered checklists in pages.

## Features

- **Close tabs from a menu.** Right-click a terminal tab for **Close other tabs**, **Close tabs to
  the left** and **Close tabs to the right** (#368).
- **Numbered todos.** `1. [ ]` / `1. [x]` lines become numbered to-dos. Ticking one keeps its place
  and number, and the numbers survive export. Type `/` → **Numbered to-do** in the editor (#369).
- **Foldable sidebar groups.** Click a group header in the terminal sidebar to fold it. Idle cards
  (no running agent) sit behind one **N idle** row per group. Both are remembered per machine
  (#370).

## Maintenance

- Dependency updates (#361, #364, #371).

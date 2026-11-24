---
title: "v0.35.2 — Terminal fixes"
sidebar:
  label: "v0.35.2"
---

Fixes for the terminals and the agents sidebar.

## Fixes

- **Key chords.** A key binding can send several control keys: `^X^S` sends Ctrl+X then Ctrl+S
  instead of the literal text (#443).
- **Agents in Trame's shells.** An agent started in a plain Trame shell whose card came later is
  listed under its card, no longer under Outside Trame (#444).
- **Shifted window.** Scrolling the Sessions page can no longer push the whole app up over a black
  band, and the terminal dock is capped to the window's height (#446).
- **Advisors.** A running `/advices` no longer shows its runner logs as extra advisors (#447).

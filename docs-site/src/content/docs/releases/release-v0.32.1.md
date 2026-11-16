---
title: "v0.32.1 — Terminal keys"
sidebar:
  label: "v0.32.1"
---

Terminal shortcuts you can set yourself, starting with Konsole's Ctrl+Shift+U.

## Features

- **Terminal keys.** Settings → General → **Terminal keys** maps a key combination to what the
  shell receives: caret notation (`^U` is Ctrl+U) or text with `\e`, `\n`, `\r`, `\t` and `\xHH`
  escapes. Ctrl+Shift+U → `^U` ships as the default, so it clears the line like in Konsole. Saved
  per machine, applies instantly (#366).

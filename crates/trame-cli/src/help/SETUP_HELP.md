tramecli setup — install the agent skills from this binary

  tramecli setup                   pick targets interactively (TTY only)
  tramecli setup --claude          trame, trame-track, trame-page, trame-watch into ~/.claude/skills
  tramecli setup --codex           the same skills into ~/.agents/skills
  tramecli setup --skills-dir DIR  any Agent Skills directory (repeatable)
  tramecli setup --hook            the git pre-push guard, into the repo you run it from
  tramecli setup --presence        hooks that report agent presence (Claude Code, Codex)
  tramecli setup --mod             a Claude Code band showing this session's Trame card (offers to exit once it is done)

The docs are embedded in the binary and call the bare `tramecli`; when that name is
not on PATH the binary links itself into ~/.local/bin first. From a dev checkout,
`just setup` compiles a fresh binary and runs this.

`--hook` writes the pre-push guard into the repo you run it from (core.hooksPath is
honoured): it refuses a push whose Trame session is missing or older than the commits
being pushed. Bypass one push with `git push --no-verify`.

`--presence` adds `tramecli presence --hook …` to the active Claude Code settings
($CLAUDE_CONFIG_DIR, else ~/.claude) and ~/.codex/hooks.json (whichever exist), so working / waiting / idle show on Trame todos.
Existing hooks are kept; running it twice adds nothing. Codex asks you to trust them.

`--mod` writes a Claude Code mod to ~/.local/share/trame/claude-mod and installs it with
`claude plugin`: above the prompt, the card this session is linked to and an open button.
Open sessions pick it up with /reload-plugins.

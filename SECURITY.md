# Security

## Reporting a vulnerability

Report it privately through [GitHub's vulnerability reporting](https://github.com/Andarius/trame/security/advisories/new),
not in a public issue. Include the version (`tramecli --version` or the app's About), the platform, and the steps to
reproduce. You get an answer within a week; fixes ship in the next patch release with credit unless you ask otherwise.

Only the latest release is supported.

## What Trame touches on your machine

- **Data** lives in `$XDG_DATA_HOME/trame` (default `~/.local/share/trame/`, macOS included): a bundled PostgreSQL 18
  with no TCP port (a mode-700 Unix socket only), settings, and the hub token (`settings.json`, mode 600). The app's
  own API listens on `127.0.0.1`.
- **`tramecli setup`** writes the agent skills to `~/.claude/skills/` (and any `--skills-dir`), links `tramecli`
  into `~/.local/bin`, and, with `--presence`, adds hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`.
  Nothing else in your agent config is changed.
- **Network**: none by default except a release check against the GitHub API every 6 hours
  (`TRACKER_UPDATE_CHECK=0` turns it off). The sync hub, plugins and share links only talk to the network once you
  configure them. There is no telemetry.

## Known trust boundaries

- **HTML blocks** run in a sandboxed iframe with no access to the app's origin or API.
- **`tramecli answer`** feeds page comments to a tool-capable agent. On pages other people can write to, a crafted
  comment is a prompt-injection vector: don't point `--cwd` at a repo holding secrets.
- **The hub** is built for a home LAN: a private CA, per-device bearer tokens, and Postgres with no host port. Put it
  behind a VPN such as Tailscale rather than exposing `:8443` to the internet.

# Hub API parity

Run from the repository root with Python 3.12, OpenSSL, Bun 1.4.5 (the hub image version), Node.js, and PostgreSQL 18 binaries.

```sh
(cd hub/api && bun install --frozen-lockfile)
just link-build
cargo build --locked -p trame-hub
TRAME_PG_BIN=/path/to/postgresql/18/bin python3 hub/parity.py
```

The harness launches a temporary PostgreSQL cluster with two independently seeded databases. It mints tokens with each hub's CLI, sends HTTPS requests using a disposable pinned CA, and compares responses, persisted rows, and ordered `change_log` entries after each request. Generated UUIDs are matched by their first logged write. Timestamps generated during the run are normalized. Any mismatch exits with status `1`.

The rollback case sends invalid page content for a repo with no project. It expects HTTP `400`, one allocated change revision, and zero committed changes to rows or `change_log`. PostgreSQL's identity sequence keeps its allocation after rollback, which proves the request attempted a write.

`POST /api/board` returns `200` and the board in Bun. The Rust allowlist returns `404` because it only exposes `GET /api/board`. A truncated JSON page body returns `400` on both hubs. The error strings come from Bun’s JSON parser and Rust’s serde_json parser. The harness reports both differences.

`--candidate` selects an alternate Rust binary. `--baseline` can launch Bun from another checkout that still contains the legacy server. Use `--candidate-mint` if the alternate launcher needs a different token command. Run `python3 hub/parity.py --help` for details.

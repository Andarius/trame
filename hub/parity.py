# DESCRIPTION: Compare the Bun and Rust hub APIs and their PostgreSQL effects.
# USAGE: TRAME_PG_BIN=/path/to/pg/bin python3 hub/parity.py [--candidate ./target/debug/trame-hub]
import argparse
from collections.abc import Callable, Sequence
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import datetime, timezone
from difflib import unified_diff
from hashlib import sha256
from http.client import HTTPSConnection
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from typing import TypedDict, cast
from uuid import UUID


ROOT = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"
MEMBER = "00000000-0000-4000-8000-000000000101"
GUEST = "00000000-0000-4000-8000-000000000102"
DELETED_GUEST = "00000000-0000-4000-8000-000000000103"
MISSING = "00000000-0000-4000-8000-000000000000"
SEED_TIME = "2000-01-01T00:00:00Z"
TABLES = (
    "users", "devices", "statuses", "pages", "sessions", "session_events", "page_comments", "session_links",
    "udb_databases", "udb_properties",
)
CLOCK_FIELDS = {"at", "created_at", "updated_at", "last_touched", "done_at"}
UUID_TEXT = re.compile(r"\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b", re.IGNORECASE)

type Json = dict[str, Json] | list[Json] | str | int | float | bool | None


class Change(TypedDict):
    rev: int
    entity: str
    row_id: str
    op: str
    at: str
    actor: str | None
    source: str | None


class Snapshot(TypedDict):
    rows: dict[str, list[Json]]
    changes: list[Change]
    revision: int


@dataclass(frozen=True)
class Observation:
    name: str
    expected_status: int
    status: int
    body: Json
    state: Snapshot
    errors: list[str]


def get_protocol() -> str:
    source = (ROOT / "protocol/entities.ts").read_text()
    match = re.search(r"^export const PROTOCOL_VERSION = (\d+);$", source, re.MULTILINE)
    if match is None:
        raise RuntimeError("protocol version is missing from protocol/entities.ts")
    return match[1]


def available_port() -> int:
    with socket.socket() as sock:
        sock.bind((HOST, 0))
        return sock.getsockname()[1]


def run(command: Sequence[str | Path], sql: str | None = None, *, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(command, cwd=ROOT, input=sql, env=env, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError(f"{Path(command[0]).name} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def start(stack: ExitStack, log: Path, command: Sequence[str | Path], env: dict[str, str]) -> subprocess.Popen[bytes]:
    with log.open("wb") as output:
        process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=output, stderr=output)

    def stop() -> None:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    stack.callback(stop)
    return process


def wait_ready(process: subprocess.Popen[bytes], log: Path, probe: Callable[[], bool]) -> None:
    deadline = time.monotonic() + 15
    while process.poll() is None and time.monotonic() < deadline:
        try:
            if probe():
                return
        except ConnectionRefusedError:
            pass
        time.sleep(0.05)
    raise RuntimeError(f"{log.stem} did not start:\n{log.read_text()}")


def postgres(stack: ExitStack, work: Path, pg_bin: Path) -> str:
    port = available_port()
    database = work / "postgres"
    password = secrets.token_hex(32)
    pg_password = work / "pg-password"
    pg_password.write_text(password + "\n")
    run([
        pg_bin / "initdb", "-D", database, "-U", "parity", "-A", "scram-sha-256",
        "--pwfile", pg_password, "--no-locale", "--encoding=UTF8",
    ])
    pg_password.unlink()

    log = work / "postgres.log"
    command = [pg_bin / "postgres", "-D", database, "-h", HOST, "-p", str(port), "-k", ""]
    process = start(stack, log, command, dict(os.environ))

    def listening() -> bool:
        with socket.create_connection((HOST, port), timeout=1):
            return True

    wait_ready(process, log, listening)
    return f"postgres://parity:{password}@{HOST}:{port}"


@dataclass(frozen=True)
class CertificatePaths:
    ca: Path
    cert: Path
    key: Path


def certificate(work: Path) -> CertificatePaths:
    paths = CertificatePaths(work / "ca.crt", work / "server.crt", work / "server.key")
    ca_key, csr, extensions = work / "ca.key", work / "server.csr", work / "server.ext"
    run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=trame-hub-parity-ca", "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", paths.ca, "-keyout", ca_key,
    ])
    run([
        "openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes",
        "-subj", "/CN=trame-hub-parity", "-out", csr, "-keyout", paths.key,
    ])
    extensions.write_text(f"subjectAltName=IP:{HOST}\nextendedKeyUsage=serverAuth\n")
    run([
        "openssl", "x509", "-req", "-days", "1", "-in", csr, "-CA", paths.ca, "-CAkey", ca_key,
        "-CAcreateserial", "-extfile", extensions, "-out", paths.cert,
    ])
    return paths


@dataclass(frozen=True)
class Hub:
    port: int
    psql: Path
    url: str
    tls: ssl.SSLContext
    protocol: str
    tokens: dict[str, str]
    started_at: datetime

    def query(self, sql: str) -> str:
        return run([self.psql, "-XqAt", "-v", "ON_ERROR_STOP=1", "-d", self.url, "-f", "-"], sql)

    def request(
        self, path: str, method: str = "GET", body: Json | bytes = None, token: str | None = "member",
        protocol: str | None = "current",
    ) -> tuple[int, Json]:
        headers = {"content-type": "application/json"}
        if token is not None:
            headers["authorization"] = f"Bearer {self.tokens.get(token, token)}"
        if protocol is not None:
            headers["x-trame-protocol"] = self.protocol if protocol == "current" else protocol
        connection = HTTPSConnection(HOST, self.port, timeout=5, context=self.tls)
        try:
            payload = body if isinstance(body, bytes) or body is None else json.dumps(body)
            connection.request(method, path, payload, headers)
            response = connection.getresponse()
            data = response.read()
            try:
                return response.status, cast(Json, json.loads(data))
            except json.JSONDecodeError:
                return response.status, {"non-json response": data.decode(errors="replace")}
        finally:
            connection.close()

    def snapshot(self, after_rev: int) -> Snapshot:
        tables = ",".join(
            f"'{table}', (select coalesce(jsonb_agg(t order by id), '[]') from {table} t)" for table in TABLES
        )
        return cast(Snapshot, json.loads(self.query(f"""
            set time zone 'UTC';
            select jsonb_build_object(
              'rows', jsonb_build_object({tables}),
              'revision', (select last_value from change_log_rev_seq),
              'changes', (select coalesce(jsonb_agg(c order by rev), '[]') from change_log c where rev > {after_rev})
            );
        """)))


def boot_hub(
    stack: ExitStack, work: Path, base_url: str, psql: Path, label: str, command: list[str],
    mint_command: list[str], paths: CertificatePaths, protocol: str,
) -> tuple[Hub, int]:
    run([
        psql, "-XqAt", "-v", "ON_ERROR_STOP=1", "-d", f"{base_url}/postgres",
        "-c", f"create database {label} template template0",
    ])
    tokens: dict[str, str] = {}
    hub = Hub(
        available_port(), psql, f"{base_url}/{label}", ssl.create_default_context(cafile=str(paths.ca)),
        protocol, tokens, datetime.now(timezone.utc),
    )
    run([psql, "-XqAt", "-v", "ON_ERROR_STOP=1", "-d", hub.url, "-f", ROOT / "db/schema.sql"])
    hub.query(f"""
        update users set updated_at = '{SEED_TIME}';
        update statuses set updated_at = '{SEED_TIME}';
        insert into users (id, name, role, origin, updated_at, deleted) values
          ('{GUEST}', 'Guest', 'guest', 'parity', '{SEED_TIME}', false),
          ('{DELETED_GUEST}', 'Gone', 'guest', 'parity', '{SEED_TIME}', true);
        insert into devices (id, node_id, user_id, origin, updated_at) values
          ('00000000-0000-4000-8000-000000000201', 'member', '{MEMBER}', 'parity', '{SEED_TIME}'),
          ('00000000-0000-4000-8000-000000000202', 'guest', '{GUEST}', 'parity', '{SEED_TIME}'),
          ('00000000-0000-4000-8000-000000000203', 'deleted-guest', '{DELETED_GUEST}', 'parity', '{SEED_TIME}');
    """)
    after_rev = int(hub.query("select last_value from change_log_rev_seq;"))

    log = work / f"{label}.log"
    public_port = available_port()
    while public_port == hub.port:
        public_port = available_port()
    env = {
        **os.environ,
        "DATABASE_URL": hub.url,
        "PORT": str(hub.port),
        "TRACKER_API_HOST": HOST,
        "TRACKER_API_PUBLIC_PORT": str(public_port),
        "TRACKER_API_CERT": str(paths.cert),
        "TRACKER_API_KEY": str(paths.key),
        "TRACKER_FORMULA_PASSWORD": "",
        "TZ": "UTC",
    }
    for node, expected_user, explicit_user in (
        ("member", MEMBER, None),
        ("guest", GUEST, None),
        ("deleted-guest", DELETED_GUEST, None),
        ("mint-member", MEMBER, None),
        ("mint-guest", GUEST, GUEST),
    ):
        mint = [*mint_command, node]
        if explicit_user is not None:
            mint.append(explicit_user)
        token = run(mint, env=env)
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            raise RuntimeError(f"{label} token mint did not print an opaque token")
        token_hash = sha256(token.encode()).hexdigest()
        if hub.query(f"select node_id from api_tokens where token_hash='{token_hash}' and not revoked") != node:
            raise RuntimeError(f"{label} token mint did not store the token hash for {node}")
        if hub.query(f"select user_id from devices where node_id='{node}' and not deleted;") != expected_user:
            raise RuntimeError(f"{label} token mint did not bind {node} to the expected user")
        tokens[node] = token
    for index, (token_name, node) in enumerate((("unbound", "unbound"), ("revoked", "member"))):
        token = secrets.token_urlsafe(32)
        tokens[token_name] = token
        token_hash = sha256(token.encode()).hexdigest()
        revoked = "true" if token_name == "revoked" else "false"
        hub.query(f"""
            insert into api_tokens (id, token_hash, node_id, created_at, revoked)
            values ('00000000-0000-4000-8000-00000000030{index}', '{token_hash}', '{node}', '{SEED_TIME}', {revoked});
        """)
    process = start(stack, log, command, env)
    wait_ready(process, log, lambda: hub.request("/health", token=None, protocol=None)[0] == 200)
    return hub, after_rev


def response_id(body: Json) -> str:
    value = body.get("id") if isinstance(body, dict) else None
    if isinstance(value, str):
        try:
            return str(UUID(value))
        except ValueError:
            pass
    return MISSING


def exercise(hub: Hub, after_rev: int) -> tuple[list[Observation], datetime, datetime]:
    previous = hub.snapshot(after_rev)
    observations: list[Observation] = []

    def case(
        name: str, path: str, expected: int, method: str = "GET", body: Json | bytes = None,
        token: str | None = "member", protocol: str | None = "current", *, entity: str | None = None,
        rollback: bool = False, expected_error: str | None = None,
    ) -> Json:
        nonlocal previous
        status, payload = hub.request(path, method, body, token, protocol)
        state = hub.snapshot(after_rev)
        errors = []
        if expected_error is not None and payload != {"error": expected_error}:
            errors.append(f"expected error {expected_error!r}, received {payload!r}")
        if entity is not None:
            changes = state["changes"][len(previous["changes"]):]
            if not changes or any(change["actor"] != MEMBER or change["source"] != "api" for change in changes):
                errors.append("successful write must log the authenticated actor and api source")
            if not any(change["entity"] == entity and change["row_id"] == response_id(payload) for change in changes):
                errors.append(f"successful write must return the {entity} UUID recorded in change_log")
        else:
            if state["rows"] != previous["rows"] or state["changes"] != previous["changes"]:
                errors.append("request changed persisted rows or change_log")
            expected_revision = previous["revision"] + int(rollback)
            if state["revision"] != expected_revision:
                errors.append(f"change_log identity sequence is {state['revision']}, expected {expected_revision}")
        observations.append(Observation(name, expected, status, payload, state, errors))
        previous = state
        return payload

    case("open health", "/health", 200, token=None, protocol=None)
    case("missing token", "/api/board", 401, token=None)
    case("unknown token", "/api/board", 401, token="invalid")
    case("revoked token", "/api/board", 401, token="revoked")
    case("missing protocol", "/api/board", 400, protocol=None)
    case("old protocol", "/api/board", 400, protocol=str(int(hub.protocol) - 1))
    case("guest", "/api/board", 403, token="guest")
    case("deleted guest", "/api/board", 403, token="deleted-guest")
    case("unbound token", "/api/board", 403, token="unbound")
    case("guest write", "/api/sessions", 403, "POST", {"title": "denied"}, token="guest")
    case("laptop-only route", "/api/status", 404)
    case("unknown API route", "/api/parity-unknown", 404)
    case("member board", "/api/board", 200)
    case("POST to a read-only board", "/api/board", 200, "POST", {})
    case("minted device with implicit member binding", "/api/board", 200, token="mint-member")
    case("minted device with explicit guest binding", "/api/board", 403, token="mint-guest")
    case("malformed page JSON", "/api/pages", 400, "POST", b'{"title":')

    # Resolving the missing home project allocates a change_log revision before content validation fails.
    case("write followed by 400", "/api/pages", 400, "POST", {
        "title": "bad", "repo_path": "/parity/rollback/repo", "content": {},
    }, rollback=True)

    case("track with project, story and log", "/api/sessions", 200, "POST", {
        "title": "Headless track", "repo_path": "/parity/work/repo", "branch": "feat/x", "story": "Hub story",
        "client": "Hub project", "summary": "First log",
    }, entity="sessions")
    case("board after track", "/api/board", 200)
    created = case("create page", "/api/pages", 200, "POST", {
        "title": "Hub page", "repo_path": "/parity/work/repo",
        "content": [{"id": "b1", "type": "text", "text": "first block"}],
    }, entity="pages")
    page_id = response_id(created)
    case("create anchored comment", "/api/comments", 200, "POST", {
        "page_id": page_id, "block_id": "b1", "body": "from the hub",
    }, entity="page_comments")
    for method in ("PATCH", "PUT", "DELETE"):
        case(f"unsupported {method} on a page", f"/api/pages/{page_id}", 405, method, {"status": "archived"})
    case("page contents and comment", f"/api/pages/{page_id}", 200)

    database = case("create user database", "/api/udb", 200, "POST", {"name": "Scores"}, entity="udb_databases")
    properties_path = f"/api/udb/{response_id(database)}/props"
    case("create numeric property", properties_path, 200, "POST", {
        "name": "n", "type": "number", "config": {},
    }, entity="udb_properties")
    case("formula disabled by default", properties_path, 400, "POST", {
        "name": "triple", "type": "formula", "config": {"expr": "n * 3"},
    }, expected_error="invalid formula: formulas are not evaluated on this hub")
    return observations, hub.started_at, datetime.now(timezone.utc)


def normalize(value: Json, aliases: dict[str, str], start_time: datetime, end_time: datetime, key: str = "") -> Json:
    if isinstance(value, dict):
        return {aliases.get(k, k): normalize(v, aliases, start_time, end_time, k) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize(item, aliases, start_time, end_time, key) for item in value]
    if isinstance(value, str):
        if key in CLOCK_FIELDS:
            try:
                stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if stamp.tzinfo and start_time <= stamp <= end_time:
                    return "<runtime timestamp>"
            except ValueError:
                pass
        return UUID_TEXT.sub(lambda match: aliases.get(match[0], match[0]), value)
    return value


def canonical(
    observation: Observation, start_time: datetime, end_time: datetime,
) -> dict[str, Json]:
    aliases = {}
    # First write ties generated UUIDs to the same row across response, storage and change_log.
    for change in observation.state["changes"]:
        aliases.setdefault(change["row_id"], f"<{change['entity']}@{change['rev']}>")
    # The Bun driver serializes timestamps at millisecond precision.
    start_time = start_time.replace(microsecond=(start_time.microsecond // 1000) * 1000)
    rows: dict[str, Json] = {
        table: sorted((normalize(row, aliases, start_time, end_time) for row in entries), key=dump)
        for table, entries in observation.state["rows"].items()
    }
    return {
        "status": observation.status,
        "body": normalize(observation.body, aliases, start_time, end_time),
        "rows": rows,
        "change_log": normalize(cast(Json, observation.state["changes"]), aliases, start_time, end_time),
        "change_log_sequence": observation.state["revision"],
    }


def dump(value: Json) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False)


type Trace = tuple[list[Observation], datetime, datetime]


def compare(bun: Trace, candidate: Trace) -> bool:
    bun_cases, bun_start, bun_end = bun
    candidate_cases, candidate_start, candidate_end = candidate
    failed = 0
    for reference, actual in zip(bun_cases, candidate_cases, strict=True):
        expected_json = dump(canonical(reference, bun_start, bun_end))
        actual_json = dump(canonical(actual, candidate_start, candidate_end))
        errors = []
        for label, case in (("Bun", reference), ("candidate", actual)):
            if case.status != case.expected_status:
                errors.append(f"{label}: HTTP {case.status}, expected {case.expected_status}")
            errors.extend(f"{label}: {error}" for error in case.errors)
        if expected_json == actual_json and not errors:
            print(f"PASS {reference.name}")
            continue
        failed += 1
        print(f"FAIL {reference.name}")
        for error in errors:
            print(f"  {error}")
        for line in unified_diff(
            expected_json.splitlines(), actual_json.splitlines(), "Bun", "candidate", n=2, lineterm="",
        ):
            print(line)
    print(f"{len(bun_cases) - failed}/{len(bun_cases)} cases passed")
    return failed == 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare Bun and Rust hub HTTPS APIs on isolated PostgreSQL databases.",
    )
    parser.add_argument("--baseline", default="bun --no-env-file hub/api/main.ts", help="Bun server command")
    parser.add_argument("--candidate", default="./target/debug/trame-hub", help="candidate server command")
    parser.add_argument(
        "--candidate-mint", help="candidate token mint command (defaults to appending 'token mint' to --candidate)",
    )
    args = parser.parse_args()
    pg_bin = Path(os.environ.get("TRAME_PG_BIN", str(ROOT / ".scratch/package/pg/usr/lib/postgresql/18/bin")))
    protocol = get_protocol()
    baseline_command = shlex.split(args.baseline)
    candidate_command = shlex.split(args.candidate)
    candidate_mint = shlex.split(args.candidate_mint) if args.candidate_mint else [*candidate_command, "token", "mint"]

    with tempfile.TemporaryDirectory(prefix="trame-hub-parity-") as directory, ExitStack() as stack:
        work = Path(directory)
        base_url = postgres(stack, work, pg_bin)
        paths = certificate(work)
        psql = pg_bin / "psql"
        bun = boot_hub(
            stack, work, base_url, psql, "bun", baseline_command, [*baseline_command, "mint"], paths, protocol,
        )
        candidate = boot_hub(
            stack, work, base_url, psql, "candidate", candidate_command, candidate_mint, paths, protocol,
        )
        return 0 if compare(exercise(*bun), exercise(*candidate)) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        sys.exit(str(error))

#!/usr/bin/env bash
# DESCRIPTION: Build the WebAssembly test fixture (crates/trame-local/tests/fixtures/wasm-hello) reproducibly:
#              build paths are remapped so the bytes match on any machine and no home path is embedded.
# USAGE: scripts/wasm-fixture.sh [--check]   (--check fails if the committed plugin.wasm differs)
# EXAMPLES: scripts/wasm-fixture.sh
#           scripts/wasm-fixture.sh --check
set -euo pipefail

cd "$(dirname "$0")/.."
root="$PWD"
fixture="$root/crates/trame-local/tests/fixtures/wasm-hello"
target="$root/.scratch/wasm-target"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
rustup target add wasm32-wasip2 >/dev/null
(cd "$fixture" && CARGO_TARGET_DIR="$target" \
    RUSTFLAGS="--remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$root=/trame" \
    cargo build --target wasm32-wasip2 --release --locked --quiet)
built="$target/wasm32-wasip2/release/trame_wasm_hello.wasm"
if [[ "${1:-}" == --check ]]; then
    cmp "$built" "$fixture/plugin.wasm" || { echo "plugin.wasm is stale: run just wasm-fixture" >&2; exit 1; }
else
    cp "$built" "$fixture/plugin.wasm"
fi

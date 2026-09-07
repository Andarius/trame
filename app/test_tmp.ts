// Test-only: a temp dir that is removed when the test process exits.
// Without this every `deno test -A` run left ~1G of PGlite dirs in /tmp.
export function testTempDir(prefix: string): string {
  const dir = Deno.makeTempDirSync({ prefix });
  globalThis.addEventListener("unload", () => {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch { /* already gone, or still held by a child — fine */ }
  });
  return dir;
}

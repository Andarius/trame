// Test-only: a temp dir removed when the test process unloads — best effort,
// since a module-level crash never reaches `unload`. Without it every
// `deno test -A` run left ~1G of PGlite dirs in /tmp.
export function testTempDir(prefix: string): string {
  const dir = Deno.makeTempDirSync({ prefix });
  globalThis.addEventListener("unload", () => {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch (e) {
      // Already gone is fine; anything else is a leak worth seeing, not a failure.
      if (!(e instanceof Deno.errors.NotFound)) console.error(`testTempDir: ${dir} not removed —`, e);
    }
  });
  return dir;
}

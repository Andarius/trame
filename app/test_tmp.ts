import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test-only: a temp dir removed when the test process exits — best effort.
// Without it every test run left ~1G of PGlite dirs in /tmp.
export function testTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true });
    } catch (e) {
      // Already gone is fine; anything else is a leak worth seeing, not a failure.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`testTempDir: ${dir} not removed —`, e);
    }
  });
  return dir;
}

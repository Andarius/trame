// DESCRIPTION: Supply deterministic time and entropy to the isolated TS HTTP oracle.
// USAGE: Launched only by the debug Rust differential server.
import { createHash } from "node:crypto";
import { scratchPath } from "./rust-db-export.ts";

const clock = await scratchPath(Deno.env.get("TRAME_REPLAY_CLOCK")!);
if (Deno.env.get("TRAME_OFFLINE") !== "1") {
  throw new Error("offline oracle required");
}
const OriginalDate = Date;
const now = () => {
  try {
    return OriginalDate.parse(Deno.readTextFileSync(clock));
  } catch {
    return OriginalDate.now();
  }
};
globalThis.Date = new Proxy(OriginalDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [now()], newTarget);
  },
  get(target, key, receiver) {
    return key === "now" ? now : Reflect.get(target, key, receiver);
  },
});
const random = crypto.getRandomValues.bind(crypto);
crypto.getRandomValues = <T extends ArrayBufferView>(array: T): T => {
  if (array instanceof Uint8Array && array.byteLength === 32) {
    try {
      array.set(
        createHash("sha256").update(Deno.readTextFileSync(clock)).digest(),
      );
      return array;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  random(array);
  return array;
};
await import("../app/main.ts");

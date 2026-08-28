// Sync entry point: changeset sync through the hub API (app/sync-api.ts is the
// transport). No hub configured = offline-only; config is re-read every pass.
import { getHubApi } from "./files.ts";
import { syncOnceApi } from "./sync-api.ts";

export { ENTITIES as TABLES } from "../protocol/entities.ts";

export async function syncOnce(): Promise<
  { pulled: number; pushed: number } | null
> {
  // settings.json (⚙ in the app) wins over TRACKER_HUB_API — re-read every pass
  const hubApi = await getHubApi();
  if (!hubApi) {
    console.warn(
      "no hub configured (⚙ Settings or TRACKER_HUB_API) — offline-only, skipping sync",
    );
    return null;
  }
  return await syncOnceApi(hubApi);
}

if (import.meta.main && Deno.args[0] === "once") {
  console.log(await syncOnce());
}

// DESCRIPTION: Preview or resume a selected Cockpit parent migration with Trame stopped during writes.
// USAGE: deno run -A --config app/deno.json scripts/cockpit-migrate.ts <snapshot.json> [--apply]
const [path, mode] = Deno.args;
if (!path || (mode !== undefined && mode !== "--apply")) {
  throw new Error("Supply a snapshot path and optional --apply.");
}
const portPath = Deno.env.get("TRACKER_PORT_FILE") ??
  `${Deno.env.get("HOME")}/.local/share/trame/port.json`;
const { port } = JSON.parse(await Deno.readTextFile(portPath));
const base = `http://127.0.0.1:${port}`;
if (mode !== "--apply") {
  const response = await fetch(`${base}/api/plugins/cockpit/migration`);
  if (!response.ok) throw new Error(await response.text());
  const preview = await response.json();
  await Deno.writeTextFile(path, JSON.stringify(preview, null, 2) + "\n", {
    createNew: true,
  });
  console.log(
    `Saved ${preview.parents.length} parents to ${path}. Review it, stop Trame, then rerun with --apply.`,
  );
} else {
  let running = false;
  try {
    const response = await fetch(`${base}/api/status`, {
      signal: AbortSignal.timeout(2000),
    });
    await response.body?.cancel();
    running = true;
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
  }
  if (running) throw new Error("Stop Trame before applying the migration.");
  Deno.env.set("TRACKER_APP_ROOT", new URL("../app", import.meta.url).pathname);
  const { getPluginSettings } = await import("../app/plugins/settings.ts");
  const { parseMappings } = await import("../app/plugins/cockpit/scope.ts");
  const { legacyParents, migrateLegacyParent } = await import(
    "../app/plugins/cockpit/migration.ts"
  );
  const settings = await getPluginSettings("cockpit");
  if (settings.enabled === true) {
    throw new Error(
      "Disable the Cockpit plugin before stopping Trame for migration.",
    );
  }
  if (
    typeof settings.baseUrl !== "string" ||
    typeof settings.token !== "string" || !settings.token
  ) {
    throw new Error("Cockpit is not configured.");
  }
  const selected = JSON.parse(await Deno.readTextFile(path));
  if (selected.baseUrl !== settings.baseUrl) {
    throw new Error("Cockpit host changed since the snapshot.");
  }
  const { requireImportSupport } = await import(
    "../app/plugins/cockpit/api.ts"
  );
  await requireImportSupport(settings.baseUrl, settings.token);
  const parents = await legacyParents(
    parseMappings(settings.projects),
    settings.baseUrl,
    settings.token,
  );
  for (const old of selected.parents) {
    const parent = parents.find((p) =>
      p.page.id === old.page.id && p.ticket.reference === old.ticket.reference
    );
    if (!parent) {
      throw new Error(`Legacy parent ${old.page.id} is no longer eligible.`);
    }
    console.log(
      parent.ticket.reference,
      "→",
      await migrateLegacyParent(parent, settings.baseUrl, settings.token, old),
    );
  }
}

import { afterAll } from "bun:test";

afterAll(async () => {
  const { closeDb } = await import("./db.ts");
  await closeDb();
});

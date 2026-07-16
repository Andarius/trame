// Runtime validation of the wire types — imported by the SERVER only (zod stays out
// of the app bundle). Structure + envelope checks; Postgres remains the type authority.
import { z } from "zod";
import { ENTITIES } from "./entities.ts";

const entityName = z.enum(
  ENTITIES.map((e) => e.name) as [string, ...string[]],
);

export const mutationSchema = z.object({
  mutationId: z.string().min(1).max(200),
  entity: entityName,
  id: z.uuid(),
  op: z.enum(["upsert", "delete"]),
  value: z.record(z.string(), z.unknown()),
}).refine(
  (m) =>
    m.op === "delete" || (
      m.value.id === m.id &&
      typeof m.value.updated_at === "string" &&
      typeof m.value.origin === "string" &&
      typeof m.value.deleted === "boolean"
    ),
  {
    message: "value must carry the LWW envelope (id/updated_at/origin/deleted)",
  },
);

export const syncRequestSchema = z.object({
  cursor: z.number().int().nonnegative().nullable(),
  mutations: z.array(mutationSchema).max(10_000),
  limit: z.number().int().positive().max(2_000).optional(),
});

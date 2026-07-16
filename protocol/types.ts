// Wire types for the changeset sync (POST /sync). Versioned: clients send
// PROTOCOL_VERSION in the x-trame-protocol header; the server rejects mismatches
// with a clear error instead of silently misparsing.
import type { EntityName } from "./entities.ts";

export type Row = Record<string, unknown>;

// A full-row LWW write (behaviour-identical to today's direct-SQL sync: soft
// deletes travel as upserts with deleted=true; op 'delete' is reserved for
// hard removals and applied as a soft-delete on the other side).
export type Mutation = {
  mutationId: string; // stable across retries — idempotent pushes
  entity: EntityName;
  id: string;
  op: "upsert" | "delete";
  value: Row;
};

export type Change = {
  rev: number; // server change_log revision (delivery order authority)
  entity: EntityName;
  id: string;
  value: Row | null; // null = hard-deleted on the server → soft-delete locally
};

export type SyncRequest = {
  cursor: number | null; // null = first sync → full snapshot
  mutations: Mutation[];
  limit?: number; // max changes per response (server clamps)
};

export type SyncResponse = {
  acknowledgements: string[]; // applied OR already superseded by LWW — drop from the queue
  rejectedMutations: { mutationId: string; reason: string }[];
  changes: Change[];
  nextCursor: number;
  hasMore: boolean; // true → pull again from nextCursor before trusting the poll
};

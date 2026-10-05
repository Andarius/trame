// `tramecli presence` — a harness reports what its agent is doing on a session card.
// Input: one JSON object, as argv[0] or on stdin (contract in PRESENCE_HELP).
import { apiRequest, resolveTarget } from "./target.ts";

export async function main(argv: string[] = Deno.args) {
  const raw = argv[0] || await new Response(Deno.stdin.readable).text();
  const { session_id, ...body } = JSON.parse(raw) as Record<string, unknown>;
  if (typeof session_id !== "string" || !session_id) throw new Error("session_id is required");
  const target = await resolveTarget();
  await apiRequest(target, `/api/sessions/${session_id}/presence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

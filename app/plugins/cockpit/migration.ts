import { NODE_ID } from "../../config.ts";
import { db, tagKey } from "../../db.ts";
import {
  attachLegacyTicket,
  CockpitError,
  createUserStory,
  fetchTickets,
  type Ticket,
} from "./api.ts";
import { loadMirrorPages } from "./mirror-store.ts";
import {
  stampMark,
  taggedMapping,
  US_MARK,
  userStoryFromPage,
  usOfContent,
} from "./mirror.ts";
import {
  type Mapping,
  mappingTagLabel,
  type Scope,
  scopeKey,
  scopeOf,
} from "./scope.ts";

type LegacyPage = {
  id: string;
  title: string;
  brief: string;
  content: unknown[];
  updated_at: string;
};

export type LegacyParent = {
  page: LegacyPage;
  ticket: Ticket;
  scope: Scope;
  sessionIds: string[];
  userStory: string | null;
};

/** Preview only legacy parents whose remote origin and local mapping agree. */
export async function legacyParents(
  mappings: Mapping[],
  baseUrl: string,
  token: string,
): Promise<LegacyParent[]> {
  const mapped = mappings.map((m) => m.pageId).filter(Boolean);
  const tags = mappings.map((m) => ({
    ...m,
    tagKey: tagKey(mappingTagLabel(m)),
    tagLabel: mappingTagLabel(m),
  }));
  const remote = new Map(
    await Promise.all(mappings.map(async (m) => {
      const scope = scopeOf(m)!;
      return [
        scopeKey(scope),
        await fetchTickets(baseUrl, token, scope),
      ] as const;
    })),
  );
  const out: LegacyParent[] = [];
  const pg = await db();
  for (const project of new Set(mapped)) {
    for (const mirror of await loadMirrorPages(project, mapped)) {
      const mapping = taggedMapping(tags, project, mirror.tags);
      if (!mapping || "error" in mapping) continue;
      const scope = scopeOf(mapping)!;
      const ticket = remote.get(scopeKey(scope))?.find((t) =>
        t.reference === mirror.ref
      );
      const origin = (ticket?.meta?.sync as { origin_id?: unknown } | undefined)
        ?.origin_id;
      if (!ticket || origin !== mirror.id) continue;
      const sessions = (await pg.query<{ id: string }>(
        "select id from sessions where page_id = $1 and not deleted order by id",
        [mirror.id],
      )).rows;
      if (!sessions.length) continue;
      const page = (await pg.query<LegacyPage>(
        "select id, title, brief, content, updated_at::text as updated_at from pages where id = $1 and not deleted",
        [mirror.id],
      )).rows[0];
      if (!page) continue;
      out.push({
        page,
        ticket,
        scope,
        sessionIds: sessions.map((s) => s.id),
        userStory: usOfContent(page.content),
      });
    }
  }
  return out;
}

/** Convert one verified snapshot, leaving both identities available for retries and reconciliation. */
export async function migrateLegacyParent(
  parent: LegacyParent,
  baseUrl: string,
  token: string,
  snapshot: LegacyParent = parent,
): Promise<string> {
  const { page, ticket, scope } = parent;
  const receipt = ticket.meta?.trame_migration as {
    page_id?: string;
    user_story?: string;
  } | undefined;
  const attached = parent.userStory && receipt?.page_id === page.id &&
    receipt.user_story === parent.userStory;
  if (
    page.id !== snapshot.page.id ||
    ticket.reference !== snapshot.ticket.reference ||
    scopeKey(scope) !== scopeKey(snapshot.scope) ||
    (!attached && (ticket.updated_at !== snapshot.ticket.updated_at ||
      (!parent.userStory && page.updated_at !== snapshot.page.updated_at)))
  ) {
    throw new CockpitError(
      409,
      "The migration scope, page, or ticket changed since the snapshot.",
    );
  }
  if (ticket.user_story_id && !attached) {
    throw new CockpitError(409, "The original ticket already belongs to a US.");
  }
  const prefix = `${ticket.reference} — `;
  const title = page.title.startsWith(prefix)
    ? page.title.slice(prefix.length)
    : page.title;
  const brief = page.brief.trim() || ticket.objective?.trim() || "";
  const fields = userStoryFromPage({ ...page, title, brief });
  if ("error" in fields) throw new CockpitError(422, fields.error);
  const made = await createUserStory(baseUrl, token, scope, fields);
  const userStory = made.reference;
  if (!/^US-\d+$/.test(userStory) || typeof made.id !== "string" || !made.id) {
    throw new CockpitError(502, "Cockpit did not return a valid US reference.");
  }

  if (parent.userStory && parent.userStory !== userStory) {
    throw new CockpitError(
      409,
      "The page's US marker differs from its migration origin.",
    );
  }
  if (receipt?.page_id === page.id && receipt.user_story === userStory) {
    if (ticket.user_story_id !== made.id) {
      throw new CockpitError(
        409,
        "The original ticket's US attachment changed.",
      );
    }
    return userStory;
  }
  if (ticket.user_story_id) {
    throw new CockpitError(409, "The original ticket already belongs to a US.");
  }

  if (!parent.userStory) {
    const updated = await (await db()).query(
      `update pages set title=$2, brief=$3, content=$4, origin=$5, updated_at=now()
        where id=$1 and not deleted and updated_at=$6 returning id`,
      [
        page.id,
        title,
        brief,
        JSON.stringify(stampMark(page.content, US_MARK, userStory)),
        NODE_ID,
        page.updated_at,
      ],
    );
    if (!updated.rows.length) {
      throw new CockpitError(
        409,
        "The Trame page changed; refresh the migration preview before retrying.",
      );
    }
  }
  await attachLegacyTicket(
    baseUrl,
    token,
    ticket.reference,
    ticket.updated_at,
    userStory,
    page.id,
  );
  return userStory;
}

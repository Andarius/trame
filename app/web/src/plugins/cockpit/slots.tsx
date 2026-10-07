import type { PageDetail, Session } from "../../api";
import { markOfContent } from "../../../../../core/content-marks.ts";
import { REF_MARK, US_MARK } from "../../../../plugins/cockpit/mark-names.ts";
import { FieldRow } from "../../ui";
import { AssignerAvatar, useAssigner } from "./AssignedBy";
import { CockpitLogo, cockpitHref, CockpitTicket, useCockpitBase } from "./CockpitTicket";

export const COCKPIT_MARKS = [REF_MARK, US_MARK];

export function CockpitPageHeader({ page, onDone }: { page: PageDetail; onDone: () => void }) {
  const content = page.content ?? [];
  return (
    <CockpitTicket
      pageId={page.id}
      parentId={page.parent_id}
      tags={page.tags ?? []}
      reference={markOfContent(content, US_MARK) ?? markOfContent(content, REF_MARK)}
      onDone={onDone}
    />
  );
}

/** Who assigned the card's ticket, and the ticket it was filed as. */
export function CockpitCardFields({ session, specs }: { session: Session; specs: unknown[] }) {
  const assigner = useAssigner(session.id);
  const base = useCockpitBase();
  const ref = markOfContent(specs, REF_MARK);
  return (
    <>
      {assigner && (
        <FieldRow label="Assigned by">
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-soft">
            <AssignerAvatar a={assigner} size={18} /> {assigner.name}
          </span>
        </FieldRow>
      )}
      {ref && base && (
        <FieldRow label="Cockpit">
          <a
            href={cockpitHref(base, ref)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-[12px] text-ink-soft transition-colors hover:border-chipline"
          >
            <CockpitLogo /> <code className="text-ink-muted">{ref}</code> ↗
          </a>
        </FieldRow>
      )}
    </>
  );
}

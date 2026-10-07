import { markOfContent } from "@trame/plugin-api";
import { REF_MARK, US_MARK } from "./mark-names.ts";

export { REF_MARK, US_MARK };

/** The ticket a mirrored page stands for, or null when it is not one of ours. */
export const refOfContent = (content: unknown[]): string | null => markOfContent(content, REF_MARK);

/** The user story a story page was filed as, or null. */
export const usOfContent = (content: unknown[]): string | null => markOfContent(content, US_MARK);

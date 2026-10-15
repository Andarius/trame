// The one module a plugin outside this repo may import from Trame (as "@trame/plugin-api"):
// what it can call, nothing else. Tests take their helpers from "@trame/plugin-test".
export type { Plugin, PluginSettings } from "./types.ts";
export type { Ctx } from "../../core/ctx.ts";
export { getPluginSettings, isPluginEnabled, savePluginSettings } from "./settings.ts";
export { APP_CTX, inTransaction } from "../ctx.ts";
export { NODE_ID } from "../config.ts";
export { createPage, deletePage, getPage, updatePage } from "../../core/pages.ts";
export {
  createProperty,
  createRow,
  deleteRow,
  getUdb,
  patchRow,
  type UdbProp,
  updateProperty,
} from "../../core/udb.ts";
export {
  deleteTag,
  ensureSpecsPage,
  ensureTag,
  getSession,
  listTags,
  setSessionStatus,
  specsPageId,
  tagKey,
  updateTag,
  upsertSession,
} from "../../core/sessions.ts";
export { projectAbove } from "../../core/hierarchy.ts";
export { isFolderBlock, markdownToPageBlocks, type PageBlock } from "../../core/page-markdown.ts";
export { mergePageBlocks } from "../../core/page-merge.ts";
export { markOfContent } from "../../core/content-marks.ts";
export { stripMarks, writeMark } from "../../core/todo-marks.ts";

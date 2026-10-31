// The one module a web plugin outside this repo may import from Trame (as "@trame/web-api").
export type { BlockViewProps, CardFace, FrontendPlugin, PanelProps, PluginBlock, PluginBlockData } from "./plugins/index";
export { SidebarColumn } from "./plugins/index";
export { openPluginSettings, usePluginEnabled } from "./plugins/enabled";
export { getPluginSettings, openInBrowser, savePluginSettings, updatePage } from "./api";
export type { Block, PageDetail, Session } from "./api";
export {
  appConfirm,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  FIELD_LABEL,
  FieldRow,
  IconButton,
  MENU_LABEL,
  MenuRow,
  Modal,
  Popover,
  SECTION_LABEL,
  Select,
  StatusDot,
  TextArea,
  TextInput,
  timeAgo,
} from "./ui/ui";
export { type Resolved, useResolvedTheme } from "./ui/theme";
export { markOfContent } from "../../../core/content-marks.ts";

// Entry of the out-of-process plugins' frontend bundle (vite.plugins.config.ts).
import "./runtime-entry.css";
import { LOCAL_PLUGINS } from "./local.gen";

// appended, not assigned: WebAssembly packages' own bundles share the global (plugins.rs web_file)
const win = globalThis as { __trameRuntimePlugins?: unknown[] };
(win.__trameRuntimePlugins ??= []).push(...LOCAL_PLUGINS);

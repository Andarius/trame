// Entry of the out-of-process plugins' frontend bundle (vite.plugins.config.ts).
import "./runtime-entry.css";
import { LOCAL_PLUGINS } from "./local.gen";

(globalThis as { __trameRuntimePlugins?: unknown }).__trameRuntimePlugins = LOCAL_PLUGINS;

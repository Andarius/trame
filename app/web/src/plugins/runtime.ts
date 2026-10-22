// Composed plugins ship a prebuilt frontend bundle (`just plugins-install`) served at
// /api/plugins/web/plugins.{js,css}. It registers itself on window.__trameRuntimePlugins and
// takes React and @trame/web-api from window.__trame instead of bundling its own copies.
// A classic <script> on purpose: dynamic import() fails in WebKitGTK (see ./index).
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as webApi from "../plugin-api";
import type { FrontendPlugin } from "./index";

type RuntimeWindow = typeof globalThis & {
  __trame?: Record<string, unknown>;
  __trameRuntimePlugins?: FrontendPlugin[];
};

function attach(el: HTMLScriptElement | HTMLLinkElement): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000); // a broken plugin must not block startup
    el.onload = el.onerror = () => {
      clearTimeout(timer);
      resolve();
    };
    document.head.append(el);
  });
}

export async function loadRuntimePlugins(): Promise<FrontendPlugin[]> {
  const win = globalThis as RuntimeWindow;
  const probe = await fetch("/api/plugins/web/plugins.js", { method: "HEAD" }).catch(() => null);
  if (!probe?.ok) return [];
  win.__trame = { React, jsxRuntime, webApi };
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "/api/plugins/web/plugins.css";
  const js = document.createElement("script");
  js.src = "/api/plugins/web/plugins.js";
  await Promise.all([attach(css), attach(js)]);
  return win.__trameRuntimePlugins ?? [];
}

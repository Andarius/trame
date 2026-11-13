// Composed plugins ship a prebuilt frontend bundle (`just plugins-install`) served at
// /api/plugins/web/plugins.{js,css}; WebAssembly packages their own, at /api/plugins/web/wasm/<id>.{js,css}. It registers itself on window.__trameRuntimePlugins and
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

// each WebAssembly package's own script and stylesheet: one that fails to load or parse leaves the
// others (and the composed bundle) running
async function wasmPackages(): Promise<string[]> {
  const list = await fetch("/api/plugins").then((r) => r.json()).catch(() => []);
  return Array.isArray(list) ? list.filter((p) => p.web === true).map((p) => String(p.id)) : [];
}

export async function loadRuntimePlugins(): Promise<FrontendPlugin[]> {
  const win = globalThis as RuntimeWindow;
  const [probe, packages] = await Promise.all([
    fetch("/api/plugins/web/plugins.js", { method: "HEAD" }).catch(() => null),
    wasmPackages(),
  ]);
  const bases = [
    ...(probe?.ok ? ["/api/plugins/web/plugins"] : []),
    ...packages.map((id) => `/api/plugins/web/wasm/${encodeURIComponent(id)}`),
  ];
  if (!bases.length) return [];
  win.__trame = { React, jsxRuntime, webApi };
  // in order: a package script runs after the composed bundle
  for (const base of bases) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${base}.css`;
    const js = document.createElement("script");
    js.src = `${base}.js`;
    await Promise.all([attach(css), attach(js)]);
  }
  return win.__trameRuntimePlugins ?? [];
}

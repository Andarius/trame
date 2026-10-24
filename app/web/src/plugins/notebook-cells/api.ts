// Client of /api/plugins/notebook-cells: kernels, streamed execution, settings, export.
import { useSyncExternalStore } from "react";
import type { CellEvent } from "./cell-output";

const BASE = "/api/plugins/notebook-cells";

export type ImportedKeymap = { name: string; actions: Record<string, string[]>; importedAt?: string };
export type Settings = { enabled: boolean; serverUrl: string; hasToken: boolean; keymap: ImportedKeymap | null };
export type PyCharmKeymap = { ide: string | null; keymap: string; chain: string[]; missing: string[]; actions: Record<string, string[]> };
export type Kernel = {
  id: string;
  name: string;
  state: string;
  path: string | null;
  lastActivity?: string | null;
  connections?: number | null;
};
export type ProjectKernelConfig = {
  path: string;
  display?: string | null;
  python?: string | null;
  packages?: string[];
  env?: Record<string, string>;
};
export type KernelSpec = {
  name: string;
  display: string;
  language?: string | null;
  project?: string | null;
  config?: (Omit<ProjectKernelConfig, "path"> & { project?: string }) | null;
};

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const getSettings = () => fetch(`${BASE}/settings`).then((r) => json<Settings>(r));
export const saveSettings = (patch: { serverUrl?: string; token?: string; enabled?: boolean; keymap?: ImportedKeymap | null }) =>
  fetch(`${BASE}/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) })
    .then((r) => json<Settings>(r));
export const listKernels = () => fetch(`${BASE}/kernels`).then((r) => json<{ kernels: Kernel[] }>(r)).then((r) => r.kernels);
const postJson = <T,>(path: string, body: unknown) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => json<T>(r));
export const startKernel = (name?: string) => postJson<{ id: string }>("/kernels", name ? { name } : {});
export const listKernelSpecs = () => fetch(`${BASE}/kernelspecs`).then((r) => json<{ default: string; specs: KernelSpec[] }>(r));
// registers the folder's pyproject env as a uv kernel spec, then starts it
export const saveProjectKernel = (cfg: ProjectKernelConfig, start: boolean) =>
  postJson<{ id?: string; spec: string }>("/project-kernel", { ...cfg, start });
export type ProjectInfo = {
  dir: string;
  name: string | null;
  version: string | null;
  requiresPython: string | null;
  dependencies: string[];
  dev: string[];
  lock: boolean;
};
export type PythonVersion = { version: string; installed: boolean };
export type PyPiProject = { name: string; summary: string | null; latest: string; versions: { version: string; at: string | null }[] };
const getJson = <T,>(path: string, params: Record<string, string> = {}) =>
  fetch(`${BASE}${path}?${new URLSearchParams(params)}`).then((r) => json<T>(r));
export const readProject = (path: string) => getJson<ProjectInfo>("/project", { path });
export const listPythons = () => getJson<PythonVersion[]>("/pythons");
export const pypiVersions = (name: string) => getJson<PyPiProject>("/pypi", { name });
export const removeProjectKernel = (name: string) => postJson<{ ok: boolean }>("/project-kernel/remove", { name });
export const shutdownKernel = (kernel: string) => postJson<{ ok: boolean }>("/shutdown", { kernel });
export const interrupt = (kernel: string) => postJson<{ ok: boolean }>("/interrupt", { kernel });
export const restart = (kernel: string) => postJson<{ ok: boolean }>("/restart", { kernel });
export const readNotebook = (path: string) =>
  fetch(`${BASE}/notebook?path=${encodeURIComponent(path)}`).then((r) =>
    json<{ path: string; cells: { cell_type: string; source: string; outputs?: unknown[]; count?: number | null }[] }>(r)
  );

// Runs `code` and hands every event to `onEvent` as it streams; resolves when the kernel is idle again.
export async function execute(code: string, kernel: string | null, onEvent: (ev: CellEvent) => void, signal?: AbortSignal) {
  const res = await fetch(`${BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, kernel }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    buf += decoder.decode(value, { stream: !done });
    const lines = buf.split("\n");
    buf = done ? "" : lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as CellEvent);
      } catch { /* a torn line at the end of the stream */ }
    }
    if (done) break;
  }
}

// The kernel the page's cells run on, shared by every cell in the window.
let preferred: string | null = null;
const listeners = new Set<() => void>();
export function setPreferredKernel(id: string | null) {
  preferred = id;
  for (const l of listeners) l();
}
export function usePreferredKernel(): string | null {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, () => preferred);
}

export const createReport = (title: string, html: string) =>
  fetch("/api/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, html }) })
    .then((r) => json<{ id: string }>(r));

export const readPyCharmKeymap = () => fetch(`${BASE}/pycharm-keymap`).then((r) => json<PyCharmKeymap>(r));

// The editor keymap imported from PyCharm, shared by every cell; loaded once from the settings.
let keymapState: ImportedKeymap | null = null;
let keymapLoaded = false;
const keymapListeners = new Set<() => void>();
export function setCellKeymap(km: ImportedKeymap | null) {
  keymapState = km;
  keymapLoaded = true;
  for (const l of keymapListeners) l();
}
function subscribeKeymap(l: () => void) {
  keymapListeners.add(l);
  if (!keymapLoaded) {
    keymapLoaded = true;
    getSettings().then((s) => setCellKeymap(s.keymap ?? null)).catch(() => {});
  }
  return () => keymapListeners.delete(l);
}
export const useCellKeymap = (): ImportedKeymap | null => useSyncExternalStore(subscribeKeymap, () => keymapState);

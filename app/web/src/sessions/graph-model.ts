import type { BoardData } from "../api.ts";
import { repoTitle } from "../page/repo-title.ts";
import { pagesById, projectOf } from "../tree.ts";

export type GraphNode =
  | {
    id: string;
    kind: "project";
    label: string;
    color: string | null;
    icon: string | null;
    cards: number;
  }
  | { id: string; kind: "repo"; label: string; cards: number }
  | {
    id: string;
    kind: "card";
    label: string;
    status: string;
    touched: string;
    sessionId: string;
  };
export type GraphLink = { source: string; target: string };
export type BoardGraph = { nodes: GraphNode[]; links: GraphLink[] };

const NO_PROJECT = "project:none";

// Projects link to the repos their cards live in, cards hang off their repo (or their project
// when the title names none); a repo used by several projects is one node, bridging them.
export function buildGraph(
  board: BoardData,
  sessions = board.sessions,
): BoardGraph {
  const byId = pagesById(board.pages);
  const terminal = new Set(
    board.statuses.filter((s) => s.terminal).map((s) => s.key),
  );
  const projects = new Map(board.projects.map((p) => [p.id, p]));
  const nodes = new Map<string, GraphNode>();
  const links = new Map<string, GraphLink>();
  const link = (source: string, target: string) =>
    links.set(`${source}>${target}`, { source, target });
  const bump = (id: string) => {
    const n = nodes.get(id);
    if (n && n.kind !== "card") n.cards++;
  };

  for (const s of sessions) {
    if (terminal.has(s.status)) continue;
    const pid = projectOf(s, byId);
    const project = pid ? projects.get(pid) : undefined;
    const projectId = project ? `project:${project.id}` : NO_PROJECT;
    if (!nodes.has(projectId)) {
      nodes.set(projectId, {
        id: projectId,
        kind: "project",
        label: project?.name ?? "No project",
        color: project?.color ?? null,
        icon: project?.icon ?? null,
        cards: 0,
      });
    }
    bump(projectId);
    const { repo, title } = repoTitle(s);
    let parent = projectId;
    if (repo) {
      parent = `repo:${repo}`;
      if (!nodes.has(parent)) {
        nodes.set(parent, { id: parent, kind: "repo", label: repo, cards: 0 });
      }
      bump(parent);
      link(projectId, parent);
    }
    const id = `card:${s.id}`;
    nodes.set(id, {
      id,
      kind: "card",
      label: title,
      status: s.status,
      touched: s.last_touched,
      sessionId: s.id,
    });
    link(parent, id);
  }
  return { nodes: [...nodes.values()], links: [...links.values()] };
}

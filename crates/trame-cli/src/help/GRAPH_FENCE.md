A `graph` fence is one edge per line, left to right; columns come from the edges
(a node sits one column right of its furthest source), so only write the flow:

  ```graph
  web[Web app|SPA · REST] -> api[API|granian] : REST + SSE
  cli[CLI] -> api : REST
  api -> pg[PostgreSQL|queue · events] : NOTIFY
  pg -> worker[Workers ×N] : LISTEN
  worker -> vm[Sandbox VM|no network] : sbx exec

  step Create: web>api, api>pg
    Alice submits the task.

    The API inserts it and NOTIFYs a worker, which claims it and starts.
    > What the console shows while it happens.
  step Stream: pg>worker, worker>vm
    The worker streams the agent's output back over SSE.
  ```

`id[Title|subtitle]` names a node the first time it appears (bare `id` after that);
`: text` after the target labels the edge. A `step` line is one beat of a lifecycle:
clicking it dims everything but the nodes and `from>to` edges it lists (a bare id
lights a node on its own). Lines indented under a step are that beat's prose, shown in
a card under the diagram and driven by the same selection: the first paragraph is the
scenario line, the rest the detail, and `> …` lines become the card's side panel
(inline markdown works throughout). The card carries ← Previous / Next → nav, so the
steps read as a lifecycle. A lifecycle with prose opens on beat 1; without prose the
whole diagram shows. Steps are optional — leave them out for a plain diagram.
Lines starting with `//` are comments.

`group dev[saas-dev|subtitle]: a, b, c` boxes those nodes under a title; groups take
a column each, in the order declared, and an edge may point at a group id. A `#bad`,
`#warn` or `#good` after a node's or group's brackets tones it, and at the end of an
edge line tones the edge; `..>` instead of `->` draws it dashed. Within a group, link
only adjacent nodes: an edge between two rows crosses the ones in between. A
`style workshop|sketch|neon` line picks the look (default `plain`, the page's theme):
workshop is a light paper card, sketch hand-drawn, neon a dark console with moving
dashes. A `wide` line spans the page instead of the text column, and `width <px>` sets
a width in between (wider graphs scroll otherwise); the block toolbar sets the style
and `wide`, and dragging the block's right edge writes `width`.

  ```graph
  style workshop
  group dev[saas-dev]: apps
  group ops[saas-ops|platform]#bad: graf, ci
  group prod[saas-prod]: pg
  apps[dev apps] -> graf[Grafana] : metrics + logs
  ci[CI runners]#warn ..> pg[pg-ro replica] : option B #bad
  ```

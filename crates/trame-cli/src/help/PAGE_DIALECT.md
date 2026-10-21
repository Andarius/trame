GFM plus: `## Title {{tab}}` headings group the blocks below into a tab strip
(consecutive markers = one strip) and `## Title {{fold}}` into a collapsible section;
`- [ ]`/`- [x]` become checkable todos (2 spaces per nesting level, max 4);
bullets under a Completed/Done/Shipped heading render as checks, under
Open/Todo/Next/Pending/Remaining/In progress/Blocked as open rings, with a one-click
toggle between the two; `{{text}}` is a pill (`{{green:…}}` tints it:
green|yellow|red|copper|gray); a `graph` fence draws an architecture diagram
(see below) and a `mermaid` fence a mermaid one; a `cards` fence renders a KPI
row, one `value | label` per line with an optional trailing
`| green|yellow|red|copper|gray` to tint a card; a `decision` fence asks a human: the
question on the first line, one option per line with an optional trailing
`| recommended`, marks on their own line (`{{trame:ask=@who}} {{trame:due=YYYY-MM-DD}}`);
picking an option in the app appends `{{trame:answer=…}}`, `answered_by` and
`completed_at` to that line, so read the marks back to learn the decision; other fences highlight
python/ts/js/bash/json/sql; PR/MR links become live PR chips,
`#123` an issue ref, `![alt](url)` an inline image; GFM tables render as
interactive cards; a line that is only `{{trame:folder=<path>}}` becomes a live
listing of that directory (`{{trame:view=gallery}}` after it shows HTML files as
thumbnails) — the path must sit under one of Trame's Explore roots, or the block
lists nothing; a line that is only `{{trame:embed=<https-url>}}` (optional
`{{trame:height=<px>}}` after it, default 600) shows that page live in an iframe —
the host must be in Settings › Embeds (embedHosts), or the block shows a placeholder;
a line that is only `{{trame:db=<database id>}}` shows that database there, with
its views and tabs (a database attached to the page but placed by no such line
renders at the end). A leading `# Title` equal to the page title is dropped. No raw
HTML or HTML entities — `&middot;` renders literally; write Unicode characters
(·, —, …) directly.

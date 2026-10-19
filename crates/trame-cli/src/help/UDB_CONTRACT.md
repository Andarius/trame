Databases (the Notion-style tables in Trame) are plain REST on the running app (the
port is in ~/.local/share/trame/port.json) or the hub; nothing is queued when both are
down. Rows have a command — JSON on stdin, one row or an array:

  tramecli db rows <db> [--json] <<< '[{"vals":{"Name":"Q3","Cost":120}},
                                       {"id":"<row>","vals":{"Cost":null}}]'

A row with an `id` merges into it, one without is created; `vals` keys are column
names or property ids, cells shaped as below (relation/formula/rollup refused, and so
are columns a SQL source fills: `config.source` set, `source_column` its result column, `source_name` its label).

  POST /api/udb               {name}                    → {id}, with a "Name" title column
  POST /api/udb/<db>          {name?, icon?, page_id?}  rename, icon, show it on a page
  POST /api/udb/<db>/props    {name, type, config}      → {id}
  POST /api/udb/props/<prop>  {name?, config?, width?}  config MERGES into the stored one
  POST /api/udb/<db>/rows     {vals, icon?}             → {id}; vals keyed by PROPERTY id
  POST /api/udb/rows/<row>    {vals, icon?}             merges; a null value clears a cell
  POST /api/udb/links         {prop_id, from_row, to_row, remove?}    relation cells
  POST /api/udb/<db>/delete, /api/udb/props/<prop>/delete, /api/udb/rows/<row>/delete
  GET  /api/udb, GET /api/udb/<db> → {db, properties, rows}: rows[].vals keyed by property
       id, rows[].derived the formula/rollup values, rows[].relations the linked rows

`config` is stored exactly as sent and every key is optional — a column created with
`{}` renders bare (plain number, no unit, no color), which is never what the user
wants. Compose the presentation when you create the column. A column's `type` is
fixed at creation (name, config and width are patchable); `config.icon` (emoji or
image data-uri) replaces the type glyph in the header, and a row's `icon` is its
avatar.

Column types — the config they read, then the cell shape in `vals`:

  title         —                            "text"  · exactly one, created with the db
  text          —                            "text"
  url           —                            "https://…"
  checkbox      —                            true
  date          end: true for a range        {"start":"2026-09-21","end":"2026-09-30"}
  select        options: [{id,name,color}]   "<option id>"   (you mint the 8-char ids)
  multi_select  the same options             ["<option id>", …]
  number        the number block below       12.5
  relation      target_db, reverse_name?     not in vals — link rows via /api/udb/links
  formula       expr                         read-only, in rows[].derived
  rollup        relation_prop, agg, …        read-only, in rows[].derived

The number block — honoured by number columns and by formula/rollup results alike:

  format       plain|euro|dollar|percent   (€ / $ / % suffix; a unit replaces it)
  unit         free text after the value ("GB/s", "s"), muted
  unit_prop    id of a sibling select|text column giving a PER-ROW unit (unit is the
               fallback) — the select's option NAME is what shows
  precision    decimals; unset = the number as stored
  show_as      number|bar|ring · max = the value that reads 100% (default 100) ·
               show_value: false drops the figure beside the bar/ring
  color_mode   fixed  → color "#7bd88f"
               scale  → good low|high (which end is green, default low), scale_min /
                        scale_max (unset = auto over the column's visible values)
               rules  → rules: [{lt, color}] — first rule with value < lt wins, an
                        entry with no lt is the fallback
  color_apply  none|text|pill|dot|cell — where the color lands on a plain number
               (bar and ring always wear it)
  colors       hex; the option palette is #7a9ee7 #b590e7 #c98a63 #7bd88f #e3c567
               #e06c75 #6b7280

relation: `{target_db, reverse_name?}` — creates the paired column in the target
database (reverse_name defaults to this database's name), so never create both sides.
Cells live in their own table: POST /api/udb/links with the property and the two row
ids (remove: true unlinks). The server stamps `pair` and `owner` on both columns —
read them, never send them.

formula: `{expr}` — raw SQL over column NAMES, bare (case-insensitive, an underscore
matches a space) or quoted for anything else ("36-mo total €"). SQL keywords and
functions pass through (round, nullif, coalesce, case … end); ';' is refused; only
stored columns are referencable (not another formula, rollup or relation). Validated
on write — a bad expression is a 400, never a broken column.

rollup: `{relation_prop, agg, target_prop, date_prop?}` — relation_prop is a relation
column of THIS database, agg is count|sum|avg|min|max|latest, target_prop a column of
the target database (required unless count), date_prop the target's date column that
orders "latest" (default: last edited).

Example — a euro column that reddens as it grows:

  T=http://127.0.0.1:$(jq -r .port ~/.local/share/trame/port.json)
  curl -s -XPOST $T/api/udb/$DB/props -d '{"name":"36-mo total","type":"number",
    "config":{"format":"euro","precision":0,"color_mode":"scale","good":"low",
              "color_apply":"text"}}'

Views — the tabs above the grid (Table / Summary / Chart), stored whole in the
`views` column and returned as `db.views` by the GET. Send the bundle, never a
fragment:

  POST /api/udb/<db>  {"views":{"active":"<tab id>","tabs":[
                       {"id":"<tab id>","name":"Cost","config":{…}}]}}

A config is `{sorts:[], filters:[]}` — the same filters and sorts the toolbar
writes — plus one optional mode. `summary: true` with `groupBy` is the read-only
aggregate table; `chart` draws those same aggregates instead:

  kind    bar | line | pie · plus stacked (bar), donut (pie), labels: true
  x       property id to group by — null for one mark per row
  series  [{"propId":"<number|formula|rollup id>","agg":"sum|avg|min|max"}], or
          {"propId":null,"agg":"count"} for the row count. The order is the
          legend and the palette order, and it caps at 8.
  colour  optional "color":"#e06c75" (hex) on a series entry. Without it the
          series takes its column's fixed colour (color_mode "fixed" + color),
          then the palette slot; an invalid hex is ignored. A pie colours by
          slice, so a series colour does nothing there.

Example — total cost per status, as bars:

  curl -s -XPOST $T/api/udb/$DB -d '{"views":{"active":"v1","tabs":[{"id":"v1",
    "name":"Cost","config":{"sorts":[],"filters":[],"chart":{"kind":"bar",
    "x":"'$STATUS_PROP'","series":[{"propId":"'$COST_PROP'","agg":"sum"}]}}}]}}'

A chart view is read-only and live: filters narrow what it draws, numbers wear
their column's format, and a config it cannot read degrades to a plain table
rather than failing.

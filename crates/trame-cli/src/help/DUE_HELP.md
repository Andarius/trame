tramecli due — open todos carrying a due date, with their card and project

  tramecli due [--late | --within N | --all] [--query '<query>'] [--json]

Lists unchecked page todos marked `{{trame:due=YYYY-MM-DD}}`, soonest first.
By default it shows what the sidebar's DUE section shows: late, or due within 7 days.
  --late        only past due
  --within N    due within N days, late ones included
  --all         every due todo, however far out
--query (-q) filters with the board's query syntax (`tramecli query`) on the todo's
card; a todo on a plain page is matched as if it were a card filed at that page, so
project: and story: terms apply to it too, e.g.
  tramecli due --late -q '-project:soren'

Each line: due date, "N days late" / "in N days", project · [status] card title (or
the page title when no card owns the page), then the todo text and a link to it.
--json prints rows ({due, days, text, project, card_id, card_title, status, page_id,
page_title, block_id, url}); days is negative when late.

Reads from the running Trame app, or the hub when no app runs; writes nothing.

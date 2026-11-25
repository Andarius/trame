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

Delivery (on a schedule, through connectors — see `tramecli connector`):

  tramecli due --send [--to telegram] [--now <schedule>] [--dry-run]
  tramecli due schedule list
  tramecli due schedule add|set <name> [--at HH:MM] [--until HH:MM] [--days mon-fri]
                                       [--window late|today|week|N] [--to telegram|all]
  tramecli due schedule rm <name>
  tramecli due install [--uninstall]

--send sends each schedule whose window is open now (a run day, from `at` until
`until`, host local time) to its connectors, once per day per connector; a stamp
in ~/.local/state/trame (TRAME_STATE_DIR) records the day. Nothing is sent when
nothing is due. If the app or hub cannot be read, each connector gets one
"failed" message that day and the next --send (5 minutes later under the timer)
retries. --now forces one
schedule now; --dry-run prints what would go where and the next run, sending
nothing. Schedules live in settings.json under due.schedules; with none, one
"morning" schedule runs 08:30–12:00 every day, window today (late or due today).
`install` writes and enables the trame-due.timer systemd user timer, which runs
`due --send` every 5 minutes; editing a schedule needs no reinstall.

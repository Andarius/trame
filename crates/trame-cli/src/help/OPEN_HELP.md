tramecli open — show a page or a card in the running Trame desktop app

  tramecli open <page id | card id | Trame URL>

Accepts an id, an app URL (`…/?page=<id>`, `…/?view=card&card=<id>`) or a
`trame://page/<id>` / `trame://card/<id>` link. The app window navigates to that
view and comes to the front (POST /api/open {"page_id"|"card_id"|"id"}; an unknown
id is refused). Prints the URL either way.

  app running        opens it, prints the app URL, exits 0
  app not running    prints `trame://<page|card>/<id>`; when the app is installed
                     the link starts it on that view (exit 0), else exits 1
  headless backend   prints the app URL, exits 1 (no window to raise)

A bare id with no app running is taken as a card. `trame://` links work from any
link, browser or terminal once the app is installed (.deb, snap, quickstart
AppImage, macOS bundle).

Agents: report the page or card URL; run `tramecli open` only when the user asks
to see it.

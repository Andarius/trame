tramecli open — show a page, a card or a filtered Sessions board in the running Trame desktop app

  tramecli open <page id | card id | Trame URL>
  tramecli open --query '<session query>'     the Sessions board filtered by that query
  tramecli open --view <name>                 a saved board view (the chips by the query box)

Accepts an id, an app URL (`…/?page=<id>`, `…/?view=card&card=<id>`) or a
`trame://page/<id>`, `trame://card/<id>`, `trame://board?q=<query>` or
`trame://view/<name>` link. The app window navigates to that view and comes to the
front (POST /api/open {"page_id"|"card_id"|"id"|"q"|"view"}; an unknown id or view
name is refused). Prints the URL either way. View names match ignoring case.

  app running        opens it, prints the app URL, exits 0
  app not running    prints the `trame://` link; when the app is installed
                     the link starts it on that view (exit 0), else exits 1
  headless backend   prints the app URL, exits 1 (no window to raise)

A bare id with no app running is taken as a card. `trame://` links work from any
link, browser or terminal once the app is installed (.deb, snap, quickstart
AppImage, macOS bundle).

Agents: report the `trame://page/<id>`, `trame://card/<id>` or `trame://view/<name>`
link (it opens the desktop app, an app URL opens a browser); run `tramecli open` only
when the user asks to see it.

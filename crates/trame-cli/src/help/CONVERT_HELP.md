tramecli convert — turn a page into a session card, or a user story

  tramecli convert <page-id>            the page becomes a card's specs
  tramecli convert --story <page-id>    the page becomes a user story under its project

The page becomes the card's specs (specs_page_id) — same page, no copy; the card
anchors to the nearest story above it and inherits that branch's project. Same call as
the page header's "Convert to session" button. Idempotent: the card id derives from the
page id, so converting again returns the existing card (--json prints
{id, created:false}) instead of forking a second one.

Then track it as usual — `repo_path`/`branch` land on the card on the first
`tramecli track` that names it.

--story is the deliberate way a page becomes a user story (same as the page header's
"Convert to user story"): it moves under its nearest project and keeps its content,
comments and links. Refused for a card's spec page, under another user story, or above
one — stories don't nest. Tracking by name never does this to a nested page.

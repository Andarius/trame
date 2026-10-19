tramecli move — reparent a page (a doc, a user story) without recreating it

  tramecli move <page-id | page URL> <parent-id | parent URL>   nest it under that page
  tramecli move <page-id | page URL> --top                      move it to the top level

The page keeps its id, content, comments and links. Same as dragging it in the sidebar
(POST /api/pages/<id>/move). Refused under itself or a descendant, and a user story
can't nest under another story. --json prints {id, parent_id}.

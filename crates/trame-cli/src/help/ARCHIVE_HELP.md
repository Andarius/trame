tramecli archive — fold a page (a user story, a doc) away, or bring it back

  tramecli archive <page-id | page URL>             status → archived
  tramecli archive --restore <page-id | page URL>   status → open

Archived pages leave the sidebar tree and the story pickers; their cards and content
stay. Same as the page header's status picker (POST /api/pages/<id> {"status": …}).
Pages have only these two statuses — finished work is a card tracked `done`, so
archive a story once all its cards are done. --json prints {id, status}.

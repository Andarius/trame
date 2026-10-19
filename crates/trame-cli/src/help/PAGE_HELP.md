tramecli page — create or update a Trame page, or write a session's specs

Pipe ONE JSON object on stdin (or pass it as the single argument):

  create: {title, markdown?|markdown_file?, parent_id?|parent_title?, icon?}
    Without a parent the page files itself under the project owning the current
    working directory; parent_id: null forces a root (Unfiled) page.
  update: {page_id|page_title, markdown|markdown_file, title?, icon?}
    Replaces the content IN PLACE (full new content, not a diff); blocks whose text
    is unchanged keep their ids so inline comments stay anchored. Reply to the
    comments you are addressing BEFORE updating — the update may remove their block.
  specs:  {session_id, markdown|markdown_file}
    Find-or-create the session's spec page, then update it in place.

Requires the running Trame app (page writes are not queued).

Markdown dialect:

%%PAGE_DIALECT%%

Graph fences:

%%GRAPH_FENCE%%

Todo lines:

%%TODO_SYNTAX%%

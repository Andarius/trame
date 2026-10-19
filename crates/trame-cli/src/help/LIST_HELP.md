tramecli list — print open sessions grouped by story

  tramecli list [--json] [--query '<query>'] [--deleted]

--query (-q) filters with the board's query-box syntax (`tramecli query`), e.g.
  tramecli list -q 'tag:p1 -has:specs touched:>7d'
Done-like columns stay hidden unless the query has a status: term.
--deleted lists the soft-deleted cards instead (every column), e.g. to count them:
  tramecli list --deleted --json | jq length

Reads the board from the running Trame app; writes nothing. Sessions whose status
column is terminal (e.g. done) are omitted. --json prints flat rows
({id, title, status, story, branch, branches, repo_path, last_touched, next_step, pr_url})
for jq — what the pre-push hook filters on.

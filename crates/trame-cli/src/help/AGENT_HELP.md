tramecli agent — message the agent-view runs of the running Trame app

  tramecli agent list [--json]          the runs: id, provider, status, folder
  tramecli agent send <run> <text…>     queue a message for that run (`-` reads stdin)
  tramecli agent send --peer <peer> <text…> [--json]
                                      deliver a message to a configured relay peer (`-` reads stdin)
  tramecli agent hook <run> [--json]    a curl command a hook can post with

A message waits in the run's inbox and starts a turn at its next idle moment:
never mid-turn and never over a pending approval. The run sees "Message from
<sender>:" before the text, and the transcript labels it. Run from inside an
agent-view run, `send` includes that run's ID (`TRAME_AGENT_RUN`), so the
receiver can answer with `tramecli agent send <your run> …`. A run holds at most 20
waiting messages; more are refused.

`send --peer` uses the local agent relay. It returns the relay's delivery ID when
the peer accepts the message. A reply from an agent-view run carries its run ID.

`hook` prints the run's own secret: it opens that run's inbox and nothing else,
and survives app restarts.

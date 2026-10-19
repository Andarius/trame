tramecli presence — report what your agent is doing right now

Pipe ONE JSON object on stdin (or pass it as the single argument):

  {session_id, state, harness, name?, icon?, provider?, model?, tokens?, context_max?,
   step?, question?, page_id?, block_id?, anchor?}

- state: working | waiting (blocked on the human — put the ask in question) | idle.
- harness: what runs the agent (claude-code, codex, spatchou, …). Known harnesses
  and providers get a logo; others may send icon (an emoji or an image URL).
- name: this session's own name, if it has one (e.g. "asso-fix-2"); shown instead of the harness.
- tokens: tokens used so far in the session; context_max: the model's window.
- step: the latest action in a few words (e.g. "Edit tofu/s3/main.tf").
- page_id + block_id: the todo being worked on — linked to the session once.

Push on every state change and at least every minute while working: Trame shows the
agent as live until the last push is older than the "live" setting, then stale. Each
push is ephemeral (memory only, not synced). session_id may also be the harness's own
session uuid (Claude Code / Codex): it resolves to the card tracked for it.

Hook mode — register as a Claude Code or Codex hook (UserPromptSubmit, PreToolUse,
Notification, Stop); stdin is the hook event, model/tokens come from its transcript:

  tramecli presence --hook claude     (or --hook codex)

It never fails the agent: no tracked card, no app, bad input — it exits 0 silently.

  tramecli presence --install-hooks

Puts the presence hooks back into the active Claude Code config ($CLAUDE_CONFIG_DIR,
else ~/.claude) and Codex's, writing a file only when a hook was missing. Silent and
cheap. For Claude Code, the provider shown is ANTHROPIC_BASE_URL's host (Anthropic
when unset).

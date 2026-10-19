tramecli comment — add an inline agent comment to a page block or database row

Pipe ONE JSON object on stdin (or pass it as the single argument):

  {page_id|page_title, block_id|block_text, body, agent?, meta, in_reply_to?}
  {db_id, row_id|row_title, body, agent?, meta, in_reply_to?}

- block_text: a unique exact quote from the target block.
- row_title: the row's exact title; a title shared by several rows is an error (use row_id).
  The row's thread lives on its database's page, so show and watch pick it up.
- in_reply_to: comment id you are answering — it is marked "answering" before the
  reply and "answered" after, so the UI never shows a stuck spinner.
- agent: id of the model ACTUALLY writing (codex, claude, glm, gemini, …) — attribute
  the real model, not the harness seat; codex/claude get a branded avatar, any other
  id a generated one. Never post as a human.
- meta.model is required: the exact model id you run as (e.g. claude-opus-5); it
  renders as a footer. Running as claude or codex, in/out/ms are required too —
  both harnesses report their own usage, so read it there. Other agents omit what
  they cannot measure; never guess (a visible footer must mean real data).

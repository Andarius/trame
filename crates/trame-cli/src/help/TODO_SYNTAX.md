A todo carries its own dates inline, as `{{trame:<key>=<value>}}` marks at the end
of the line:

  - [ ] Rotate the reader keys {{trame:created_at=2026-08-20}}
  - [x] Ship the writers {{trame:created_at=2026-08-19}} {{trame:completed_at=2026-08-28}}

Keys, all plain `YYYY-MM-DD`:
  due           when it must be done, or rechecked   → pill "⚑ in 2 days" / "⚑ 3 days late"
  created_at    the day the item was raised          → chip "added 2026-08-20"
  completed_at  the day it was finished              → chip "done 2026-08-28"
  updated_at    comma-separated days the line changed → chip "edited 2026-08-30 ×3"

`due` is the one date Trame never stamps: write it when an open item waits on a date
(an expiry, a cooldown) or on someone else (a release, a review) — then it is the day to
check again. Open todos late or due within 7 days show in the sidebar's DUE section,
in a 9:00 desktop digest and in the Claude Code band; `tramecli due` lists them.

`updated_at` is the one list: days are deduped and sorted, only the 5 most recent are
kept, and a day equal to created_at is dropped. The editor appends to it when the text
of a todo changes and when a checked todo is re-opened — re-opening clears
`completed_at`, so nothing else would record it.

Write a mark yourself whenever you know the real date (an item raised last week, a
task finished before it was recorded). Otherwise leave it out: Trame stamps what is
missing on write, and the editor stamps `completed_at` when the checkbox is ticked
and drops it when the box is unticked, so `completed_at` is present exactly when the
todo is checked.

A mark you write is never overwritten, and marks survive a full-page rewrite that
omits them — so a page update does not have to repeat the dates it did not change
(`updated_at` unions both sides rather than picking one).
Quote a block by its visible text when commenting; the marks are not part of it.

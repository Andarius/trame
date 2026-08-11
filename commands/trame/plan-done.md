---
description: Mark the Trame plan as done and clean up
allowed-tools: Bash, Read
---

Mark the current Trame plan as completed.

## Instructions

1. Check `.plan-trame.json` at the project root. If it does not exist, tell the user there is no active plan to mark as done.
2. Add a final agent comment on the plan page's first block noting the plan was implemented (see the `trame-page` skill, `agent` = the real model).
3. Delete `.plan-trame.json` (`rm .plan-trame.json`).
4. Tell the user the plan is closed; the page stays in Trame as the record (archive or delete it in the UI if unwanted).

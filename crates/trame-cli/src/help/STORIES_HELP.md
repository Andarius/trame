tramecli stories — open stories similar to a topic

  tramecli stories -q "<topic>" [--client <project>] [--json]

Lists up to 5 open stories of the project (--client, else the one owning the current
directory) whose title resembles the topic, best first, with a 0–1 score and their open
card count. Run it before naming a story in `tramecli track`: reuse a story that fits
so the session's work lands on one card. Reads only.

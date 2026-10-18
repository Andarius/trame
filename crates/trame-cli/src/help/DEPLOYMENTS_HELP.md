tramecli deployments — how the Deployments plugin matches waiting releases to cards

  tramecli deployments ships                    list every watched repo's rule
  tramecli deployments ships <repo> [flags]     show one repo's rule, or change it

Flags (only the ones given change; the rest keep their value):
  --env production,staging   environments that count (empty string = all)
  --pattern '<regex>'        PR/MR ref in the commit message, one capture group
                             (defaults: GitHub '#(\d+)\b', GitLab '!(\d+)\b')
  --backport | --no-backport a second ref on the same commit is the card's backport
  --reset                    drop the override, back to the forge defaults

<repo> is a watched GitHub repo (owner/name) or GitLab project path; add repos in the
Deployments settings. A waiting release whose commits reference a card's pr_url shows the
card on the deployment and writes one worklog line on the card.

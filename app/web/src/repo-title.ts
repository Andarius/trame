// card titles lead with their repo ("sre-config — fix X"): show it as a chip. repo_path can't
// be used — worktree dirs ("wt-audit") aren't repo names. Ticket refs (GEN-7382) stay in the title.
export function repoTitle(s: { title: string }): { repo: string | null; title: string } {
  const m = s.title.match(/^([\w.-]+) — (.+)$/);
  if (!m || /^[A-Z]+-\d+$/.test(m[1])) return { repo: null, title: s.title };
  return { repo: m[1], title: m[2] };
}

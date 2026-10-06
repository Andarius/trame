// tracked: the card; untracked: app up, no card; offline: app unreachable
export type Link = { kind: 'tracked'; url: string; title: string } | { kind: 'untracked' } | { kind: 'offline' }

declare module 'claude-code' {
  interface PluginState {
    trame: { link: Link | null }
  }
}

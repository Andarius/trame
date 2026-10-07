// tracked: the card; untracked: app up, no card; offline: app unreachable
export type Link = { kind: 'tracked'; url: string; title: string } | { kind: 'untracked' } | { kind: 'offline' }

// todos late, and due within the next 7 days, across all of Trame
export type Due = { late: number; soon: number }

declare module 'claude-code' {
  interface PluginState {
    trame: { link: Link | null; due: Due }
  }
}

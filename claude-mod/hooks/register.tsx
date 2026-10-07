import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Due, Link } from '../types'

const link = atom({ plugin: 'trame', key: 'link' } as const, null)
const dueAtom = atom({ plugin: 'trame', key: 'due' } as const, { late: 0, soon: 0 })
const DAY_MS = 86_400_000

// late = before today, soon = today .. +7 days (the sidebar's DUE window)
export function countDue(dates: string[], today: string): Due {
  const t = Date.parse(today)
  const late = dates.filter(d => Date.parse(d) < t).length
  const soon = dates.filter(d => Date.parse(d) >= t && Date.parse(d) - t <= 7 * DAY_MS).length
  return { late, soon }
}

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const POLL_MS = 15_000
// tramecli's own reply, so a command that only mentions it does not match
const DONE = /tracked in Trame \(done /
const EXIT = 'Exit'

// the app writes its port here on start
async function appBase($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('HOME')
  try {
    const { port } = JSON.parse(await $.fs.read(`${home}/.local/share/trame/port.json`))
    return typeof port === 'number' ? `http://127.0.0.1:${port}` : null
  } catch {
    return null
  }
}

async function refresh($: EngineInterface): Promise<void> {
  let next: Link = { kind: 'offline' }
  const base = await appBase($)
  if (base) {
    try {
      const r = await $.http.fetch(`${base}/api/sessions/${await $.session.id()}?events=1`)
      if (r.ok) {
        const card = JSON.parse(r.text)
        next = { kind: 'tracked', url: `${base}/?view=card&card=${card.id}`, title: card.title }
      }
      else if (r.status === 404) next = { kind: 'untracked' }
      const d = await $.http.fetch(`${base}/api/due`)
      if (d.ok) {
        const dates = (JSON.parse(d.text) as { due: string }[]).map(x => x.due)
        const due = countDue(dates, localDay(new Date(await $.clock.now())))
        await update($, dueAtom, () => due)
      }
    } catch {
      // app gone: stays offline
    }
  }
  await update($, link, () => next)
}

// xdg-open (Linux), else open (macOS); the clipboard when neither works
async function openCard($: EngineInterface, url: string, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']): Promise<void> {
  for (const cmd of ['xdg-open', 'open']) {
    try {
      if ((await $.process.run([cmd, url])).exitCode === 0) return
    } catch {
      // not on this OS
    }
  }
  const r = await $.ui.copy({ text: url, surface })
  $.ui.toast(r.isCopied ? 'Could not open a browser: Trame card link copied' : `Could not open ${url}`)
}

export const register: Register = on => {
  let isDone = false

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError && DONE.test(ran.text ?? '')) isDone = true
    return ran
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await refresh($) // localhost: refused or answered in ms
    $.clock.every(POLL_MS, () => refresh($))
    return next(e)
  })

  // tracking usually happens during a turn: show it right away
  on('turn.complete', async ($, e, next) => {
    void refresh($)
    if (isDone && e.agentId === undefined && !e.isAborted) {
      isDone = false
      // detached: $.command.run rejects inside a hook the turn waits on
      void (async () => {
        const answer = await $.ui.ask('Trame card is done. Exit this session?', [EXIT, 'Stay'])
        if (answer === EXIT) await $.command.run({ command: 'exit' })
      })().catch(err => $.ui.log(`trame: exit prompt failed: ${err}`, { to: 'debug' }))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const l = await read($, link)
    // during a turn the spinner sits above this slot: give it the room
    if (e.props.hasSurvey || e.props.isWorking || !l) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const due = await read($, dueAtom)
    const dueText = l.kind === 'offline' || !(due.late + due.soon) ? null : (
      <Text>
        {'  '}
        {due.late ? <Text color="red">⚑ {due.late} late</Text> : <Text color="yellow">⚑</Text>}
        <Text dimColor>{due.late ? ' · ' : ' '}{due.soon} due</Text>
      </Text>
    )
    if (l.kind !== 'tracked') {
      return (
        <Box marginBottom={1} paddingLeft={1}>
          <Text dimColor>○ trame · {l.kind === 'offline' ? 'offline' : 'no card'}</Text>
          {dueText}
        </Box>
      )
    }
    return (
      <Box marginBottom={1} paddingLeft={1}>
        <Text color="green">● </Text>
        <Text>{l.title.length > 48 ? `${l.title.slice(0, 47)}…` : l.title}</Text>
        <Text> </Text>
        <Button key="open" label="open" onPress={press => openCard($, l.url, press.surface)} />
        {dueText}
      </Box>
    )
  })
}

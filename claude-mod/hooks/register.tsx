import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Link } from '../types'

const link = atom({ plugin: 'trame', key: 'link' } as const, null)
const POLL_MS = 15_000

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
  on('session.start', async ($, e, next) => {
    await refresh($) // localhost: refused or answered in ms
    $.clock.every(POLL_MS, () => refresh($))
    return next(e)
  })

  // tracking usually happens during a turn: show it right away
  on('turn.complete', async ($, e, next) => {
    void refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const l = await read($, link)
    // during a turn the spinner sits above this slot: give it the room
    if (e.props.hasSurvey || e.props.isWorking || !l) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    if (l.kind !== 'tracked') {
      return (
        <Box marginBottom={1} paddingLeft={1}>
          <Text dimColor>○ trame · {l.kind === 'offline' ? 'offline' : 'no card'}</Text>
        </Box>
      )
    }
    return (
      <Box marginBottom={1} paddingLeft={1}>
        <Text color="green">● </Text>
        <Text>{l.title.length > 48 ? `${l.title.slice(0, 47)}…` : l.title}</Text>
        <Text> </Text>
        <Button key="open" label="open" onPress={press => openCard($, l.url, press.surface)} />
      </Box>
    )
  })
}

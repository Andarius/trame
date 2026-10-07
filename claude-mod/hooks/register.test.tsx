import { expect, mock, test } from 'claude-code/testing'

import { countDue } from './register'

const CARD = 'cc31da19-4411-4da3-899e-e51d8169e971'
const json = (status: number, body: unknown) => ({ status, ok: status < 300, headers: {}, text: JSON.stringify(body) })

for (
  const [id, port, response, shown] of [
    ['on a card', 8787, json(200, { id: CARD, title: 'Agent presence on todos' }), { type: 'Text', text: /Agent presence on todos/ }],
    ['no card', 8787, json(404, { error: 'not found' }), { type: 'Text', text: /no card/ }],
    ['offline: no port file', null, null, { type: 'Text', text: /offline/ }],
  ] as const
) {
  test(`band: ${id}`, async ($, on) => {
    mock.clock(on)
    mock.env(on, { HOME: '/home/me' })
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('session.id', async () => ({ value: 'a-claude-session' }))
    on('fs.read', async () => {
      if (port === null) throw new Error('ENOENT')
      return { value: JSON.stringify({ port }) }
    })
    on('http.fetch', async (_$, e) => ({ value: e.url.endsWith('/api/due') ? json(200, []) : response }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'trame', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
    expect(await ui.find(shown)).toBeDefined()
    await ui.unmount()
  })
}

for (
  const [id, exits, opened, copied] of [
    ['xdg-open works', { 'xdg-open': 0 }, ['xdg-open'], []],
    ['macOS: falls back to open', { 'xdg-open': null, open: 0 }, ['xdg-open', 'open'], []],
    ['no opener: copies the link', { 'xdg-open': 1, open: null }, ['xdg-open', 'open'], ['url']],
  ] as const
) {
  test(`open: ${id}`, async ($, on) => {
    const ran: string[] = []
    const clip: string[] = []
    const url = `http://127.0.0.1:8787/?view=card&card=${CARD}`
    mock.clock(on)
    mock.env(on, { HOME: '/home/me' })
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('session.id', async () => ({ value: 'a-claude-session' }))
    on('fs.read', async () => ({ value: JSON.stringify({ port: 8787 }) }))
    on('http.fetch', async (_$, e) => ({ value: e.url.endsWith('/api/due') ? json(200, []) : json(200, { id: CARD, title: 'x' }) }))
    on('process.run', async (_$, e) => {
      const cmd = e.argv[0] as keyof typeof exits
      ran.push(cmd)
      expect(e.argv[1]).toBe(url)
      const code = (exits as Record<string, number | null>)[cmd]
      if (code == null) throw new Error('ENOENT')
      return { value: { exitCode: code, stdout: '', stderr: '' } }
    })
    on('ui.copy', async (_$, e) => {
      clip.push(e.text === url ? 'url' : e.text)
      return { value: { isCopied: true } }
    })
    on('ui.toast', async () => ({ value: undefined }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'trame', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
    await ui.press({ key: 'open' })
    expect([ran, clip]).toEqual([[...opened], [...copied]])
    await ui.unmount()
  })
}

test('the band shows late and due todos next to the card', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-09T10:00:00') })
  mock.env(on, { HOME: '/home/me' })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'a-claude-session' }))
  on('fs.read', async () => ({ value: JSON.stringify({ port: 8787 }) }))
  on('http.fetch', async (_$, e) => ({
    value: e.url.endsWith('/api/due')
      ? json(200, [{ due: '2026-10-06' }, { due: '2026-10-11' }, { due: '2026-10-13' }, { due: '2026-12-01' }])
      : json(200, { id: CARD, title: 'x' }),
  }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'trame', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
  expect(await ui.find({ type: 'Text', text: /1 late/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 due/ })).toBeDefined()
  await ui.unmount()
})

test('countDue: late is before today, due is today up to a week out', () => {
  expect(countDue(['2026-10-08', '2026-10-09', '2026-10-16', '2026-10-17'], '2026-10-09')).toEqual({ late: 1, soon: 2 })
})

const DONE_OUT = `ok: session s1 tracked in Trame (done — repo — x) — http://127.0.0.1:8787/?view=card&card=${CARD}`
for (
  const [id, out, choice, commands] of [
    ['card done, Exit runs /exit', DONE_OUT, 'Exit', ['exit']],
    ['card done, Stay keeps the session', DONE_OUT, 'Stay', []],
    ['card still active: no prompt', DONE_OUT.replace('(done', '(active'), 'Exit', []],
  ] as const
) {
  test(`exit prompt: ${id}`, async ($, on) => {
    const ran: string[] = []
    mock.env(on, { HOME: '/home/me' })
    on('fs.read', async () => {
      throw new Error('ENOENT') // app offline: refresh is a no-op
    })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: out, stderr: '', interrupted: false }, text: out }))
    on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => ({
      result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: choice } },
      text: choice,
    }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    on('command.run', (_$, e) => {
      ran.push(e.command)
      return { text: '' }
    })
    await $.tool.call({ tool: 'Bash', command: 'tramecli track' })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    for (let i = 0; i < 200; i++) await Promise.resolve()
    expect(ran).toEqual([...commands])
  })
}

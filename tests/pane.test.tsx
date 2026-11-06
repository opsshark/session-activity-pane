import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/home/t'
const DIR = `${HOME}/.claude/session-activity-pane`
const RECORD = `${DIR}/sessions/S1.json`
const REPLY = `${DIR}/replies/S1.json`
// 6 Nov 2026, mid-afternoon UTC: "today" in any time zone the tests run in.
const NOW = Date.UTC(2026, 10, 6, 15, 0)

type World = {
  turns?: number
  now?: number
  store?: Record<string, unknown>
  paneOpen?: boolean
}

/** Stands for the engine beneath the mod: an in-memory disk, a store, a prompt queue. */
function world(on: On, opts: World = {}) {
  mock.env(on, { HOME, CLAUDE_CODE_HOST_SESSION_ID: 'local_abc-123' })
  const clock = mock.clock(on, { now: opts.now ?? 1_000 })
  const files = new Map<string, string>()
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  const submitted: string[] = []
  const opened: string[] = []
  const ran: string[][] = []
  let paneOpen = opts.paneOpen ?? false
  on('session.id', () => ({ value: 'S1' }))
  on('session.cwd', () => ({ value: '/Users/t/Git/my-app' }))
  on('session.turns', () => ({ value: opts.turns ?? 0 }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || [...files.keys()].some(p => p.startsWith(`${e.path}/`)) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.list', (_, e) => {
    const dir = `${e.path}/`
    const kinds = new Map<string, 'file' | 'dir'>()
    for (const p of files.keys()) {
      if (!p.startsWith(dir)) continue
      const [name = '', ...rest] = p.slice(dir.length).split('/')
      kinds.set(name, rest.length > 0 ? 'dir' : 'file')
    }
    return {
      value: [...kinds].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: kind === 'file' ? NOW : 0, isLink: false })),
    }
  })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    paneOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: paneOpen ? [{ id: 'sessions', title: 'Sessions', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: '' }))
  const record = () => JSON.parse(files.get(RECORD) ?? '{}')
  const seed = (id: string, fields: Record<string, unknown>) =>
    files.set(
      `${DIR}/sessions/${id}.json`,
      JSON.stringify({ v: 1, id, name: 'app', changedAt: NOW, beatAt: NOW, steps: [], ...fields }),
    )
  return { clock, files, store, submitted, opened, ran, record, seed }
}

const turnEnd = (turnId: string, answer = 'All done.') =>
  ({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' }) as never

const PANE = {
  plugin: 'session-activity-pane',
  component: 'Pane',
  requestId: 'sessions',
  props: {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// ---------- the writer ----------

test('a wrap-up question puts the session in needs-you, and a clicked reply is sent once', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(w.record().state).toBe('idle')
  expect(w.record().name).toBe('my-app')
  expect(w.record().hostId).toBe('local_abc-123')

  await $.turn.start({ text: 'Fix the login redirect please', turnId: 't1' } as never)
  expect(w.record().state).toBe('working')
  expect(w.record().topic).toBe('Fix the login redirect please')

  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Build it', status: 'in_progress' },
      { content: 'Test it', status: 'pending' },
    ],
  } as never)
  await $.tool.call({
    tool: 'mcp__ccd_turn__wrap_up',
    recap: 'Built and tested.',
    ask: 'Ship it?',
    actions: [{ label: 'Yes, ship it' }, { label: 'Not yet' }, { action: 'commit' }],
  } as never)
  // The question waits for the turn to end.
  expect(w.record().ask).toBeUndefined()
  await $.turn.complete(turnEnd('t1'))

  const r = w.record()
  expect(r.state).toBe('needs')
  expect(r.question).toBe('Ship it?')
  expect(r.ask.buttons).toEqual(['Yes, ship it', 'Not yet'])
  expect(r.recap).toBe('Built and tested.')
  expect(r.steps.map((s: { status: string }) => s.status)).toEqual(['completed', 'completed'])

  w.files.set(REPLY, JSON.stringify({ id: 'x1', label: 'Yes, ship it', ask: 'Ship it?', at: 1 }))
  await w.clock.advance(2_000)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]?.startsWith('Yes, ship it')).toBe(true)
  expect(w.record().handledReply).toBe('x1')
  expect(w.record().ask).toBeUndefined()
  // The reply file is emptied once read.
  expect(w.files.get(REPLY)).toBe('')

  await w.clock.advance(4_000)
  expect(w.submitted.length).toBe(1)

  // A reply to a question that no longer stands is marked handled and not sent.
  w.files.set(REPLY, JSON.stringify({ id: 'x2', label: 'Not yet', ask: 'Ship it?', at: 2 }))
  await w.clock.advance(2_000)
  expect(w.submitted.length).toBe(1)
  expect(w.record().handledReply).toBe('x2')
})

test('a turn with no question ends as done, an interrupt as stopped, and the end as closed', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Summarise the README', turnId: 't1' } as never)
  await $.turn.complete(turnEnd('t1', 'The README explains setup.\n\nMore detail here.'))
  expect(w.record().state).toBe('done')
  expect(w.record().recap).toBe('The README explains setup.')

  await $.turn.start({ text: 'Now the tests', turnId: 't2' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' } as never)
  expect(w.record().state).toBe('stopped')
  expect(w.record().reason).toBe('Interrupted')

  await $.session.end({ reason: 'other', sessionId: 'S1' } as never)
  expect(w.record().state).toBe('closed')
})

test('a session that loads the mod after some turns shows as done, not hidden', async ($, on) => {
  const w = world(on, { turns: 4 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(w.record().state).toBe('done')
})

test('a working session checks in every 15 seconds', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Long job', turnId: 't1' } as never)
  const first = w.record().beatAt
  await w.clock.advance(16_000)
  expect(w.record().beatAt).toBeGreaterThan(first)
})

test('a new turn clears the question, so a late click is not sent', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Do it', turnId: 't1' } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Done.', ask: 'Ship it?', actions: [{ label: 'Yes' }] } as never)
  await $.turn.complete(turnEnd('t1'))
  expect(w.record().state).toBe('needs')

  // You answered in the app instead: a new turn starts.
  await $.turn.start({ text: 'yes', turnId: 't2' } as never)
  expect(w.record().ask).toBeUndefined()
  expect(w.record().state).toBe('working')

  w.files.set(REPLY, JSON.stringify({ id: 'x1', label: 'Yes', ask: 'Ship it?', at: 1 }))
  await w.clock.advance(2_000)
  expect(w.submitted.length).toBe(0)
})

test('the sidebar title comes from the Claude app\'s own record of the session', async ($, on) => {
  const w = world(on)
  w.files.set(
    `${HOME}/Library/Application Support/Claude/claude-code-sessions/a/b/local_abc-123.json`,
    JSON.stringify({ title: 'Fix the login redirect' }),
  )
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(w.record().title).toBe('Fix the login redirect')
})

// ---------- the pane ----------

test('/sessions opens the pane and remembers it for new sessions', async ($, on) => {
  const w = world(on, { now: NOW })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(w.opened).toEqual([])

  const answer = await $.command.run({ command: 'sessions', args: '' } as never)
  expect(w.opened).toEqual(['sessions'])
  expect(w.store.get('paneOpen')).toBe(true)
  expect((answer as { text?: string }).text).toContain('Sessions pane opened')
})

test('a remembered pane opens by itself in a new session', async ($, on) => {
  const w = world(on, { now: NOW, store: { paneOpen: true } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(w.opened).toEqual(['sessions'])
})

test('the pane lists sessions that need you first, and a reply button leaves a reply for that session', async ($, on) => {
  const w = world(on, { now: NOW, store: { paneOpen: true } })
  w.seed('S2', {
    title: 'Ship the pricing page',
    hostId: 'local_s2',
    state: 'needs',
    question: 'Ship it?',
    ask: { text: 'Ship it?', buttons: ['Yes, ship it', 'Not yet'], at: NOW },
  })
  w.seed('S3', {
    name: 'api',
    topic: 'Add rate limits',
    state: 'working',
    steps: [
      { id: 'a', text: 'Write the limiter', status: 'completed' },
      { id: 'b', text: 'Test it', status: 'in_progress' },
    ],
  })
  w.seed('S4', { title: 'Quiet one', state: 'working', beatAt: NOW - 5 * 60_000 })
  w.seed('S5', { title: 'Finished earlier', state: 'done', recap: 'All good.', changedAt: NOW - 60 * 60_000 })
  w.seed('S6', { title: 'Yesterday', state: 'done', changedAt: NOW - 30 * 60 * 60_000, beatAt: NOW - 30 * 60 * 60_000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /need.*you/ }))?.text).toBe('● 1 needs you')
    expect(await ui.find({ type: 'Text', text: 'Ship it?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'api · Add rate limits' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Step 2 of 2 · Test it' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'No update for 5m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Done · 1h/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Yesterday' })).toBeUndefined()
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('reply:S2:')).length).toBe(2)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'reply:S2:0' })
  const reply = JSON.parse(w.files.get(`${DIR}/replies/S2.json`) ?? '{}')
  expect(reply.label).toBe('Yes, ship it')
  expect(reply.ask).toBe('Ship it?')
  expect(await ui.find({ type: 'Text', text: /Sending “Yes, ship it”/ })).toBeDefined()

  // S2's own mod acts on it: the pane settles.
  w.seed('S2', { title: 'Ship the pricing page', hostId: 'local_s2', state: 'needs', handledReply: reply.id })
  await w.clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: /Sending/ })).toBeUndefined()

  // Clicking a session opens it in the Claude app.
  await ui.press({ key: 'open:S2' })
  expect(w.ran).toContainEqual(['open', 'claude://claude.ai/epitaxy/local_s2'])

  // The arrow folds out the step list.
  await ui.press({ key: 'fold:S3' })
  expect(await ui.find({ type: 'Text', text: 'Write the limiter' })).toBeDefined()
  await ui.unmount()
})

test('a reply nobody acts on within 30 seconds says so', async ($, on) => {
  const w = world(on, { now: NOW, store: { paneOpen: true } })
  w.seed('S2', {
    title: 'Ship the pricing page',
    state: 'needs',
    ask: { text: 'Ship it?', buttons: ['Yes'], at: NOW },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'reply:S2:0' })
  await w.clock.advance(32_000)
  expect(await ui.find({ type: 'Text', text: /didn't go through/ })).toBeDefined()
  await ui.unmount()
})

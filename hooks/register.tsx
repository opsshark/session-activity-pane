import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Activity,
  ActivityRecord,
  ActivityStep,
  PaneRow,
  PaneView,
  ReplyFile,
  RowStatus,
  SessionState,
  StepStatus,
} from '../types'

// Two halves, both in every session.
//
// The writer keeps this session's record at
// ~/.claude/session-activity-pane/sessions/<id>.json: its state, its question and
// reply buttons, Claude's step list, its last summary and its sidebar title. It also
// watches ~/.claude/session-activity-pane/replies/<id>.json and sends a reply
// clicked in any session's pane into this session, once.
//
// The pane (/sessions) reads every session's record and lists them: sessions that
// need you first, then working ones, then the rest of today's.

const ROOT = '.claude/session-activity-pane'
const APP_SESSIONS = 'Library/Application Support/Claude/claude-code-sessions'
const PANE = 'sessions'
const PANE_TITLE = 'Sessions'
const COMMAND = 'sessions'
const STORE_OPEN = 'paneOpen'

const POLL_MS = 2_000
const BEAT_MS = 15_000
const TITLE_MS = 30_000
const STALL_MS = 3 * 60_000
const REPLY_TIMEOUT_MS = 30_000
const OLDEST_MS = 7 * 24 * 60 * 60_000
const RECAP_MAX = 280
const TOPIC_MAX = 80

const AMBER = '#FFB020'
const BLUE = '#4C8DFF'
const GREEN = '#2FD47A'
const GREY = '#8A8A8F'

const EMPTY: Activity = { state: 'idle', changedAt: 0, steps: [] }
const NO_VIEW: PaneView = { expanded: [], sent: {}, failed: [] }

// Bump a tag when its type's fields change: it declines what an earlier version
// stored, which outlives a reload.
const activity = atom({ plugin: 'session-activity-pane', key: 'activity' } as const, EMPTY, {
  shape: 'activity-1',
})
const rowsAtom = atom({ plugin: 'session-activity-pane', key: 'rows' } as const, [] as PaneRow[], {
  shape: 'rows-1',
})
const viewAtom = atom({ plugin: 'session-activity-pane', key: 'view' } as const, NO_VIEW, {
  shape: 'view-1',
})
const nowAtom = atom({ plugin: 'session-activity-pane', key: 'now' } as const, 0, { shape: 'now-1' })

type Args = Record<string, unknown>

// ---------- reading tool inputs ----------

const STEP_STATUSES: readonly StepStatus[] = ['pending', 'in_progress', 'completed']

function asText(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

function asStepStatus(raw: unknown): StepStatus {
  return STEP_STATUSES.includes(raw as StepStatus) ? (raw as StepStatus) : 'pending'
}

function toSteps(raw: unknown, field: 'content' | 'subject'): ActivityStep[] {
  if (!Array.isArray(raw)) return []
  const steps: ActivityStep[] = []
  raw.forEach((one, index) => {
    if (one === null || typeof one !== 'object') return
    const row = one as Args
    const text = asText(row[field])
    if (text === undefined) return
    steps.push({ id: `step-${index + 1}`, text, status: asStepStatus(row.status) })
  })
  return steps
}

function setStatus(steps: ActivityStep[], index: number, status: StepStatus): ActivityStep[] {
  return steps.map((step, i) => (i === index ? { ...step, status } : step))
}

/** Completes the step in progress and starts the next pending one. */
function advance(steps: ActivityStep[]): ActivityStep[] {
  const current = steps.findIndex(step => step.status === 'in_progress')
  let next = current >= 0 ? setStatus(steps, current, 'completed') : steps
  const from = current >= 0 ? current + 1 : 0
  let upcoming = next.findIndex((step, i) => i >= from && step.status === 'pending')
  if (upcoming < 0) upcoming = next.findIndex(step => step.status === 'pending')
  if (upcoming >= 0) next = setStatus(next, upcoming, 'in_progress')
  return next
}

function oneBased(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : [raw]
  return list.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1)
}

/** One update_plan call, as the desktop app reads it. */
function applyUpdatePlan(a: Activity, args: Args): Activity {
  let steps = a.steps
  if (Array.isArray(args.items)) steps = toSteps(args.items, 'content')
  if (args.advance === true) steps = advance(steps)
  for (const n of oneBased(args.done)) if (n <= steps.length) steps = setStatus(steps, n - 1, 'completed')
  for (const n of oneBased(args.start)) if (n <= steps.length) steps = setStatus(steps, n - 1, 'in_progress')
  return { ...a, steps, stepsSource: 'update_plan' }
}

/** The wrap-up checks every step off, leaves a recap, and maybe a question with reply buttons. */
function applyWrapUp(a: Activity, args: Args, now: number): Activity {
  const next: Activity = {
    ...a,
    steps: a.steps.map(step => ({ ...step, status: 'completed' as const })),
    wrappedThisTurn: true,
  }
  const recap = asText(args.recap)
  if (recap !== undefined) next.recap = clip(recap, RECAP_MAX)
  const ask = asText(args.ask)
  if (ask === undefined) {
    delete next.pendingAsk
    return next
  }
  // Only reply buttons travel: an app action (commit, create a PR) is the app's own.
  const buttons: string[] = []
  if (Array.isArray(args.actions)) {
    for (const one of args.actions) {
      if (one === null || typeof one !== 'object') continue
      const row = one as Args
      const label = asText(row.label)
      if (label !== undefined && row.action === undefined) buttons.push(label)
    }
  }
  next.pendingAsk = { text: ask, buttons, at: now }
  return next
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one
}

/** The prompt's first words, as the session's topic; none for an event the engine raised. */
function topicOf(text: string): string | undefined {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t === '' || t.startsWith('<')) return undefined
  return clip(t, TOPIC_MAX)
}

/** The first paragraph of a turn's answer, as a finished session's summary. */
function recapOf(answer: string): string | undefined {
  const first = answer.split(/\n\s*\n/).find(p => p.trim() !== '' && !p.trim().startsWith('#'))
  return first === undefined ? undefined : clip(first.replace(/[*_`>]/g, ''), RECAP_MAX)
}

/** A new state, stamped with when it changed; the same state keeps its stamp. */
function moveTo(a: Activity, state: SessionState, now: number): Activity {
  return a.state === state ? a : { ...a, state, changedAt: now }
}

function questionOf(args: Args): string | undefined {
  if (!Array.isArray(args.questions)) return undefined
  const first = args.questions[0]
  return first && typeof first === 'object' ? asText((first as Args).question) : undefined
}

// ---------- the writer: this session's record ----------

const HOST_ID = /^local_[A-Za-z0-9-]{1,64}$/

function nameOf(cwd: string): string {
  if (cwd.includes('/scratch-workspaces/')) return 'no folder'
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

async function homeOf($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}

async function paths($: EngineInterface) {
  const home = await homeOf($)
  const id = await $.session.id()
  return {
    home,
    id,
    record: `${home}/${ROOT}/sessions/${id}.json`,
    reply: `${home}/${ROOT}/replies/${id}.json`,
  }
}

// The desktop app's own record of this session holds its sidebar title. Some of
// those files are close to 1 MB, so it is found once and read every 30 seconds.
let appRecord: string | undefined
let appTitle: string | undefined
let titleReadAt = -Infinity

async function findAppRecord($: EngineInterface, home: string, hostId: string): Promise<string | undefined> {
  const root = `${home}/${APP_SESSIONS}`
  if (!(await $.fs.exists(root))) return undefined
  for (const a of await $.fs.list(root)) {
    if (a.kind !== 'dir') continue
    for (const b of await $.fs.list(`${root}/${a.name}`)) {
      if (b.kind !== 'dir') continue
      const path = `${root}/${a.name}/${b.name}/${hostId}.json`
      if (await $.fs.exists(path)) return path
    }
  }
  return undefined
}

/** Re-reads the sidebar title when it is 30 seconds old; says whether it changed. */
async function refreshTitle($: EngineInterface, home: string, hostId: string | undefined, now: number): Promise<boolean> {
  if (hostId === undefined || now - titleReadAt < TITLE_MS) return false
  titleReadAt = now
  try {
    appRecord ??= await findAppRecord($, home, hostId)
    if (appRecord === undefined) return false
    const parsed = JSON.parse(String(await $.fs.read(appRecord))) as Args
    const title = asText(parsed.title)
    if (title === undefined || title === appTitle) return false
    appTitle = clip(title, 120)
    return true
  } catch {
    return false
  }
}

async function hostIdOf($: EngineInterface): Promise<string | undefined> {
  const hostId = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  return hostId && HOST_ID.test(hostId) ? hostId : undefined
}

let lastBeat = 0

async function publish($: EngineInterface): Promise<void> {
  try {
    const a = await read($, activity)
    const p = await paths($)
    const now = await $.clock.now()
    const hostId = await hostIdOf($)
    await refreshTitle($, p.home, hostId, now)
    const record: ActivityRecord = {
      v: 1,
      id: p.id,
      name: nameOf(await $.session.cwd()),
      state: a.state,
      changedAt: a.changedAt || now,
      beatAt: now,
      steps: a.steps,
    }
    if (hostId) record.hostId = hostId
    if (appTitle) record.title = appTitle
    if (a.topic) record.topic = a.topic
    if (a.question) record.question = a.question
    if (a.reason) record.reason = a.reason
    if (a.ask) record.ask = a.ask
    if (a.recap) record.recap = a.recap
    if (a.handledReply) record.handledReply = a.handledReply
    await $.fs.write(p.record, JSON.stringify(record))
    lastBeat = now
  } catch {
    // The pane is a convenience: never let a write break the session.
  }
}

async function change($: EngineInterface, fn: (a: Activity, now: number) => Activity): Promise<void> {
  const now = await $.clock.now()
  await update($, activity, a => fn(a, now))
  await publish($)
}

function isReply(value: unknown): value is ReplyFile {
  const r = value as Partial<ReplyFile> | null
  return typeof r === 'object' && r !== null && typeof r.id === 'string' && typeof r.label === 'string' && typeof r.ask === 'string'
}

/** Sends a reply clicked in a pane, once, and only while its question still stands. */
async function pollReply($: EngineInterface): Promise<void> {
  const p = await paths($)
  if (!(await $.fs.exists(p.reply))) return
  let reply: unknown
  try {
    reply = JSON.parse(String(await $.fs.read(p.reply)))
  } catch {
    return
  }
  if (!isReply(reply)) return
  const a = await read($, activity)
  if (a.handledReply === reply.id) return
  const stands = a.ask !== undefined && a.ask.text === reply.ask && a.ask.buttons.includes(reply.label)
  await update($, activity, s => {
    const next: Activity = { ...s, handledReply: reply.id }
    if (stands) delete next.ask
    return next
  })
  await publish($)
  // Empty the file, so nothing reads the reply again.
  await $.fs.write(p.reply, '').catch(() => {})
  if (!stands) return
  await $.prompt.submit({ text: `${reply.label}\n\n(Sent with a reply button in the Sessions pane.)` })
}

// ---------- the pane: every session's record ----------

const ORDER: Record<RowStatus, number> = { needs: 0, working: 1, stalled: 2, stopped: 3, done: 4, closed: 5 }

const LABEL: Record<RowStatus, string> = {
  needs: 'Needs you',
  working: 'Working',
  stalled: 'No update',
  stopped: 'Stopped',
  done: 'Done',
  closed: 'Closed',
}

const COLOR: Record<RowStatus, string> = {
  needs: AMBER,
  working: BLUE,
  stalled: GREY,
  stopped: GREY,
  done: GREEN,
  closed: GREY,
}

/** "now", "5m", "2h", "3d" */
function ago(ms: number, now: number): string {
  const m = Math.floor(Math.max(0, now - ms) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`
}

function isRecord(value: unknown): value is ActivityRecord {
  const r = value as Partial<ActivityRecord> | null
  return (
    typeof r === 'object' &&
    r !== null &&
    r.v === 1 &&
    typeof r.id === 'string' &&
    typeof r.state === 'string' &&
    typeof r.changedAt === 'number' &&
    typeof r.beatAt === 'number' &&
    Array.isArray(r.steps)
  )
}

function makeRow(a: ActivityRecord, now: number): PaneRow | undefined {
  let status: RowStatus
  let detail: string
  switch (a.state) {
    case 'needs':
      status = 'needs'
      detail = a.ask?.text ?? a.question ?? 'Waiting for you'
      break
    case 'working': {
      if (now - a.beatAt > STALL_MS) {
        status = 'stalled'
        detail = `No update for ${ago(a.beatAt, now)}`
        break
      }
      status = 'working'
      const i = a.steps.findIndex(step => step.status === 'in_progress')
      detail = i >= 0 ? `Step ${i + 1} of ${a.steps.length} · ${a.steps[i]?.text}` : (a.topic ?? 'Working')
      break
    }
    case 'stopped':
      status = 'stopped'
      detail = a.reason ?? 'Stopped'
      break
    case 'done':
      status = 'done'
      detail = a.recap ?? a.topic ?? 'Finished'
      break
    case 'closed':
      status = 'closed'
      detail = a.recap ?? 'Session closed'
      break
    default:
      return undefined // idle: nothing has happened yet
  }
  // The sidebar's title; a terminal session falls back to its folder and latest prompt.
  const title = a.title ?? (a.topic ? `${a.name} · ${a.topic}` : a.name)
  const row: PaneRow = { id: a.id, title, status, detail, changedAt: a.changedAt, steps: a.steps }
  if (a.hostId && HOST_ID.test(a.hostId)) row.hostId = a.hostId
  // Buttons only while the session is waiting on that very question.
  if (status === 'needs' && a.ask) row.ask = a.ask
  if (a.handledReply) row.handledReply = a.handledReply
  return row
}

function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

let lastRows = ''

/** Reads every session's record into the pane's rows, and settles replies the pane sent. */
async function refresh($: EngineInterface): Promise<void> {
  const home = await homeOf($)
  const now = await $.clock.now()
  const minute = Math.floor(now / 60_000) * 60_000
  if ((await read($, nowAtom)) !== minute) await update($, nowAtom, () => minute)

  const dir = `${home}/${ROOT}/sessions`
  const entries = (await $.fs.exists(dir)) ? await $.fs.list(dir) : []
  const records: ActivityRecord[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (entry.mtimeMs > 0 && now - entry.mtimeMs > OLDEST_MS) continue
    try {
      const parsed: unknown = JSON.parse(String(await $.fs.read(`${dir}/${entry.name}`)))
      if (isRecord(parsed)) records.push(parsed)
    } catch {
      // A record mid-write, or not ours: the next poll reads it.
    }
  }

  const today = startOfDay(now)
  const rows = records
    .filter(a => Math.max(a.changedAt, a.beatAt) >= today || a.state === 'needs')
    .map(a => makeRow(a, now))
    .filter((row): row is PaneRow => row !== undefined)
    .sort((x, y) => ORDER[x.status] - ORDER[y.status] || y.changedAt - x.changedAt)
  const json = JSON.stringify(rows)
  if (json !== lastRows) {
    lastRows = json
    await update($, rowsAtom, () => rows)
  }

  // A reply is settled once its session records it, or given up on after 30 seconds.
  const view = await read($, viewAtom)
  const handled = new Map(records.map(a => [a.id, a.handledReply]))
  const due = Object.entries(view.sent).filter(
    ([id, sent]) => handled.get(id) === sent.reply || now - sent.at > REPLY_TIMEOUT_MS,
  )
  if (due.length === 0) return
  await update($, viewAtom, v => {
    const sent = { ...v.sent }
    const failed = [...v.failed]
    for (const [id, pending] of Object.entries(v.sent)) {
      if (handled.get(id) === pending.reply) delete sent[id]
      else if (now - pending.at > REPLY_TIMEOUT_MS) {
        delete sent[id]
        if (!failed.includes(id)) failed.push(id)
      }
    }
    return { ...v, sent, failed }
  })
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
  await refresh($).catch(() => {})
}

async function sendReply($: EngineInterface, row: PaneRow, label: string): Promise<void> {
  const ask = row.ask
  if (ask === undefined) return
  const home = await homeOf($)
  const now = await $.clock.now()
  const reply: ReplyFile = { id: `r${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, label, ask: ask.text, at: now }
  try {
    await $.fs.write(`${home}/${ROOT}/replies/${row.id}.json`, JSON.stringify(reply))
    await update($, viewAtom, v => ({
      ...v,
      sent: { ...v.sent, [row.id]: { reply: reply.id, label, at: now } },
      failed: v.failed.filter(id => id !== row.id),
    }))
  } catch {
    await update($, viewAtom, v => ({ ...v, failed: v.failed.includes(row.id) ? v.failed : [...v.failed, row.id] }))
  }
}

/** Opens the session in the Claude app; with no app id, brings the app forward. */
async function openSession($: EngineInterface, row: PaneRow): Promise<void> {
  const argv = row.hostId
    ? ['open', `claude://claude.ai/epitaxy/${row.hostId}`]
    : ['open', '-b', 'com.anthropic.claudefordesktop']
  await $.process.run(argv, { timeoutMs: 5_000 }).catch(() => {})
}

async function toggle($: EngineInterface, id: string): Promise<void> {
  await update($, viewAtom, v => ({
    ...v,
    expanded: v.expanded.includes(id) ? v.expanded.filter(one => one !== id) : [...v.expanded, id],
  }))
}

async function tick($: EngineInterface): Promise<void> {
  await pollReply($)
  const now = await $.clock.now()
  const a = await read($, activity)
  // A working session checks in, so a dead one reads as stalled.
  if (a.state === 'working' && now - lastBeat >= BEAT_MS) await publish($)
  // A title the app gave the session since its last write.
  else if (a.state !== 'idle' && (await refreshTitle($, await homeOf($), await hostIdOf($), now))) await publish($)
  if (await isPaneOpen($)) await refresh($)
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({ name: COMMAND, description: 'Show every Claude session in a pane' })
    // A session that loads this mod part-way through (an update, a resume) is
    // between turns: it shows as done rather than vanishing until its next turn.
    const a = await read($, activity)
    if (a.state === 'idle' && (await $.session.turns().catch(() => 0)) > 0) {
      const now = await $.clock.now()
      await update($, activity, s => moveTo(s, 'done', now))
    }
    await publish($)
    // Opened once with /sessions, the pane opens in new sessions until it is closed.
    if ((await $.store.get(STORE_OPEN)) === true) await openPane($).catch(() => {})
    $.clock.every(POLL_MS, () => {
      void tick($).catch(() => {})
    })
    return ran
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.store.set(STORE_OPEN, true)
    await openPane($)
    return { text: 'Sessions pane opened. It opens in new sessions too, until you close it.' }
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set(STORE_OPEN, false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await change($, () => EMPTY)
    else await change($, (a, now) => moveTo(a, 'closed', now))
    return next(e)
  })

  // A new turn on the main loop: the session is working, and any earlier question was answered.
  on('turn.start', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      await change($, (a, now) => {
        const fresh: Activity = { ...moveTo(a, 'working', now), wrappedThisTurn: false }
        const topic = topicOf(e.text)
        if (topic !== undefined) fresh.topic = topic
        delete fresh.ask
        delete fresh.pendingAsk
        delete fresh.question
        delete fresh.reason
        return fresh
      })
    }
    return ran
  })

  // The turn's end settles where the session stands: waiting on you, finished or stopped.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      await change($, (a, now) => {
        let s: Activity = { ...a }
        if (!s.wrappedThisTurn) {
          const recap = recapOf(e.answer)
          if (recap !== undefined) s.recap = recap
        }
        if (e.reason === 'aborted' || e.reason === 'error' || e.reason === 'refusal') {
          s = moveTo(s, 'stopped', now)
          s.reason = e.reason === 'aborted' ? 'Interrupted' : e.reason === 'error' ? 'Stopped on an error' : 'Declined the request'
          delete s.pendingAsk
          return s
        }
        const asked = s.pendingAsk
        if (asked) {
          s = moveTo(s, 'needs', now)
          s.ask = asked
          s.question = asked.text
          delete s.pendingAsk
          return s
        }
        return moveTo(s, 'done', now)
      })
    }
    return ran
  })

  // A question card open in the app: the session waits on you until it is answered.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const question = questionOf(e as unknown as Args)
    await change($, (a, now) => {
      const s = moveTo(a, 'needs', now)
      return question === undefined ? s : { ...s, question }
    })
    const ran = await next(e)
    await change($, (a, now) => {
      const s = moveTo(a, 'working', now)
      delete s.question
      return s
    })
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await change($, a => applyUpdatePlan(a, e as unknown as Args))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await change($, (a, now) => applyWrapUp(a, e as unknown as Args, now))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Claude Code's own to-do list, in a terminal session.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const todos = (e as unknown as Args).todos
      await change($, a => ({ ...a, steps: toSteps(todos, 'content'), stepsSource: 'todos' }))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Claude Code's task tools, in a terminal session.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const made = ran.result as unknown as { task?: { id?: unknown; subject?: unknown } } | undefined
      const subject = asText(made?.task?.subject) ?? asText((e as unknown as Args).subject)
      if (subject !== undefined) {
        await change($, a => {
          const kept = a.stepsSource === 'tasks' ? a.steps : []
          const id = asText(made?.task?.id) ?? `task-${kept.length + 1}`
          return {
            ...a,
            steps: [...kept.filter(step => step.id !== id), { id, text: subject, status: 'pending' }],
            stepsSource: 'tasks',
          }
        })
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const args = e as unknown as Args
      const id = asText(args.taskId)
      if (id !== undefined) {
        await change($, a => {
          if (a.stepsSource !== 'tasks') return a
          if (args.status === 'deleted') return { ...a, steps: a.steps.filter(step => step.id !== id) }
          return {
            ...a,
            steps: a.steps.map(step =>
              step.id === id
                ? {
                    ...step,
                    text: asText(args.subject) ?? step.text,
                    status: typeof args.status === 'string' ? asStepStatus(args.status) : step.status,
                  }
                : step,
            ),
          }
        })
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ---------- drawing the pane ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = await read($, rowsAtom)
    const view = await read($, viewAtom)
    const now = (await read($, nowAtom)) || (await $.clock.now())
    const self = await $.session.id()
    const cols = e.props.bodyColumns
    // Titles are cut to one line by hand: a Button's label wraps on the terminal.
    const fit = (text: string, room: number) => (room >= 8 && text.length > room ? clip(text, room) : text)

    const needs = rows.filter(row => row.status === 'needs')
    const active = rows.filter(row => row.status === 'working' || row.status === 'stalled')
    const earlier = rows.filter(row => ORDER[row.status] >= ORDER.stopped)

    const section = (label: string) => (
      <Box marginTop={1}>
        <Text dimColor bold>
          {label}
        </Text>
      </Box>
    )

    const steps = (row: PaneRow) =>
      row.steps.length === 0 ? (
        <Text dimColor>No steps yet.</Text>
      ) : (
        <Box flexDirection="column">
          {row.steps.map(step => (
            <Box flexDirection="row" gap={1}>
              <Text color={step.status === 'completed' ? GREEN : step.status === 'in_progress' ? BLUE : GREY}>
                {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '◉' : '○'}
              </Text>
              <Text dimColor={step.status === 'completed'} bold={step.status === 'in_progress'}>
                {step.text}
              </Text>
            </Box>
          ))}
        </Box>
      )

    const bar = (row: PaneRow) => (
      <Box flexDirection="row">
        {row.steps.map(step => (
          <Text color={step.status === 'completed' ? GREEN : step.status === 'in_progress' ? BLUE : GREY}>
            {step.status === 'pending' ? '▱' : '▰'}
          </Text>
        ))}
      </Box>
    )

    const replies = (row: PaneRow) => {
      const sent = view.sent[row.id]
      if (sent) {
        return (
          <Text dimColor italic>
            Sending “{sent.label}”…
          </Text>
        )
      }
      if (!row.ask || row.ask.buttons.length === 0) return undefined
      return (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {row.ask.buttons.map((label, i) => (
            <Button
              key={`reply:${row.id}:${i}`}
              label={label}
              variant={i === 0 ? 'primary' : 'secondary'}
              onPress={() => void sendReply($, row, label)}
            />
          ))}
        </Box>
      )
    }

    const card = (row: PaneRow) => {
      const isOpen = view.expanded.includes(row.id)
      return (
        <Box
          key={`card:${row.id}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={row.status === 'needs' ? AMBER : GREY}
          borderDimColor={row.status !== 'needs'}
          paddingX={1}
        >
          <Box flexDirection="row" gap={1}>
            <Button
              key={`fold:${row.id}`}
              plain
              dimColor
              label={isOpen ? '▾' : '▸'}
              onPress={() => void toggle($, row.id)}
            />
            <Text color={COLOR[row.status]}>●</Text>
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Button key={`open:${row.id}`} plain onPress={() => void openSession($, row)}>
                <Text bold wrap="truncate-end">
                  {fit(row.title, cols - 10 - ago(row.changedAt, now).length - (row.id === self ? 5 : 0))}
                </Text>
              </Button>
            </Box>
            <Box flexShrink={0} flexDirection="row" gap={1}>
              {row.id === self && <Text dimColor>here</Text>}
              <Text dimColor>{ago(row.changedAt, now)}</Text>
            </Box>
          </Box>
          <Box flexDirection="column" paddingLeft={4}>
            <Text dimColor={row.status !== 'needs'}>{row.detail}</Text>
            {row.status === 'working' && row.steps.length > 1 && bar(row)}
            {replies(row)}
            {view.failed.includes(row.id) && (
              <Text color={GREY}>That reply didn't go through. Answer in Claude instead.</Text>
            )}
            {isOpen && steps(row)}
          </Box>
        </Box>
      )
    }

    const line = (row: PaneRow) => (
      <Box key={`line:${row.id}`} flexDirection="row" gap={1}>
        <Text color={COLOR[row.status]}>●</Text>
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Button key={`open:${row.id}`} plain dimColor onPress={() => void openSession($, row)}>
            <Text wrap="truncate-end">
              {fit(row.title, cols - 4 - `${LABEL[row.status]} · ${ago(row.changedAt, now)}`.length - (row.id === self ? 5 : 0))}
            </Text>
          </Button>
        </Box>
        <Box flexShrink={0} flexDirection="row" gap={1}>
          {row.id === self && <Text dimColor>here</Text>}
          <Text dimColor>
            {LABEL[row.status]} · {ago(row.changedAt, now)}
          </Text>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Box flexGrow={1}>
            <Text bold>Sessions</Text>
          </Box>
          {needs.length > 0 && (
            <Text color={AMBER}>
              ● {needs.length} need{needs.length === 1 ? 's' : ''} you
            </Text>
          )}
          {active.length > 0 && <Text color={BLUE}>● {active.length} working</Text>}
        </Box>
        {rows.length === 0 && <Text dimColor>No sessions today yet.</Text>}
        {needs.length > 0 && section('NEEDS YOU')}
        {needs.map(card)}
        {active.length > 0 && section('WORKING')}
        {active.map(card)}
        {earlier.length > 0 && section('EARLIER TODAY')}
        {earlier.map(line)}
        <Box marginTop={1}>
          <Text dimColor>
            {rows.length} session{rows.length === 1 ? '' : 's'} today
          </Text>
        </Box>
      </Box>
    )
  })
}

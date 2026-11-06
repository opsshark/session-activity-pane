export type StepStatus = 'pending' | 'in_progress' | 'completed'

export type ActivityStep = { id: string; text: string; status: StepStatus }

/** The question a wrap-up left, with the reply buttons it offered. */
export type ActivityAsk = { text: string; buttons: string[]; at: number }

export type StepsSource = 'update_plan' | 'todos' | 'tasks'

/** Where a session stands: nothing yet, a turn running, waiting on you, ended by an error or interrupt, finished, closed. */
export type SessionState = 'idle' | 'working' | 'needs' | 'stopped' | 'done' | 'closed'

/** This session's own activity, which it writes to its record. */
export type Activity = {
  state: SessionState
  /** When `state` last changed, ms since the epoch. */
  changedAt: number
  /** The first words of your latest prompt. */
  topic?: string
  /** What the session is asking you, while it waits. */
  question?: string
  /** Why it stopped. */
  reason?: string
  steps: ActivityStep[]
  stepsSource?: StepsSource
  ask?: ActivityAsk
  /** A wrap-up's question, held until the turn ends. */
  pendingAsk?: ActivityAsk
  recap?: string
  /** Set while a turn has called wrap_up, so turn.complete keeps its recap. */
  wrappedThisTurn?: boolean
  /** The id of the last reply a pane sent that this session acted on. */
  handledReply?: string
}

/** The file each session writes: ~/.claude/session-activity-pane/sessions/<id>.json */
export type ActivityRecord = {
  v: 1
  id: string
  /** The folder's name; "no folder" for a session the app started without one. */
  name: string
  /** The sidebar title the Claude desktop app gave the session, when it has one. */
  title?: string
  /** The desktop app's id for the session (`local_…`); absent in a terminal session. */
  hostId?: string
  state: SessionState
  changedAt: number
  /** The last check-in; a working session that stops checking in reads as stalled. */
  beatAt: number
  topic?: string
  question?: string
  reason?: string
  steps: ActivityStep[]
  ask?: ActivityAsk
  recap?: string
  handledReply?: string
}

/** What a reply button leaves for the session it answers: ~/.claude/session-activity-pane/replies/<id>.json */
export type ReplyFile = { id: string; label: string; ask: string; at: number }

/** How a row in the pane reads: waiting on you, working, gone quiet, or finished one way or another. */
export type RowStatus = 'needs' | 'working' | 'stalled' | 'stopped' | 'done' | 'closed'

/** One session as the pane shows it. */
export type PaneRow = {
  id: string
  title: string
  status: RowStatus
  detail: string
  changedAt: number
  hostId?: string
  steps: ActivityStep[]
  /** Present only while the session waits on that very question. */
  ask?: ActivityAsk
  handledReply?: string
}

/** A reply this pane sent, until the session acts on it. */
export type PendingReply = { reply: string; label: string; at: number }

/** What this session's pane remembers while it is open. */
export type PaneView = {
  /** Rows whose step list is folded out. */
  expanded: string[]
  /** Session id -> the reply sent to it. */
  sent: Record<string, PendingReply>
  /** Sessions a reply did not reach. */
  failed: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-activity-pane': {
      activity: Shaped<Activity>
      rows: Shaped<PaneRow[]>
      view: Shaped<PaneView>
      /** The current minute, so ages ("5m") redraw once a minute. */
      now: Shaped<number>
    }
  }
}

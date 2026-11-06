# Sessions pane for Claude Code

A Claude Code mod that adds a **Sessions** pane: every Claude Code session on your Mac, in one list, beside the chat. Sessions that need you sort to the top, with their question and reply buttons. Working sessions show their current step. Click a session to jump to it.

```
Sessions                                ● 1 needs you  ● 1 working

NEEDS YOU
╭──────────────────────────────────────────────────────────────╮
│ ▸ ● Ship the pricing page                                now │
│     OK to deploy the pricing page to production?             │
│     [ Yes, deploy ]  [ Not yet ]                             │
╰──────────────────────────────────────────────────────────────╯

WORKING
╭──────────────────────────────────────────────────────────────╮
│ ▾ ● api · Add rate limits                                 2m │
│     Step 2 of 3 · Test the limiter                           │
│     ▰▰▱                                                      │
│     ✓ Write the limiter                                      │
│     ◉ Test the limiter                                       │
│     ○ Update the docs                                        │
╰──────────────────────────────────────────────────────────────╯

EARLIER TODAY
● Fix the login redirect                              Done · 1h
● Weekly report                                    Stopped · 3h

3 sessions today
```

## Install

From a shell:

```bash
claude plugin install session-activity-pane --marketplace opsshark/session-activity-pane
```

Or at the prompt of a terminal Claude Code session:

```
/plugin install session-activity-pane --marketplace opsshark/session-activity-pane
```

Answer `y` to add the marketplace, then pick the user scope, so the mod runs in every session.

In the Claude desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**. Choose **Add marketplace** and enter `opsshark/session-activity-pane`, then **Add plugin**.

**Installing with Claude:** paste this into a Claude Code session on the Mac:

> Install the Sessions pane mod from the GitHub repo opsshark/session-activity-pane. Follow its INSTALL.md (https://raw.githubusercontent.com/opsshark/session-activity-pane/main/INSTALL.md).

## Use it

- Type `/sessions` in any session to open the pane.
- Once opened, it opens by itself in new sessions too. Close it with its ✕ (ctrl+x x in the terminal) to stop that.
- **Reply buttons** answer that session's next-step question for you. The reply is sent once, and only while the same question still stands.
- **Click a title** to open that session in the Claude desktop app. A terminal session has no app page, so this brings the app forward instead.
- **The arrow** (▸) on a card folds out Claude's step list.
- Rows stay for the day. A session waiting on you stays until you answer it, for up to a week.

## How it works

The mod runs in every session and has two halves.

- **The writer** keeps one small file per session at `~/.claude/session-activity-pane/sessions/<session id>.json`. The file holds the session's state (working, needs you, stopped, done, closed), its question and reply buttons from the desktop app's next-step box, Claude's step list and its last summary. It also holds the sidebar title, read from the desktop app's own record of the session. A working session checks in every 15 seconds, so one that dies shows as "No update".
- **The pane** reads those files every 2 seconds while it's open. A reply button writes `~/.claude/session-activity-pane/replies/<session id>.json`. The target session's own writer picks that file up and sends the reply as a prompt.

Everything stays on your Mac. The mod makes no network calls.

**Works with:** Claude Code with mods (function-hook plugins), tested on 2.1.312. Use it in the Claude desktop app's Code tab or in a terminal session. Titles and click-to-open need the desktop app. A terminal session shows its folder and latest prompt instead.

The sidebar titles come from the desktop app's internal session files (`~/Library/Application Support/Claude/claude-code-sessions/`). If an app update changes them, rows fall back to folder names.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

See [CLAUDE.md](CLAUDE.md) for the layout and how changes reach installed copies.

## License

MIT

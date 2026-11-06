Org: OpsShark

# Sessions pane (session-activity-pane)

A Claude Code mod: a `/sessions` pane that lists every Claude Code session on the Mac. Public GitHub repo `opsshark/session-activity-pane`. It uses no Vercel or Supabase.

It is the in-Claude twin of the Session Activity Mac window (a separate, private repo). The two share no files: this mod keeps its own folder, `~/.claude/session-activity-pane/`, so either works alone.

**Installing it on a Mac:** follow [INSTALL.md](INSTALL.md).

## Layout

- `.claude-plugin/plugin.json` — the manifest. Its `version` decides whether installed copies update.
- `.claude-plugin/marketplace.json` — makes this repo a one-plugin marketplace, also named `session-activity-pane`.
- `hooks/register.tsx` — the whole mod:
  - **the writer** tracks this session (turns, `update_plan`, `wrap_up`, AskUserQuestion, TodoWrite, TaskCreate/TaskUpdate). It writes `sessions/<id>.json` and sends replies it finds in `replies/<id>.json`;
  - **the pane** reads every record every 2 s while it's open, and draws the `Pane` with id `sessions`.
- `types/index.d.ts` — the state contract and file shapes (`ActivityRecord`, `v: 1`; `ReplyFile`).
- `tests/pane.test.tsx` — run with `claude plugin test .`.

## Where it's installed

- **The author's main Mac:** this repo is the folder `~/.claude/mods/session-activity-pane`. It installs through the local `travis-mods` marketplace (`~/.claude/mods`) as `session-activity-pane@travis-mods`. Don't also add the GitHub marketplace there.
- **Everywhere else:** from GitHub, as `session-activity-pane@session-activity-pane`.

## Making a change

1. Edit the files. If a stored type's fields change, bump its atom's `shape` tag in `register.tsx`. If the record's shape changes, bump `v`, which the pane checks.
2. Bump `version` in `.claude-plugin/plugin.json`.
3. Run `claude plugin validate .` and `claude plugin test .`.
4. To try it in a real session, run `claude "/sessions"` in a terminal: the pane docks beside the chat.
5. Commit and push to `main`.
6. On the main Mac, run `claude plugin marketplace update travis-mods && claude plugin update session-activity-pane@travis-mods`.

## Keep in mind

- `$.fs` has no delete. A handled reply file is emptied (written as `""`), not removed.
- A Button's label wraps on the terminal, so titles are cut by hand to `bodyColumns` (`fit` in the render hook).
- Click-to-open runs `open claude://claude.ai/epitaxy/<local id>`. That link, `CLAUDE_CODE_HOST_SESSION_ID` and the `title` field in the app's `claude-code-sessions` files are the desktop app's internals. An app update can change any of them.
- Whether the pane opens by itself lives in `$.store` (`paneOpen`). `/sessions` sets it, and closing the pane by hand clears it.
- The test kit can't raise a person's pane close (`ui.close` is an op event), so that path has no test.

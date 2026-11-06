# Installing the Sessions pane: steps for a Claude agent

You are installing the `session-activity-pane` mod on this Mac for the person you're working with. It's a Claude Code plugin from the public GitHub repo `opsshark/session-activity-pane`. It adds a `/sessions` pane that lists every Claude Code session.

Do the steps in order and run each command yourself. Check each result against its **Check** line before moving on. Install nothing this guide doesn't name.

## 1. Check Claude Code

```bash
claude --version
```

**Check:** a version prints. The mod is tested on 2.1.312. If the version is older, run `claude update`.

If `claude` isn't found, ask the person to install the Claude Code command line. They run this in Terminal: `curl -fsSL https://claude.ai/install.sh | bash`. Then open a new shell and check again.

## 2. Install the mod

```bash
claude plugin marketplace add opsshark/session-activity-pane
claude plugin install session-activity-pane@session-activity-pane --scope user
```

**Check:** `claude plugin list` shows `session-activity-pane@session-activity-pane` as enabled.

## 3. Validate it

```bash
REPO="$(plutil -extract session-activity-pane.installLocation raw -o - ~/.claude/plugins/known_marketplaces.json)"
claude plugin validate "$REPO"
```

**Check:** it ends with "Validation passed". If it reports errors about the hooks module, Claude Code is too old: run `claude update` and try again.

## 4. Tell the person how to use it

- The mod runs in sessions that start after the install. Sessions already open pick it up after the Claude app restarts.
- Type `/sessions` in a session to open the pane. After that it opens in new sessions by itself, until they close it.
- Sessions that need them sort to the top, with the question and reply buttons.
- Click a title to open that session. The ▸ arrow folds out its step list.

## Updating later

```bash
claude plugin marketplace update session-activity-pane
claude plugin update session-activity-pane@session-activity-pane
```

Open sessions reload the mod once idle, but only when the version in `.claude-plugin/plugin.json` changed.

## Uninstalling

```bash
claude plugin uninstall session-activity-pane@session-activity-pane
claude plugin marketplace remove session-activity-pane
```

The per-session files are in `~/.claude/session-activity-pane/`. Move that folder to the Trash only after the person confirms.

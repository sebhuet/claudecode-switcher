# ClaudeCode Switcher

**Several Claude Code accounts on one project, or one account per project.
Switch from the status bar. Never log out again.**

Two things this does:

1. **Use several accounts on the same project.** Hit a rate limit? Click the
   status bar, pick the next account, start a new conversation in the same
   folder. Your sessions, auto-memory, skills and settings are all still there.
   Nothing logs out, nothing reloads, the conversation list does not change.
2. **Use a different account for each project.** Work account in the work repo,
   personal in the side project, a client's in theirs. Route a folder once and
   every new conversation there uses the right account, automatically. All of
   them can run at the same time in one window.

Every account keeps its own login and its own usage limits. Everything else is
one store: sessions, memory, skills, settings and MCP config stay in
`~/.claude`, whichever account is talking. Start a chat under `Work`, resume it
under `Personal` tomorrow, and every note Claude saved to memory is already
there. This happens automatically; there is nothing to configure.

## Why

- **Rate limit hit? Switch, keep going.** Same folder, same history, same
  memory, next account.
- **Right account per project, every time.** Route folders once. No more
  checking which account is signed in before you start.
- **Nothing to remember.** The status bar always shows which account a new
  conversation in this folder will use, and why.
- **Nothing to undo.** Disable routing puts every setting back exactly as it
  was. Accounts are plain directories you can delete.

## Quick start

1. Install, then install the official Claude Code extension if you have not.
2. Click **Claude: default** in the status bar → **Add another account…** → name it.
3. The folder is routed to it and a sign-in opens. Sign in.
4. Open another folder, click the status bar, pick a different account. Both run at once.

Confirm with `/usage` inside a conversation: it names the billing account.

## Requirements

- The official Claude Code extension (installed automatically as a dependency).
- macOS, Linux, WSL, code-server or Windows 10/11.
- `node` on your `PATH`, or VS Code's own runtime is used as a fallback.

### Windows

- The official extension starts the wrapper without a shell, so on Windows it is
  a small `.exe` compiled on activation from generated C# source
  (`_bin/claudecode-switcher-wrapper.cs`) with the `csc.exe` that ships with
  .NET Framework 4 on every Windows 10/11. The child `claude.exe` is tied to
  the wrapper by a job object, so stopping a conversation stops both.
- Shared accounts link folders with junctions (no rights needed) and four files
  (`settings.json`, `CLAUDE.md`, `keybindings.json`, `history.jsonl`) with
  symlinks, which Windows only allows with **Developer Mode** on
  (Settings > System > For developers). Without it, adding an account fails
  with a message saying so, before anything is created.

## The status bar is the whole UI

Click **Claude: <account>** in the status bar. The menu is the account list:
the account the current folder uses is marked, accounts not signed in yet say
so, and picking one routes the folder to it (and opens sign-in if needed).

Below the list:

- **Add another account…**: name it, sign in, done.
- **Open Login Terminal**: sign an account in from a terminal instead (needs `claude` on `PATH`).
- **More…**: remove an account, check health, show status, disable or enable routing.

There are no command palette entries.

## How it works

The official Claude Code extension has a `claudeCode.claudeProcessWrapper`
setting. With your consent this extension points it at a generated script under
`~/.claude-profiles/_bin/`. Each time the official extension starts a **new**
Claude process, the wrapper asks one resolver which `CLAUDE_CONFIG_DIR` that
process should get, exports it, and execs the real binary untouched.

An account is a directory holding only its login; everything else in it is a
symlink back into `~/.claude`. That is why sessions, memory and settings are
the same whichever account you pick.

Resolution order (first match wins):

1. `CLAUDE_CONFIG_DIR` already set in the environment: respected, nothing changes.
2. `CLAUDE_PROFILE=<name>`.
3. A `.claude-profile` file in the folder or any parent up to `$HOME`.
4. The longest matching folder prefix in `~/.claude-profiles/map.conf`.
5. Otherwise the `default` account, which is plain `~/.claude` with the variable left unset.

Running conversations keep the account they started with. Nothing is ever
logged out. No window reloads.

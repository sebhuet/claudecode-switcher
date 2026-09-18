# Changelog

## 0.1.0

Initial release.

**Use several Claude Code accounts on one project, or one account per project,
without ever logging out.**

- **Accounts.** Each account has its own login and its own usage limits. Add one from the
  status bar; sign in through the official extension's normal sign-in screen. No terminal
  required.
- **Shared memory and sessions, automatically.** An account keeps only its login; sessions,
  auto-memory, skills, settings, MCP config and history are symlinked back to `~/.claude`.
  Switch accounts mid-project and everything is still there. The Claude panel's conversation
  list does not change. There is no storage mode to choose.
- **One account per project.** Route a folder to an account once (status bar, or a
  `.claude-profile` file). Every new conversation in that folder uses it. Several folders,
  several accounts, all running at the same time in one window.
- **Switch without disruption.** Routing applies to new Claude processes only. Running
  conversations keep the account they started with. No `/logout`, no window reload.
- **Status bar menu is the whole UI**: current account marked, sign-in state shown, pick one to
  route the current folder, plus **Add another account…**, **Open Login Terminal** and
  **More…** (remove an account, copy MCP servers between accounts, import profiles from
  another switcher, check health, verify and repair links, show status, open the accounts
  folder, disable or enable routing).
  Nothing is added to the command palette.
- **Verify on activation** with relink on drift (a Claude Code upgrade can replace a symlink
  with a real directory; the stray directory is moved aside with a timestamp, never deleted).
- **Check health**: permissions, on-disk shape, duplicate `accountUuid`, stale map entries.
  Never reads, prints or logs token values.
- **Import profiles** created by `FaisalSannan/account-switcher-for-claude-code`; they keep
  their separate store.
- **Disable routing** restores `claudeCode.claudeProcessWrapper` and `initialPermissionMode`
  and removes the generated scripts. The machine returns to exactly its pre-install state.
- Tested against Claude Code extension 2.1.274–2.1.276 on macOS.

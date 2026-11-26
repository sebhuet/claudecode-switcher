# ClaudeCode Switcher — several Claude Code accounts, one machine, zero logouts

VS Code extension. Three things it does:

1. **Several accounts on the same project.** Hit a rate limit? Click the status
   bar, pick the next account, keep going in the same folder. Your sessions,
   auto-memory, skills and settings stay exactly where they are. Nothing logs
   out, nothing reloads, and the conversation list does not change.
2. **A different account for each project.** Work account in the work repo,
   personal in the side project, a client's in theirs. Route a folder once and
   every new conversation there uses the right account, automatically.
3. **A local model.** An Ollama account sends a folder's conversations to a
   model running on your machine, with no sign-in.

Every Claude account has its own login and its own usage limits. Everything else is
shared, automatically: all accounts read and write the same `~/.claude`, so
memory Claude saved under one account is already there when you switch to
another.

## How it feels

```
~/work/api        → Claude: Work       (team plan)
~/side/blog       → Claude: Personal   (Pro)
~/clients/acme    → Claude: Acme       (their seat)
~/lab/sandbox     → Claude: ollama-qwen3-coder (local)
```

All four folders open in one VS Code window, all four talking at the same
time. Switch any of them from the status bar. Running conversations
keep the account they started with.

## Install

Install *ClaudeCode Switcher* from the Marketplace (needs the official Claude
Code extension). Click **Claude: default** in the status bar →
**Add another account…** → **Claude account** → name it → sign in, or
**Ollama** → pick a model. Done. The status bar menu is the whole UI; there are
no command palette entries. On Windows, turn on Developer Mode first.

Full user docs: [packages/vscode/README.md](packages/vscode/README.md).

## How it works

The official Claude Code extension exposes a `claudeCode.claudeProcessWrapper`
setting. With your consent, the extension points it at a small generated script.
Each time a **new** Claude process starts, the script asks one resolver which
`CLAUDE_CONFIG_DIR` the process should get, exports it, and runs the real
binary untouched. An account is a directory holding only the login; everything
else is a symlink back into `~/.claude`. An Ollama account also holds
`provider-settings.json`, which the script passes with `--settings`.

Resolution order, first match wins: `CLAUDE_CONFIG_DIR` already set →
`CLAUDE_PROFILE` → `.claude-profile` file in folder or parent → longest prefix
in `map.conf` → `default` (plain `~/.claude`).

Routing applies to new processes only. Nothing is ever logged out. **Disable
routing** (status bar → More…) puts every setting back exactly as it was.
Accounts are plain directories you can delete.

## Repository layout

```
packages/
├── core/     routing + storage; no vscode imports, no CLI deps, no process.exit
│   ├── src/paths.ts        every ~/.claude vs CLAUDE_CONFIG_DIR asymmetry, in one place
│   ├── src/profiles.ts     create / list / delete; the ONLY writer of profile.json `mode`
│   ├── src/resolve.ts      THE resolver — the only routing implementation
│   ├── src/storage.ts      shared-path manifest; link / verify / relink
│   ├── src/seed.ts         trust + onboarding into new profiles, never credentials
│   ├── src/doctor.ts       health checks
│   ├── src/locks.ts        advisory per-project locks (warn, never block)
│   ├── src/wrapper.ts      renders the wrapper: .sh, or .exe compiled by csc on Windows
│   └── src/resolve-cli.ts  the `node` bridge the wrapper calls
├── vscode/   the extension; bundles core, writes _bin/ helpers on activation
└── cli/      terminal front end over the same core; used by the e2e script, not published
```

## Build

```
npm install            # Windows: npm ci --force (the CLI declares darwin/linux only)
npm run build          # core (tsc) + extension (esbuild) + cli (esbuild)
npm test               # core fixture tables, all against a temp $HOME
npm run e2e            # bash: mock-activates the extension against a temp $HOME
npm run e2e:win        # Windows: the compiled wrapper, against a temp $HOME
npm run package        # → claudecode-switcher.vsix
```

## Layout of an account directory

```
~/.claude-profiles/Personal/
├── .claude.json         REAL  oauthAccount — the login identity
├── .credentials.json    REAL  (Linux; macOS uses Keychain keyed off the dir path)
├── profile.json         REAL  { mode: "shared", ... } written once by createProfile
├── provider-settings.json  REAL  Ollama accounts only: URL, token, model for every alias
├── statsig/ usage-data/ sessions/ …   REAL  per-account / live process state
├── projects/     -> ~/.claude/projects       transcripts AND memory (projects/<p>/memory/)
├── skills/ plugins/ commands/ agents/ …  -> ~/.claude/…
├── settings.json CLAUDE.md keybindings.json history.jsonl -> ~/.claude/…
└── ide/          -> ~/.claude/ide            so /ide keeps working
```

The full manifest with reasons is `SHARED_LINKS` / `SHARED_REAL` in
[storage.ts](packages/core/src/storage.ts).

MIT.

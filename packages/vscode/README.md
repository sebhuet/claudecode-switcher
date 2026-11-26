# ClaudeCode Switcher

**Several Claude Code accounts on one project, or one account per project, or
another model (local Ollama, any Anthropic-compatible server). Switch from the
status bar. Never log out again.**

Three things this does:

1. **Use several accounts on the same project.** Hit a rate limit? Click the
   status bar, pick the next account, start a new conversation in the same
   folder. Your sessions, auto-memory, skills and settings are all still there.
   Nothing logs out, nothing reloads, the conversation list does not change.
2. **Use a different account for each project.** Work account in the work repo,
   personal in the side project, a client's in theirs. Route a folder once and
   every new conversation there uses the right account, automatically. All of
   them can run at the same time in one window.
3. **Use another model.** An Ollama account sends a folder's conversations to a
   model running on your machine: no sign-in, no usage limits, nothing leaves
   the machine. An Anthropic-compatible server account does the same with LM
   Studio, llama.cpp, vLLM, LiteLLM, OpenRouter or any server speaking the
   Anthropic Messages API.

Every Claude account keeps its own login and its own usage limits. Everything
else is one store: sessions, memory, skills, settings and MCP config stay in
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
2. Click **Claude: default** in the status bar → **Add another account…** →
   **Claude account** → name it.
3. The first time, allow routing (this sets `claudeCode.claudeProcessWrapper`
   in your user settings), then, unless you already set one, pick the
   permission mode new conversations start in (see [First use](#first-use)).
4. The folder is routed to the account and a sign-in opens. Sign in.
5. Open another folder, click the status bar, pick a different account. Both run at once.

Confirm with `/usage` inside a conversation: it names the billing account.

## Requirements

- The official Claude Code extension (installed automatically as a dependency).
- macOS, Linux, WSL, code-server or Windows 10/11.
- `node` on your `PATH`, or VS Code's own runtime is used as a fallback.
- For Ollama accounts: [Ollama](https://ollama.com) running, with at least one
  model pulled. For other engines: a server that speaks the Anthropic Messages
  API (`/v1/messages`).

### Windows

- Turn on **Developer Mode** first: Settings → System → For developers (or
  `Win+R` → `ms-settings:developers`). Accounts share `~/.claude` through
  symlinks to four files (`settings.json`, `CLAUDE.md`, `keybindings.json`,
  `history.jsonl`), which Windows only allows in that mode. Without it, adding
  an account fails with a message saying so, before anything is created.
  Folders are linked with junctions, which need no rights.
- The official extension starts the wrapper without a shell, so on Windows it is
  a small `.exe` compiled on activation from generated C# source
  (`_bin/claudecode-switcher-wrapper.cs`) with the `csc.exe` that ships with
  .NET Framework 4 on every Windows 10/11. The child `claude.exe` is tied to
  the wrapper by a job object, so stopping a conversation stops both.

## First use

Routing is off until you allow it. The first time you route a folder, a
dialog asks to set `claudeCode.claudeProcessWrapper`; if another wrapper is
already set there, it says so, and Disable routing restores it.

With any process wrapper configured, the official extension no longer asks the
CLI for the default permission mode, so new conversations start in **Manual**.
If `claudeCode.initialPermissionMode` is not set yet, a second question makes
that explicit: `default` (Manual), `acceptEdits`,
`plan`, or leave it unset. Disable routing removes the value it set.

## The status bar is the whole UI

Click **Claude: <account>** in the status bar. The menu is the account list:
the account the current folder uses is marked, engine accounts show their
engine and model, accounts not signed in yet say so, and picking one routes the folder to
it (and opens sign-in if needed).

The status bar text adds an icon when routing is not active: a disconnected
plug when it is off, a crossed-out circle when another wrapper is configured.
**Claude: unknown profile** means a `.claude-profile` file, `CLAUDE_PROFILE`
or a route names an account that does not exist; new conversations then fall
back to the default account.

Below the list:

- **Add another account…**: a Claude account (name it, sign in) or an account
  on another engine (see below).
- **Open Login Terminal**: sign an account in from a terminal instead (needs `claude` on `PATH`).
- **More…**: remove an account (its login is kept under
  `~/.claude-profiles/_backups/`), copy MCP servers between accounts, check
  health, verify links, show status, open the accounts folder, disable or
  enable routing. When profiles from another switcher are found, an import
  entry appears too; imported profiles keep their own history and settings.

There are no command palette entries.

## Other engines

An engine account sends a folder's conversations to another model instead of
an Anthropic account. There is no sign-in, and the model is chosen when the
account is created. Two engines:

| Engine | Asks for | Models |
| --- | --- | --- |
| **Ollama** | server URL (`http://localhost:11434`) | listed by the server (`/api/tags`) |
| **Anthropic-compatible server** | server URL, API key (may be empty) | `/v1/models`, else typed |

The second one covers any server speaking the Anthropic Messages API: LM Studio
(`http://localhost:1234`), llama.cpp (`llama-server`, with `--jinja` for tools),
vLLM, LiteLLM, OpenRouter (`https://openrouter.ai/api`)… Give the URL without
`/v1`: Claude Code adds `/v1/messages` itself. A server that only speaks the
OpenAI API needs a translating proxy such as LiteLLM in front. Models other
than Claude work on a best-effort basis: tool calling depends on the model.

1. Ollama: start it and pull a model with tool calling, e.g.
   `ollama pull qwen3-coder`. Another server: start it, or have its URL and key.
2. Status bar → **Add another account…** → the engine.
3. Answer its questions, then pick or type the model.
4. Accept or change the name (`<engine>-<model>` by default). The current
   folder is routed to it.
5. Start a **new** conversation in that folder.

To change model, add another account and pick it from the status bar.

What to know:

- **Pick the model when creating the account, not in the panel.** The panel's
  short names (`opus`, `sonnet`, `haiku`…) all land on the account's model; a
  full Claude model ID picked in the panel goes to the server as is, and fails.
- **Storage.** The `claudecodeSwitcher.engineMode` setting decides, when an
  account is created, where it keeps its state. `shared` (default): same
  settings, skills, MCP servers and history as `~/.claude`. `own`: a separate
  directory with its own history and settings; the panel's conversation list
  still shows the default store, so type `/resume` in a new conversation to see
  its sessions. Either way, do not resume a conversation started on Claude from
  an engine account, or the reverse: the model gets a history it did not write.
- **Context.** Claude Code sends about 15k tokens of prompt with every request,
  and Ollama often loads models with a 32k context, which long conversations
  outgrow. If the model allows more, raise it on the server
  (`OLLAMA_CONTEXT_LENGTH=65536`) and restart Ollama.
- **Your settings do not leak in.** The account's directory holds
  `provider-settings.json` (server URL, token, the model for every alias and
  for subagents). The wrapper passes it with `--settings`, which outranks your
  `settings.json`, so a `model` or `env` set there for Claude does not reach
  the engine. Your Anthropic API key is never sent to it.
- **API keys** are stored in that file only, never in `profile.json`, and never
  shown. It is as private as the Claude login next to it: on Windows, it is
  protected by your user profile's permissions only.
- **Organisation-managed settings** outrank `--settings`: on a managed machine,
  an engine account may be overridden.
- **In a terminal**, nothing routes for you: set `CLAUDE_CONFIG_DIR` to the
  account's directory and run
  `claude --settings <the account's directory>/provider-settings.json`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `claudecodeSwitcher.profilesRoot` | `~/.claude-profiles` | Where accounts live. Absolute path. |
| `claudecodeSwitcher.statusBar.show` | `true` | Show the folder's account in the status bar. |
| `claudecodeSwitcher.verifyOnActivation` | `true` | Check links at startup, offer repair. |
| `claudecodeSwitcher.loginMethod` | `panel` | Sign in from a conversation or a `terminal`. |
| `claudecodeSwitcher.engineMode` | `shared` | New engine accounts: `shared` or `own`. |

`claudecodeSwitcher.ollamaMode` (0.2.0) still counts while `engineMode` is unset.

## Troubleshooting

- **Which account did a conversation use?** `/usage` inside it names the
  billing account. Each new Claude process also adds a line to
  `~/.claude-profiles/_bin/claudecode-switcher.log`: folder, account directory,
  `provider=yes` for an engine account.
- **Something is wrong after an update.** More… → **Check health**, then
  **Verify and repair links**.
- **New conversations no longer start.** More… → **Disable routing**. If the
  menu is unreachable, remove `claudeCode.claudeProcessWrapper` from your VS Code
  user settings.
- **Engine account: "selected model … may not exist".** The model was changed
  in the panel to a full Claude model ID; start a new conversation without
  changing it. Also check that the server is running and still has the model
  (`ollama list`).
- **Check health says `PROVIDER_SETTINGS_MISSING`.** The account's
  `provider-settings.json` is gone, so its conversations no longer reach the engine.
  Remove the account and add it again.

## How it works

The official Claude Code extension has a `claudeCode.claudeProcessWrapper`
setting. With your consent this extension points it at a generated script under
`~/.claude-profiles/_bin/`. Each time the official extension starts a **new**
Claude process, the wrapper asks one resolver which `CLAUDE_CONFIG_DIR` that
process should get, exports it, and execs the real binary untouched (for an
engine account, with `--settings <provider-settings.json>` appended).

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

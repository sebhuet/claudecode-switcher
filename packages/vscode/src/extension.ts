/**
 * extension.ts — the VS Code front end. Bundles core; never re-implements routing.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as core from '../../core/src';
import { disableRouting, enableRouting, materialize, migrateLegacyInstall, officialExtensionInstalled, routingState, findClaude } from './routing';

let out: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let ctx: vscode.ExtensionContext;

function log(msg: string): void {
  out.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function paths(): core.Paths {
  const root = vscode.workspace.getConfiguration('claudecodeSwitcher').get<string>('profilesRoot')?.trim();
  return core.getPaths(root ? { profilesRoot: root } : {});
}

function guard<T extends unknown[]>(fn: (...a: T) => Promise<void>): (...a: T) => Promise<void> {
  return async (...a: T) => {
    try {
      await fn(...a);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      log(`error: ${msg}`);
      void vscode.window.showErrorMessage(`ClaudeCode Switcher: ${msg}`);
    }
  };
}

// ---------------------------------------------------------------- activation

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  ctx = context;
  out = vscode.window.createOutputChannel('ClaudeCode Switcher');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'claudecodeSwitcher.menu';
  context.subscriptions.push(out, status);

  // Only the status bar entry point is a real command. Nothing is contributed to the palette.
  const cmds: [string, (...a: never[]) => Promise<void>][] = [
    ['claudecodeSwitcher.menu', menu],
    ['claudecodeSwitcher.addAccount', addAccount],
    ['claudecodeSwitcher.disableRouting', disableRoutingCommand],
  ];
  for (const [id, fn] of cmds) context.subscriptions.push(vscode.commands.registerCommand(id, guard(fn as (...a: unknown[]) => Promise<void>)));

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => void refreshStatus()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshStatus()),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('claudecodeSwitcher') || e.affectsConfiguration('claudeCode.claudeProcessWrapper')) void refreshStatus(); }),
  );
  watchRoutingFiles();

  void (async () => {
    let p = paths();
    const refreshPaths = (): void => { p = paths(); watchRoutingFiles(); };
    log(`profiles root: ${p.profilesRoot}; default: ${p.claudeDir}`);
    if (!officialExtensionInstalled()) log('official Claude Code extension not found; routing cannot be enabled until it is installed.');
    try {
      if (await migrateLegacyInstall(ctx, log)) refreshPaths();
    } catch (e) {
      log(`migration from pre-release install failed: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(`ClaudeCode Switcher could not update its routing script: ${(e as Error).message}. Routing is paused; see the output channel.`);
    }
    const st = routingState(p);
    if (st.enabled) {
      // Regenerate: node path, extension version or resolve bundle may have changed.
      await materialize(ctx, p, log);
    } else if (st.foreignWrapper) {
      log(`another process wrapper is configured: ${st.foreignWrapper}; routing not active.`);
    }
    await refreshStatus();
    if (vscode.workspace.getConfiguration('claudecodeSwitcher').get<boolean>('verifyOnActivation', true)) await verifyAll(p, { silentIfClean: true });
    const legacy = (await core.listProfiles(p)).filter((x) => x.legacy);
    if (legacy.length && !ctx.globalState.get('claudecodeSwitcher.legacyNoticeShown')) {
      await ctx.globalState.update('claudecodeSwitcher.legacyNoticeShown', true);
      const pick = await vscode.window.showInformationMessage(
        `Found ${legacy.length} profile(s) from another switcher (${legacy.map((x) => x.name).join(', ')}). They keep their own history and settings. Import them? (Also available later under status bar → More…)`,
        'Import', 'Later');
      if (pick === 'Import') await importLegacyCommand();
    }
  })().catch((e) => log(`activation: ${(e as Error).message}`));
}

export function deactivate(): void {
  /* nothing to tear down; helper scripts stay until Disable Routing */
}

// ---------------------------------------------------------------- status bar

function currentFolder(): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  const wf = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  return wf?.uri.fsPath;
}

async function refreshStatus(): Promise<void> {
  if (!vscode.workspace.getConfiguration('claudecodeSwitcher').get<boolean>('statusBar.show', true)) {
    status.hide();
    return;
  }
  const p = paths();
  const folder = currentFolder();
  const st = routingState(p);
  let text = '$(account) Claude: default';
  let tip = '';
  try {
    if (folder) {
      const r = await core.resolve({ cwd: folder, env: process.env, paths: p });
      text = `$(account) Claude: ${r.profile}`;
      const prov = (await core.getProfile(p, r.profile))?.meta?.provider;
      tip = `Folder: ${folder}\nProfile: ${r.profile} · mode ${r.mode}${prov ? `\nBackend: Ollama · ${prov.model} at ${prov.baseUrl}` : ''}\nWhy: ${r.source}${r.detail ? ` — ${r.detail}` : ''}\nCLAUDE_CONFIG_DIR: ${r.configDir ?? '(unset → ~/.claude)'}`;
    }
  } catch (e) {
    text = '$(warning) Claude: unknown profile';
    tip = (e as Error).message;
  }
  if (!st.enabled) {
    text += st.foreignWrapper ? ' $(circle-slash)' : ' $(debug-disconnect)';
    tip += st.foreignWrapper ? `\n\nRouting NOT active: another wrapper is configured (${st.foreignWrapper}).` : '\n\nRouting NOT active: click, then More… → Enable routing.';
  }
  if (folder) {
    try {
      const r = await core.resolve({ cwd: folder, env: process.env, paths: p });
      if (r.mode === 'own' && r.profile !== 'default') {
        tip += `\n\nNote: the panel's history list comes from the default store, not from "${r.profile}". Type /resume in a new conversation to see its sessions.`;
      }
    } catch { /* already reported above */ }
  }
  tip += '\n\nThis is a prediction for NEW conversations. /usage inside a live session is the ground truth for which account is billing.';
  status.text = text;
  status.tooltip = tip;
  status.show();
}

let watchers: vscode.Disposable[] = [];
function watchRoutingFiles(): void {
  for (const w of watchers) w.dispose();
  watchers = [];
  const p = paths();
  const mapWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(p.profilesRoot), `{${core.MAP_FILE},${core.DEFAULT_LABEL_FILE}}`));
  const pinWatcher = vscode.workspace.createFileSystemWatcher(`**/${core.PIN_FILE}`);
  for (const w of [mapWatcher, pinWatcher]) {
    w.onDidChange(() => void refreshStatus());
    w.onDidCreate(() => void refreshStatus());
    w.onDidDelete(() => void refreshStatus());
    watchers.push(w);
    ctx.subscriptions.push(w);
  }
}

// ---------------------------------------------------------------- pickers

/** Provider accounts (Ollama) have no sign-in. */
function needsLogin(x: core.ProfileInfo): boolean {
  return !x.isDefault && !x.loggedIn && !x.meta?.provider;
}

function describe(x: core.ProfileInfo): string | undefined {
  const pr = x.meta?.provider;
  return pr ? `Ollama · ${pr.model}` : x.email ?? (x.isDefault ? '~/.claude' : undefined);
}

interface ProfilePick extends vscode.QuickPickItem {
  profile?: core.ProfileInfo;
}

async function pickProfile(title: string, opts: { excludeDefault?: boolean; placeholder?: string } = {}): Promise<core.ProfileInfo | undefined> {
  const list = await core.listProfiles(paths());
  const items: ProfilePick[] = list
    .filter((x) => !(opts.excludeDefault && x.isDefault))
    .map((x) => ({
      label: x.isDefault ? '$(home) default' : `$(account) ${x.name}`,
      description: describe(x),
      detail: x.loggedIn ? (x.organizationName ?? undefined) : x.meta?.provider ? undefined : 'not signed in',
      profile: x,
    }));
  const pick = await vscode.window.showQuickPick(items, { title, placeHolder: opts.placeholder });
  return pick?.profile;
}

async function pickFolder(title: string): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage('Open a folder first; routing is per folder.');
    return undefined;
  }
  if (folders.length === 1) return folders[0].uri.fsPath;
  const pick = await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.uri.fsPath })), { title });
  return pick?.description;
}

/**
 * Every account created here is `shared`: its own login, everything else in
 * ~/.claude. There is no user-facing choice. `own` exists in core only for
 * profiles imported from another switcher.
 */
function configuredMode(): core.StorageMode {
  return 'shared';
}

/** Ollama accounts are the exception: `claudecodeSwitcher.ollamaMode` picks. */
function ollamaMode(): core.StorageMode {
  return vscode.workspace.getConfiguration('claudecodeSwitcher').get<string>('ollamaMode') === 'own' ? 'own' : 'shared';
}

async function pickOllamaModel(): Promise<core.Provider | undefined> {
  const url = await vscode.window.showInputBox({
    title: 'Ollama — server URL',
    value: 'http://localhost:11434',
    validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? undefined : 'An http(s) URL.'),
  });
  if (!url) return undefined;
  const baseUrl = url.trim().replace(/\/+$/, '');
  let models: { name: string; size: number }[];
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    models = ((await res.json()) as { models?: { name: string; size: number }[] }).models ?? [];
  } catch (e) {
    throw new Error(`Ollama is not answering at ${baseUrl} (${(e as Error).message}). Start it, then try again.`);
  }
  if (!models.length) throw new Error(`Ollama at ${baseUrl} has no model. Pull one first (ollama pull <model>).`);
  const pick = await vscode.window.showQuickPick(
    models.map((m) => ({ label: m.name, description: `${(m.size / 1e9).toFixed(1)} GB` })),
    { title: 'Ollama — model', placeHolder: 'Pick a model with tool calling; Claude Code sends ~15k tokens of prompt per request' });
  return pick && { kind: 'ollama', baseUrl, model: pick.label };
}

// ---------------------------------------------------------------- commands

async function addAccount(): Promise<void> {
  const kind = await vscode.window.showQuickPick(
    [
      { label: '$(account) Claude account', description: 'sign in to another Anthropic account', ollama: false },
      { label: '$(server-process) Ollama', description: 'a local model, no sign-in', ollama: true },
    ],
    { title: 'Add account' });
  if (!kind) return;
  const provider = kind.ollama ? await pickOllamaModel() : undefined;
  if (kind.ollama && !provider) return;
  const p = paths();
  const name = await vscode.window.showInputBox({
    title: provider ? 'Add Ollama account — profile name' : 'Add Claude account — profile name',
    value: provider ? `ollama-${provider.model.replace(/[^A-Za-z0-9._-]/g, '-')}`.slice(0, 64) : undefined,
    prompt: 'A short name, e.g. Work or Personal. Becomes a directory under ' + p.profilesRoot,
    validateInput: async (v) => {
      const bad = core.validateProfileName(v.trim());
      if (bad) return bad;
      if (await core.profileExists(p, v.trim())) return `"${v.trim()}" already exists.`;
      return undefined;
    },
  });
  if (!name) return;
  const mode = provider ? ollamaMode() : configuredMode();
  const res = await core.createProfile(p, name.trim(), { mode, provider, copySettings: mode === 'own', copyClaudeMd: mode === 'own' });
  log(`created ${res.info.name} (${res.info.mode}); seeded ${res.seed.trustedProjects} trusted project(s)`);
  for (const f of res.link?.findings ?? []) log(`link ${f.severity}: ${f.message}`);
  await refreshStatus();

  const folder = currentFolder();
  if (!folder) {
    void vscode.window.showInformationMessage(`Account "${res.info.name}" added. Open a folder and pick it from the status bar to sign in.`);
    return;
  }
  await routeFolder(folder, res.info.name);
  if (provider) {
    void vscode.window.showInformationMessage(`${path.basename(folder)} → ${res.info.name} (Ollama · ${provider.model}). Start a new conversation to use it.`);
  } else {
    await loginFlow(res.info.name);
  }
}

async function routeFolder(folder: string, profile: string): Promise<void> {
  const p = paths();
  const st = routingState(p);
  if (!st.enabled && profile !== core.DEFAULT_PROFILE) {
    const ok = await enableRouting(ctx, p, log);
    if (!ok) {
      void vscode.window.showWarningMessage('Routing is not enabled, so this mapping has no effect on the VS Code extension until it is. (The CLI still honours it.)');
    }
  }
  await core.setMapping(p, folder, profile);
  log(`map: ${folder} → ${profile}`);
  const locks = await core.readLocks(p, folder);
  const other = locks.filter((l) => l.profile !== profile);
  if (other.length) {
    void vscode.window.showWarningMessage(`${path.basename(folder)} is currently open under "${other[0].profile}" (pid ${other[0].pid}). New conversations go to "${profile}"; if both are shared they write the same session store.`);
  }
  await refreshStatus();
}

/**
 * Login: the routed folder's next conversation spawns Claude under the new
 * profile; the official extension shows its own sign-in screen and writes the
 * credentials into that profile's directory. No terminal, no `claude` on PATH.
 */
async function loginFlow(profile: string): Promise<void> {
  const method = vscode.workspace.getConfiguration('claudecodeSwitcher').get<string>('loginMethod', 'panel');
  if (method === 'terminal' && findClaude()) {
    await openLoginTerminal(profile);
    return;
  }
  if (!officialExtensionInstalled()) {
    if (findClaude()) {
      await openLoginTerminal(profile);
      return;
    }
    void vscode.window.showWarningMessage('Neither the official Claude Code extension nor a claude binary was found; cannot start a sign-in.');
    return;
  }
  const st = routingState(paths());
  if (!st.enabled) {
    void vscode.window.showWarningMessage('Routing is not enabled; the Claude panel would open on the default account. Enable routing first.');
    return;
  }
  for (const cmd of ['claude-vscode.newConversation', 'claude-vscode.sidebar.open', 'claude-vscode.editor.open']) {
    try {
      await vscode.commands.executeCommand(cmd);
      log(`opened Claude panel via ${cmd} for sign-in to ${profile}`);
      void vscode.window.showInformationMessage(`A new Claude conversation was opened under "${profile}". Sign in on the screen it shows (or type /login). Confirm with /usage afterwards.`);
      return;
    } catch (e) {
      log(`${cmd} failed: ${(e as Error).message}`);
    }
  }
  void vscode.window.showWarningMessage('Could not open the Claude panel. Start a new conversation in this folder; it will prompt to sign in.');
}

async function openLoginTerminal(profile: string): Promise<void> {
  const p = paths();
  const dir = core.configDirEnvFor(p, profile);
  const term = vscode.window.createTerminal({ name: `Claude login: ${profile}`, env: dir ? { CLAUDE_CONFIG_DIR: dir } : {} });
  term.show();
  term.sendText(`claude  # then type /login if not prompted; this terminal has CLAUDE_CONFIG_DIR=${dir ?? '(unset → default)'}`);
  log(`login terminal opened for ${profile}`);
}

async function loginTerminalCommand(): Promise<void> {
  const prof = await pickProfile('Open a login terminal for which account?');
  if (!prof) return;
  if (!findClaude()) {
    void vscode.window.showWarningMessage('No `claude` binary on PATH. Use the panel flow instead: route a folder and start a new conversation.');
    return;
  }
  await openLoginTerminal(prof.name);
}

async function showStatus(): Promise<void> {
  const p = paths();
  const profiles = await core.listProfiles(p);
  const map = await core.readMap(p);
  const st = routingState(p);
  const locks = await core.listAllLocks(p);
  const lines: string[] = [];
  lines.push(`Routing: ${st.enabled ? 'enabled' : st.foreignWrapper ? `NOT active — foreign wrapper ${st.foreignWrapper}` : 'not enabled'}`);
  lines.push(`Profiles root: ${p.profilesRoot}`);
  lines.push('');
  for (const pr of profiles) {
    const routed = map.filter((m) => m.profile.toLowerCase() === pr.name.toLowerCase()).map((m) => m.prefix);
    lines.push(`● ${pr.name}${pr.isDefault ? '  (~/.claude)' : `  [${pr.mode ?? 'legacy: no mode'}]`}`);
    const prov = pr.meta?.provider;
    if (prov) lines.push(`    backend: Ollama · ${prov.model} at ${prov.baseUrl} (no sign-in)`);
    else lines.push(`    login: ${pr.loggedIn ? `${pr.email ?? '?'}${pr.organizationName ? ` · ${pr.organizationName}` : ''} · uuid ${pr.accountUuid ?? '?'}` : 'NOT signed in'}`);
    lines.push(`    dir:   ${pr.dir}`);
    if (routed.length) lines.push(`    folders: ${routed.join(', ')}`);
    const held = locks.filter((l) => l.profile === pr.name);
    if (held.length) lines.push(`    live sessions: ${held.map((l) => `${l.projectPath} (pid ${l.pid})`).join(', ')}`);
  }
  lines.push('');
  lines.push('The status bar is a prediction for NEW conversations. Run /usage inside a session to confirm which account is billing.');
  out.appendLine('----- status -----');
  out.appendLine(lines.join('\n'));
  out.show(true);
}

async function verifyAll(p: core.Paths, opts: { silentIfClean?: boolean } = {}): Promise<void> {
  const profiles = (await core.listProfiles(p)).filter((x) => !x.isDefault);
  const drift: { name: string; findings: core.Finding[] }[] = [];
  for (const pr of profiles) {
    const f = await core.verifyProfile(p, pr.name, pr.mode ?? 'own');
    const bad = f.filter((x) => x.severity !== 'info');
    if (bad.length) drift.push({ name: pr.name, findings: bad });
  }
  if (!drift.length) {
    if (!opts.silentIfClean) void vscode.window.showInformationMessage(`All ${profiles.length} profile(s) match their declared mode.`);
    return;
  }
  for (const d of drift) for (const f of d.findings) log(`verify ${d.name}: ${f.severity} ${f.code}: ${f.message}`);
  const relinkable = drift.filter((d) => profiles.find((x) => x.name === d.name)?.mode === 'shared');
  const pick = await vscode.window.showWarningMessage(
    `Profile drift: ${drift.map((d) => `${d.name} (${d.findings.length})`).join(', ')}. Shared state may have diverged.`,
    ...(relinkable.length ? ['Relink shared profiles'] : []), 'Show log');
  if (pick === 'Show log') out.show(true);
  if (pick === 'Relink shared profiles') {
    for (const d of relinkable) {
      const r = await core.relinkProfile(p, d.name);
      for (const f of r.findings) log(`relink ${d.name}: ${f.severity} ${f.code}: ${f.message}`);
      if (r.movedAside.length) {
        void vscode.window.showWarningMessage(`${d.name}: ${r.movedAside.length} real path(s) moved aside (nothing deleted): ${r.movedAside.map((m) => path.basename(m.to)).join(', ')}. Anything written there did not reach ~/.claude.`);
      }
    }
    void vscode.window.showInformationMessage('Relink complete.');
  }
}

async function verifyCommand(): Promise<void> {
  await verifyAll(paths());
}

async function doctorCommand(): Promise<void> {
  const rep = await core.doctor(paths());
  out.appendLine('----- doctor -----');
  for (const g of rep.global) out.appendLine(`[${g.severity}] ${g.code}: ${g.message}`);
  for (const r of rep.profiles) {
    out.appendLine(`● ${r.profile.name} [${r.profile.isDefault ? '~/.claude' : r.profile.mode ?? 'legacy'}]`);
    for (const f of r.findings) out.appendLine(`    [${f.severity}] ${f.code}: ${f.message}${f.path ? ` (${f.path})` : ''}`);
  }
  out.appendLine(rep.ok ? 'OK — no errors.' : 'Errors found.');
  out.show(true);
  const errs = [...rep.global, ...rep.profiles.flatMap((r) => r.findings)].filter((f) => f.severity === 'error');
  if (errs.length) void vscode.window.showErrorMessage(`Doctor: ${errs.length} error(s). ${errs[0].message}`);
  else void vscode.window.showInformationMessage('Doctor: no errors.');
}

async function deleteProfileCommand(): Promise<void> {
  const p = paths();
  const prof = await pickProfile('Delete which profile? (default cannot be deleted)', { excludeDefault: true });
  if (!prof) return;
  const routed = (await core.readMap(p)).filter((m) => m.profile === prof.name).map((m) => m.prefix);
  const detail =
    `${prof.dir}\nmode: ${prof.mode ?? 'legacy'} · ${prof.loggedIn ? `signed in as ${prof.email ?? '?'}` : describe(prof) ?? 'not signed in'}\n` +
    (routed.length ? `routed folders (mappings will be removed): ${routed.join(', ')}\n` : '') +
    (prof.mode === 'shared'
      ? '\nshared: only the symlinks and this login go away; sessions, memory and settings stay in ~/.claude.'
      : '\nown: ALL of its sessions, memory and settings are deleted with it.') +
    '\n\nA snapshot of the login files (.claude.json, .credentials.json) is kept under _backups/ first.';
  const ok = await vscode.window.showWarningMessage(`Delete profile "${prof.name}"?`, { modal: true, detail }, 'Delete');
  if (ok !== 'Delete') return;
  try {
    const res = await core.deleteProfile(p, prof.name);
    log(`deleted ${prof.name}; snapshot ${res.snapshotDir}`);
    await refreshStatus();
    void vscode.window.showInformationMessage(`Deleted "${prof.name}". Login snapshot: ${res.snapshotDir}`);
  } catch (e) {
    if ((e as core.ClaudeCodeSwitcherError).code === 'DELETE_DRIFT') {
      const pick = await vscode.window.showErrorMessage((e as Error).message, 'Relink now');
      if (pick) await verifyAll(p);
      return;
    }
    throw e;
  }
}

async function copyMcpCommand(): Promise<void> {
  const p = paths();
  const from = await pickProfile('Copy user-scope MCP servers FROM which profile?');
  if (!from) return;
  const to = await pickProfile(`…TO which profile? (from ${from.name})`);
  if (!to || to.name === from.name) return;
  const ok = await vscode.window.showWarningMessage(
    `Copy mcpServers from "${from.name}" to "${to.name}"?`,
    { modal: true, detail: 'Server configs are copied verbatim, including any env values (which may hold API keys). Same-named servers in the target are overwritten.' },
    'Copy');
  if (ok !== 'Copy') return;
  const r = await core.copyMcpServers(p, from.name, to.name);
  void vscode.window.showInformationMessage(r.copied.length ? `Copied ${r.copied.length} MCP server(s): ${r.copied.join(', ')}` : `"${from.name}" has no user-scope MCP servers.`);
}

async function disableRoutingCommand(): Promise<void> {
  const ok = await vscode.window.showWarningMessage(
    'Disable Claude account routing?',
    { modal: true, detail: 'Restores claudeCode.claudeProcessWrapper and claudeCode.initialPermissionMode to what they were, and removes the generated _bin/claudecode-switcher-* scripts. Profiles, logins and the folder map are kept; new conversations go back to the default account.' },
    'Disable');
  if (ok !== 'Disable') return;
  const notes = await disableRouting(ctx, paths(), log);
  await refreshStatus();
  void vscode.window.showInformationMessage(`Routing disabled. ${notes.join('; ')}`);
}

async function importLegacyCommand(): Promise<void> {
  const p = paths();
  const legacy = (await core.listProfiles(p)).filter((x) => x.legacy);
  if (!legacy.length) {
    void vscode.window.showInformationMessage('No legacy profiles found.');
    return;
  }
  const done: string[] = [];
  for (const l of legacy) {
    try {
      await core.importLegacyProfile(p, l.name);
      done.push(l.name);
    } catch (e) {
      log(`import ${l.name}: ${(e as Error).message}`);
      void vscode.window.showWarningMessage(`${l.name}: ${(e as Error).message}`);
    }
  }
  if (done.length) void vscode.window.showInformationMessage(`Marked as own: ${done.join(', ')}`);
  await refreshStatus();
}

/**
 * Status-bar menu: the account list itself. Picking an account routes the
 * current folder to it (and signs in if needed). Maintenance lives behind
 * "More…"; nothing is exposed in the command palette.
 */
async function menu(): Promise<void> {
  const p = paths();
  const folder = currentFolder();
  const profiles = await core.listProfiles(p);
  let current: string | undefined;
  if (folder) {
    try {
      current = (await core.resolve({ cwd: folder, env: process.env, paths: p })).profile;
    } catch {
      /* unknown profile; nothing is current */
    }
  }
  type Item = vscode.QuickPickItem & { action: 'use' | 'add' | 'terminal' | 'more'; profile?: core.ProfileInfo };
  const items: Item[] = profiles.map((x) => ({
    action: 'use',
    profile: x,
    label: x.isDefault ? 'Default account' : x.name,
    description: describe(x),
    detail: x.name === current
      ? `Used by new conversations in ${folder ? path.basename(folder) : 'this folder'}`
      : x.loggedIn || x.meta?.provider
        ? undefined
        : 'Not signed in yet — sign-in opens when you pick it',
    picked: x.name === current,
  }));
  items.push(
    { action: 'add', label: '', kind: vscode.QuickPickItemKind.Separator },
    { action: 'add', label: '$(add) Add another account…' },
    { action: 'terminal', label: '$(terminal) Open Login Terminal' },
    { action: 'more', label: '$(gear) More…' },
  );
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Claude account for new conversations',
    placeHolder: folder ? `Pick the account ${path.basename(folder)} should use` : 'Open a folder to route it',
    matchOnDescription: true,
  });
  if (!pick) return;
  if (pick.action === 'add') return addAccount();
  if (pick.action === 'terminal') return loginTerminalCommand();
  if (pick.action === 'more') return moreMenu();
  if (!pick.profile) return;
  const target = folder ?? (await pickFolder('Route which folder?'));
  if (!target) return;
  await routeFolder(target, pick.profile.name);
  if (needsLogin(pick.profile)) {
    await loginFlow(pick.profile.name);
  } else {
    void vscode.window.showInformationMessage(`${path.basename(target)} → ${pick.profile.name}. Applies to new conversations; running ones keep their account.`);
  }
}

/** Maintenance, reachable only from the status-bar menu. */
async function moreMenu(): Promise<void> {
  const p = paths();
  const st = routingState(p);
  const hasLegacy = (await core.listProfiles(p)).some((x) => x.legacy);
  type Item = vscode.QuickPickItem & { run: () => Promise<void> };
  const items: Item[] = [
    { label: '$(trash) Remove an account…', description: 'login snapshot kept under _backups/', run: deleteProfileCommand },
    { label: '$(server) Copy MCP servers between accounts…', description: 'user-scope MCP config lives per account', run: copyMcpCommand },
    ...(hasLegacy ? [{ label: '$(cloud-download) Import profiles from another switcher…', description: 'they keep their separate history and settings', run: importLegacyCommand }] : []),
    { label: '$(pulse) Check health', description: 'permissions, symlinks, duplicate accounts, stale routes', run: doctorCommand },
    { label: '$(link) Verify and repair links', description: 'relink if a Claude Code upgrade replaced a symlink', run: verifyCommand },
    { label: '$(info) Show status', description: 'every account, its folders and live sessions', run: showStatus },
    { label: '$(folder-opened) Open accounts folder', description: p.profilesRoot, run: async () => { await core.ensureProfilesRoot(p); await vscode.env.openExternal(vscode.Uri.file(p.profilesRoot)); } },
    st.enabled
      ? { label: '$(debug-disconnect) Disable routing', description: 'restore the pre-install settings; accounts are kept', run: disableRoutingCommand }
      : { label: '$(plug) Enable routing', description: 'new conversations use the account routed for their folder', run: async () => { if (await enableRouting(ctx, p, log)) void vscode.window.showInformationMessage('Claude account routing enabled for new conversations.'); await refreshStatus(); } },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'ClaudeCode Switcher — more' });
  if (pick) await pick.run();
}

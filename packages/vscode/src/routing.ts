/**
 * routing.ts — wiring between the official Claude Code extension's
 * `claudeCode.claudeProcessWrapper` setting and claudecode-switcher's generated wrapper.
 * Routing decisions themselves live in core/resolve.ts; this file only
 * installs / removes the bridge and remembers what it changed so Disable
 * Routing can put everything back.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import * as core from '../../core/src';

export const OFFICIAL_EXT_ID = 'anthropic.claude-code';
const CC = 'claudeCode';
const KEY_PREV_WRAPPER = 'claudecodeSwitcher.previousWrapper';
const KEY_PREV_PERM = 'claudecodeSwitcher.previousInitialPermissionMode';
const KEY_PERM_SET_BY_US = 'claudecodeSwitcher.permissionModeSetByUs';
const KEY_CONSENTED = 'claudecodeSwitcher.routingConsented';
/** globalState keys written by pre-release builds (then called "ccprof"); read once by migrateLegacyInstall. */
const LEGACY_KEYS: Record<string, string> = {
  [KEY_PREV_WRAPPER]: 'ccprof.previousWrapper',
  [KEY_PREV_PERM]: 'ccprof.previousInitialPermissionMode',
  [KEY_PERM_SET_BY_US]: 'ccprof.permissionModeSetByUs',
  [KEY_CONSENTED]: 'ccprof.routingConsented',
  'claudecodeSwitcher.legacyNoticeShown': 'ccprof.legacyNoticeShown',
};
const LEGACY_SETTINGS = ['profilesRoot', 'statusBar.show', 'verifyOnActivation', 'loginMethod'];

export type Log = (msg: string) => void;

export interface RoutingState {
  enabled: boolean;
  /** Set when claudeProcessWrapper points somewhere that is not ours. */
  foreignWrapper?: string;
  wrapperPath: string;
}

export function wrapperPathFor(p: core.Paths): string {
  return path.join(p.binDir, core.WRAPPER_NAME);
}

export function configuredWrapper(): string | undefined {
  const v = vscode.workspace.getConfiguration(CC).inspect<string>('claudeProcessWrapper')?.globalValue;
  return v && v.trim() ? v.trim() : undefined;
}

export function routingState(p: core.Paths): RoutingState {
  const ours = wrapperPathFor(p);
  const cur = configuredWrapper();
  if (!cur) return { enabled: false, wrapperPath: ours };
  if (cur === ours) return { enabled: true, wrapperPath: ours };
  return { enabled: false, foreignWrapper: cur, wrapperPath: ours };
}

export function officialExtensionInstalled(): boolean {
  return !!vscode.extensions.getExtension(OFFICIAL_EXT_ID);
}

function isExecutable(f: string): boolean {
  try {
    fs.accessSync(f, fs.constants.X_OK);
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
}

/** Find a node binary: PATH of the extension host, then a login shell. Never throws. */
export function findNode(log: Log): string | undefined {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const cand = path.join(dir, exe);
    if (isExecutable(cand)) return cand;
  }
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL || '/bin/sh';
    try {
      const out = execFileSync(shell, ['-lc', 'command -v node'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (out && isExecutable(out)) return out;
    } catch (e) {
      log(`node lookup via ${shell} -lc failed: ${(e as Error).message}`);
    }
  }
  return undefined;
}

export function findClaude(): string | undefined {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const cand = path.join(dir, exe);
    if (dir && isExecutable(cand)) return cand;
  }
  const home = process.env.HOME ?? os.homedir();
  for (const cand of [path.join(home, '.local', 'bin', exe), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']) {
    if (isExecutable(cand)) return cand;
  }
  return undefined;
}

/** VS Code's own Electron binary works as node with ELECTRON_RUN_AS_NODE=1; last-resort runtime. */
export function electronPath(): string | undefined {
  const exe = process.execPath;
  return exe && isExecutable(exe) ? exe : undefined;
}

/**
 * A pre-release build (then called "ccprof") wrote `_bin/ccprof-wrapper.sh`, pointed the
 * setting at it and stored its settings/state under `ccprof.*`. If that is what is
 * configured, move to the current names: carry settings and remembered state over,
 * write the new helpers, repoint the setting, then drop the old files. Only an exact
 * match on our own legacy wrapper path triggers this; any other wrapper is left alone.
 * Returns true when a migration happened. Throws if the new helpers cannot be written,
 * in which case nothing has been changed yet.
 */
export async function migrateLegacyInstall(ctx: vscode.ExtensionContext, log: Log): Promise<boolean> {
  const cur = configuredWrapper();
  if (!cur || path.basename(cur) !== core.LEGACY_WRAPPER_NAME) return false;
  // The legacy root is wherever the old wrapper lives: <root>/_bin/ccprof-wrapper.sh.
  const legacyRoot = path.dirname(path.dirname(cur));
  const oldCfg = vscode.workspace.getConfiguration('ccprof');
  const oldRoot = oldCfg.inspect<string>('profilesRoot')?.globalValue?.trim();
  const p = core.getPaths(oldRoot ? { profilesRoot: oldRoot } : {});
  if (path.join(p.binDir, core.LEGACY_WRAPPER_NAME) !== cur && path.join(legacyRoot, path.basename(p.binDir), core.LEGACY_WRAPPER_NAME) !== cur) {
    log(`wrapper ${cur} has our legacy name but is not under a known profiles root; leaving it alone`);
    return false;
  }
  const migrated = core.getPaths({ profilesRoot: legacyRoot });
  const res = await materialize(ctx, migrated, log); // may throw; nothing changed yet
  const newCfg = vscode.workspace.getConfiguration('claudecodeSwitcher');
  for (const key of LEGACY_SETTINGS) {
    const v = oldCfg.inspect<unknown>(key)?.globalValue;
    if (v !== undefined) {
      if (newCfg.inspect<unknown>(key)?.globalValue === undefined) await newCfg.update(key, v, vscode.ConfigurationTarget.Global);
      await oldCfg.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
  }
  if (legacyRoot !== core.getPaths({}).profilesRoot && newCfg.inspect<string>('profilesRoot')?.globalValue === undefined) {
    await newCfg.update('profilesRoot', legacyRoot, vscode.ConfigurationTarget.Global);
  }
  await vscode.workspace.getConfiguration(CC).update('claudeProcessWrapper', res.wrapperPath, vscode.ConfigurationTarget.Global);
  for (const [key, oldKey] of Object.entries(LEGACY_KEYS)) {
    const v = ctx.globalState.get(oldKey);
    if (v !== undefined && ctx.globalState.get(key) === undefined) await ctx.globalState.update(key, v);
    await ctx.globalState.update(oldKey, undefined);
  }
  for (const f of core.LEGACY_HELPER_NAMES) {
    try {
      await fsp.rm(path.join(migrated.binDir, f));
    } catch {
      /* absent */
    }
  }
  log(`migrated pre-release install: ${cur} -> ${res.wrapperPath}`);
  return true;
}

export async function materialize(ctx: vscode.ExtensionContext, p: core.Paths, log: Log): Promise<core.MaterializeResult> {
  const resolveSrc = await fsp.readFile(path.join(ctx.extensionPath, 'dist', 'claudecode-switcher-resolve.cjs'), 'utf8');
  const version = String((ctx.extension.packageJSON as { version?: string }).version ?? '0.0.0');
  const nodePath = findNode(log);
  const res = await core.materializeHelpers(p, { version, nodePath, electronPath: electronPath(), claudePath: findClaude(), resolveScriptSource: resolveSrc });
  log(`helpers ${res.changed ? 'written' : 'up to date'}: ${res.wrapperPath} (node=${nodePath ?? 'PATH lookup at runtime'})`);
  return res;
}

/**
 * One-time consent + install. Returns true when routing is enabled afterwards.
 */
export async function enableRouting(ctx: vscode.ExtensionContext, p: core.Paths, log: Log, opts: { quiet?: boolean } = {}): Promise<boolean> {
  if (!officialExtensionInstalled()) {
    void vscode.window.showErrorMessage(
      `Folder routing needs the official Claude Code extension (${OFFICIAL_EXT_ID}) installed; its claudeCode.claudeProcessWrapper setting is what routes new sessions.`,
    );
    return false;
  }
  const state = routingState(p);
  if (state.enabled) {
    await materialize(ctx, p, log);
    return true;
  }

  if (!opts.quiet || state.foreignWrapper) {
    const detail = state.foreignWrapper
      ? `claudeCode.claudeProcessWrapper currently points at another wrapper:\n${state.foreignWrapper}\n\nReplace it? It is remembered and restored by Disable Routing.`
      : `This sets the user-level setting claudeCode.claudeProcessWrapper to\n${state.wrapperPath}\n\n` +
        `Every NEW Claude conversation then starts under the account routed for its folder. Running conversations are untouched. ` +
        `Nothing is logged in or out. Disable Routing removes it again.\n\n` +
        `Side effect of any process wrapper: the official extension stops asking the CLI for the default permission mode, so new conversations start in Manual unless claudeCode.initialPermissionMode is set. You will be asked next.`;
    const ok = await vscode.window.showInformationMessage('Enable Claude account routing for new conversations?', { modal: true, detail }, 'Enable');
    if (ok !== 'Enable') return false;
  }

  await materialize(ctx, p, log);
  const cfg = vscode.workspace.getConfiguration(CC);
  await ctx.globalState.update(KEY_PREV_WRAPPER, state.foreignWrapper ?? null);
  await cfg.update('claudeProcessWrapper', state.wrapperPath, vscode.ConfigurationTarget.Global);
  await ctx.globalState.update(KEY_CONSENTED, true);
  log(`claudeProcessWrapper set to ${state.wrapperPath}`);

  // Permission-mode default changes once a wrapper exists; make it explicit.
  const perm = cfg.inspect<string>('initialPermissionMode')?.globalValue;
  if (perm === undefined) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'default', description: 'Manual — approve each tool call (what a wrapper otherwise silently gives you)' },
        { label: 'acceptEdits', description: 'Auto-accept file edits, ask for other tools' },
        { label: 'plan', description: 'Start every conversation in plan mode' },
        { label: 'Leave unset', description: 'Do nothing (new conversations start in Manual)' },
      ],
      { title: 'Initial permission mode for new Claude conversations', placeHolder: 'With a process wrapper configured the CLI default is not consulted. Pick one to make it explicit.' },
    );
    if (pick && pick.label !== 'Leave unset') {
      await ctx.globalState.update(KEY_PREV_PERM, null);
      await ctx.globalState.update(KEY_PERM_SET_BY_US, pick.label);
      await cfg.update('initialPermissionMode', pick.label, vscode.ConfigurationTarget.Global);
      log(`initialPermissionMode set to ${pick.label}`);
    }
  }
  return true;
}

/** Return the machine to exactly its pre-install behaviour. Profiles and the map stay. */
export async function disableRouting(ctx: vscode.ExtensionContext, p: core.Paths, log: Log): Promise<string[]> {
  const notes: string[] = [];
  const cfg = vscode.workspace.getConfiguration(CC);
  const state = routingState(p);
  // settings.json exists whether or not the official extension is still installed; always restore.
  if (state.enabled) {
    const prev = ctx.globalState.get<string | null>(KEY_PREV_WRAPPER) ?? undefined;
    await cfg.update('claudeProcessWrapper', prev || undefined, vscode.ConfigurationTarget.Global);
    notes.push(prev ? `claudeProcessWrapper restored to ${prev}` : 'claudeProcessWrapper unset');
  } else if (state.foreignWrapper) {
    notes.push(`claudeProcessWrapper left alone (points at ${state.foreignWrapper}, not ours)`);
  }
  const setByUs = ctx.globalState.get<string | null>(KEY_PERM_SET_BY_US);
  const curPerm = cfg.inspect<string>('initialPermissionMode')?.globalValue;
  if (setByUs && curPerm === setByUs) {
    const prev = ctx.globalState.get<string | null>(KEY_PREV_PERM) ?? undefined;
    await cfg.update('initialPermissionMode', prev || undefined, vscode.ConfigurationTarget.Global);
    notes.push('initialPermissionMode restored');
  }
  await ctx.globalState.update(KEY_PREV_WRAPPER, undefined);
  await ctx.globalState.update(KEY_PREV_PERM, undefined);
  await ctx.globalState.update(KEY_PERM_SET_BY_US, undefined);
  await ctx.globalState.update(KEY_CONSENTED, undefined);
  const removed = await core.removeHelpers(p);
  notes.push(...removed.map((r) => `removed ${r}`));
  for (const n of notes) log(n);
  return notes;
}

// Loads dist/extension.js with a minimal fake `vscode` module and drives activation + a few commands.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const HOME = fs.mkdtempSync(path.join(process.argv[3], 'ext.'));
process.env.HOME = HOME; delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CLAUDE_PROFILE;
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude.json'), '{"hasCompletedOnboarding":true,"projects":{"/a":{"hasTrustDialogAccepted":true}}}');
const WS = path.join(HOME, 'repo'); fs.mkdirSync(WS);

const settings = {}; const globalState = new Map(); const logs = []; const msgs = [];
let statusText = ''; let statusTip = '';
const cfgFor = (section) => ({
  get: (k, d) => settings[`${section}.${k}`] ?? d,
  inspect: (k) => ({ globalValue: settings[`${section}.${k}`] }),
  update: async (k, v) => { if (v === undefined) delete settings[`${section}.${k}`]; else settings[`${section}.${k}`] = v; },
});
const commands = new Map();
let quickPickAnswer = () => undefined; let inputAnswer = () => undefined; let msgAnswer = () => undefined;
const vscode = {
  StatusBarAlignment: { Left: 1 }, ConfigurationTarget: { Global: 1 }, QuickPickItemKind: { Separator: -1 },
  Uri: { file: (f) => ({ fsPath: f }) },
  RelativePattern: class { constructor(b, p) { this.b = b; this.p = p; } },
  window: {
    createOutputChannel: () => ({ appendLine: (s) => logs.push(s), show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, set text(v) { statusText = v; }, get text() { return statusText; }, set tooltip(v) { statusTip = v; }, get tooltip() { return statusTip; } }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    showInformationMessage: async (m, ...rest) => { msgs.push(['info', m]); return msgAnswer(m, rest); },
    showWarningMessage: async (m, ...rest) => { msgs.push(['warn', m]); return msgAnswer(m, rest); },
    showErrorMessage: async (m) => { msgs.push(['error', m]); },
    showQuickPick: async (items, o) => quickPickAnswer(items, o),
    showInputBox: async (o) => inputAnswer(o),
    createTerminal: () => ({ show() {}, sendText() {} }),
    activeTextEditor: undefined,
  },
  workspace: {
    getConfiguration: cfgFor,
    workspaceFolders: [{ name: 'repo', uri: { fsPath: WS } }],
    getWorkspaceFolder: () => undefined,
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
  },
  commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, executeCommand: async (id) => { if (id.startsWith('claude-vscode.')) { logs.push(`exec ${id}`); return; } return commands.get(id)?.(); } },
  extensions: { getExtension: (id) => (id === 'anthropic.claude-code' ? {} : undefined) },
  env: { openExternal: async () => true },
};
const origLoad = Module._load;
Module._load = function (req, ...a) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...a); };
const ext = require(process.argv[2]);
const ctx = { subscriptions: [], extensionPath: path.dirname(path.dirname(process.argv[2])), extension: { packageJSON: { version: '0.1.0-test' } },
  globalState: { get: (k) => globalState.get(k), update: async (k, v) => { globalState.set(k, v); } } };

// Pre-release install (then called "ccprof"): old wrapper configured, old globalState keys present.
const BIN = path.join(HOME, '.claude-profiles/_bin'); fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(path.join(BIN, 'ccprof-wrapper.sh'), '#!/bin/sh\n'); fs.writeFileSync(path.join(BIN, 'ccprof.log'), '');
settings['claudeCode.claudeProcessWrapper'] = path.join(BIN, 'ccprof-wrapper.sh');
globalState.set('ccprof.previousWrapper', '/old/claude-wrapper.sh'); globalState.set('ccprof.routingConsented', true);
settings['ccprof.loginMethod'] = 'terminal';

(async () => {
  await ext.activate(ctx);
  await new Promise((r) => setTimeout(r, 300));
  console.log('migrated: setting =', String(settings['claudeCode.claudeProcessWrapper']).replace(HOME, '~'), '| legacy files gone =', !fs.existsSync(path.join(BIN, 'ccprof-wrapper.sh')) && !fs.existsSync(path.join(BIN, 'ccprof.log')), '| prev wrapper carried =', globalState.get('claudecodeSwitcher.previousWrapper'), '| old key cleared =', globalState.get('ccprof.previousWrapper'), '| setting carried =', settings['claudecodeSwitcher.loginMethod'], '| old setting cleared =', settings['ccprof.loginMethod']);
  console.log('commands registered:', commands.size);
  console.log('status after activate:', statusText);

  // Add Account → "Personal" (shared by default), routed to the open folder and sign-in opened
  inputAnswer = async () => 'Personal';
  quickPickAnswer = async (items, o) => {
    if (o?.title?.startsWith('Storage mode')) throw new Error('mode picker must not appear');
    if (o?.title?.startsWith('Initial permission mode')) return items.find((i) => i.label === 'acceptEdits');
    return items[0];
  };
  msgAnswer = async (m, rest) => {
    const buttons = rest.filter((x) => typeof x === 'string');
    if (buttons.includes('Enable')) return 'Enable';
    return undefined;
  };
  await commands.get('claudecodeSwitcher.addAccount')();
  await new Promise((r) => setTimeout(r, 200));
  console.log('status after add+route:', statusText);
  console.log('wrapper setting:', settings['claudeCode.claudeProcessWrapper']);
  console.log('perm setting:', settings['claudeCode.initialPermissionMode']);
  console.log('wrapper exists:', fs.existsSync(settings['claudeCode.claudeProcessWrapper'] || ''), 'resolve exists:', fs.existsSync(path.join(HOME, '.claude-profiles/_bin/claudecode-switcher-resolve.cjs')));
  console.log('map:', fs.readFileSync(path.join(HOME, '.claude-profiles/map.conf'), 'utf8').trim().split('\n').pop());
  console.log('projects is symlink:', fs.lstatSync(path.join(HOME, '.claude-profiles/Personal/projects')).isSymbolicLink());
  console.log('sign-in opened via:', logs.filter((l) => l.startsWith('exec ')).join(','));

  const meta = JSON.parse(fs.readFileSync(path.join(HOME, '.claude-profiles/Personal/profile.json'), 'utf8'));
  console.log('mode without picker =', meta.mode);

  // status-bar menu = account list; current one marked; picking Default re-routes the folder
  let menuItems;
  quickPickAnswer = async (items, o) => { menuItems = items; return items.find((i) => i.profile?.isDefault); };
  msgAnswer = async () => undefined;
  await commands.get('claudecodeSwitcher.menu')();
  const accountRows = menuItems.filter((i) => i.action === 'use');
  console.log('menu accounts:', accountRows.map((i) => `${i.label}${i.picked ? '*' : ''}`).join(','), '| extras:', menuItems.filter((i) => i.action !== 'use' && i.label).map((i) => i.label.replace(/\$\([^)]*\) /, '')).join(','));
  console.log('menu marked current:', accountRows.find((i) => i.picked)?.label);
  console.log('after picking Default: routed to Personal =', fs.readFileSync(path.join(HOME, '.claude-profiles/map.conf'), 'utf8').includes('|Personal'));
  quickPickAnswer = async (items) => items.find((i) => i.profile?.name === 'Personal');
  await commands.get('claudecodeSwitcher.menu')();
  console.log('after picking Personal: routed to Personal =', fs.readFileSync(path.join(HOME, '.claude-profiles/map.conf'), 'utf8').includes('|Personal'));

  // disable routing
  msgAnswer = async () => 'Disable';
  await commands.get('claudecodeSwitcher.disableRouting')();
  console.log('after disable: wrapper setting =', settings['claudeCode.claudeProcessWrapper'], '| perm =', settings['claudeCode.initialPermissionMode'], '| _bin files =', fs.existsSync(path.join(HOME, '.claude-profiles/_bin')) ? fs.readdirSync(path.join(HOME, '.claude-profiles/_bin')) : 'gone');
  console.log('status:', statusText);
  console.log('errors shown:', msgs.filter((m) => m[0] === 'error'));
  console.log('--- log tail'); console.log(logs.slice(-8).join('\n'));
  fs.rmSync(HOME, { recursive: true, force: true });
})().catch((e) => { console.error('FAILED', e); process.exit(1); });

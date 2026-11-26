import { fake } from './fake-vscode';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import * as core from '../../core/src';
import { disableRouting, enableRouting, routingState, wrapperPathFor } from '../src/routing';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudecode-switcher-vscode-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The extension's install dir: materialize reads the bundled resolver from dist/.
const extensionPath = path.join(tmp, 'ext');
fs.mkdirSync(path.join(extensionPath, 'dist'), { recursive: true });
fs.writeFileSync(path.join(extensionPath, 'dist', core.RESOLVE_NAME), '// resolve\n');
const ctx = {
  extensionPath,
  extension: { packageJSON: { version: '0.0.0-test' } },
  globalState: { get: (k: string) => fake.globalState.get(k), update: async (k: string, v: unknown) => void fake.globalState.set(k, v) },
} as unknown as vscode.ExtensionContext;

const p = core.getPaths({ home: path.join(tmp, 'home') });
const ours = wrapperPathFor(p);
const log = (): void => undefined;
const WRAPPER = 'claudeCode.claudeProcessWrapper';
const PERM = 'claudeCode.initialPermissionMode';
const settings = () => Object.fromEntries(fake.settings);

beforeEach(() => fake.reset());

test('routingState: off, ours, or another wrapper', () => {
  assert.deepEqual(routingState(p), { enabled: false, wrapperPath: ours });
  fake.settings.set(WRAPPER, ` ${ours} `);
  assert.equal(routingState(p).enabled, true);
  fake.settings.set(WRAPPER, '/other/wrapper');
  assert.deepEqual(routingState(p), { enabled: false, foreignWrapper: '/other/wrapper', wrapperPath: ours });
});

test('enable is refused without the official extension', async () => {
  fake.officialInstalled = false;
  assert.equal(await enableRouting(ctx, p, log), false);
  assert.deepEqual(settings(), {});
  assert.match(fake.messages[0], /official Claude Code extension/);
});

test('declining consent changes nothing', async () => {
  assert.equal(await enableRouting(ctx, p, log), false);
  assert.deepEqual(settings(), {});
  assert.equal(fs.existsSync(ours), false);
});

test('enable then disable puts every setting back as it was', async () => {
  fake.answerMessage = () => 'Enable';
  fake.answerPick = (_t, items) => (items as { label: string }[]).find((i) => i.label === 'acceptEdits');
  assert.equal(await enableRouting(ctx, p, log), true);
  assert.deepEqual(settings(), { [WRAPPER]: ours, [PERM]: 'acceptEdits' });
  assert.ok(fs.existsSync(ours));

  const notes = await disableRouting(ctx, p, log);
  assert.deepEqual(settings(), {});
  assert.ok(notes.includes('claudeProcessWrapper unset') && notes.includes('initialPermissionMode restored'));
  assert.ok([...fake.globalState.values()].every((v) => v === undefined));
  assert.equal(fs.existsSync(ours), false);
});

test('a foreign wrapper is asked about even when quiet, and restored on disable', async () => {
  fake.settings.set(WRAPPER, '/other/wrapper');
  fake.settings.set(PERM, 'plan');
  let asked = '';
  fake.answerMessage = (m) => ((asked = m), 'Enable');
  fake.answerPick = () => assert.fail('permission mode already set: no question');
  assert.equal(await enableRouting(ctx, p, log, { quiet: true }), true);
  assert.match(asked, /Enable Claude account routing/);
  assert.equal(fake.settings.get(WRAPPER), ours);

  await disableRouting(ctx, p, log);
  assert.deepEqual(settings(), { [WRAPPER]: '/other/wrapper', [PERM]: 'plan' });
});

test('disable leaves a permission mode the user changed since, and a wrapper not ours', async () => {
  fake.answerMessage = () => 'Enable';
  fake.answerPick = (_t, items) => (items as { label: string }[])[0];
  await enableRouting(ctx, p, log, { quiet: true });
  assert.equal(fake.messages.length, 0, 'quiet: no consent dialog without a foreign wrapper');
  fake.settings.set(PERM, 'plan');
  await disableRouting(ctx, p, log);
  assert.deepEqual(settings(), { [PERM]: 'plan' });

  fake.settings.set(WRAPPER, '/other/wrapper');
  const notes = await disableRouting(ctx, p, log);
  assert.equal(fake.settings.get(WRAPPER), '/other/wrapper');
  assert.match(notes[0], /left alone/);
});

test('enable when already enabled only refreshes the helpers', async () => {
  fake.settings.set(WRAPPER, ours);
  fake.answerMessage = () => assert.fail('no dialog when already enabled');
  assert.equal(await enableRouting(ctx, p, log), true);
  assert.ok(fs.existsSync(ours));
  await disableRouting(ctx, p, log);
});

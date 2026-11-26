import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { sandbox, write } from './helpers';
import { PROVIDER_SETTINGS } from '../src/profiles';
import {
  LOG_NAME, RESOLVE_NAME, WRAPPER_EXE, WRAPPER_NAME,
  materializeHelpers, removeHelpers, renderWrapperCs, renderWrapperScript, sh,
} from '../src/wrapper';

const fw = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET');
const noCsc = process.platform === 'win32' && !['Framework64', 'Framework'].some((d) => fs.existsSync(path.join(fw, d, 'v4.0.30319', 'csc.exe')));

test('sh quotes for bash, including single quotes', () => {
  assert.equal(sh('plain'), `'plain'`);
  assert.equal(sh(`it's`), `'it'\\''s'`);
  assert.equal(sh(''), `''`);
});

test('bash wrapper bakes quoted paths and passes provider settings', async () => {
  const sb = await sandbox();
  try {
    const s = renderWrapperScript(sb.p, { version: '9.9.9', nodePath: `/opt/my node's/node` });
    assert.ok(s.startsWith('#!/usr/bin/env bash\n'));
    assert.ok(s.includes('claudecode-switcher 9.9.9'));
    assert.ok(s.includes(`ROOT=${sh(sb.p.profilesRoot)}`));
    assert.ok(s.includes(`RESOLVE=${sh(path.join(sb.p.binDir, RESOLVE_NAME))}`));
    assert.ok(s.includes(`NODE_BIN='/opt/my node'\\''s/node'`));
    assert.ok(s.includes(`ELECTRON_BIN=''`) && s.includes(`CLAUDE_FALLBACK=''`));
    assert.ok(s.includes(`$CLAUDE_CONFIG_DIR/${PROVIDER_SETTINGS}`));
    assert.ok(s.includes('set -- "$@" --settings "$PS"'), 'settings appended after the real argv');
    assert.ok(s.includes('set -- --settings "$PS"'), 'settings passed in the no-argument shape too');
  } finally {
    await sb.cleanup();
  }
});

test('C# wrapper bakes paths as verbatim strings and passes provider settings', async () => {
  const sb = await sandbox();
  try {
    const s = renderWrapperCs(sb.p, { version: '9.9.9', nodePath: 'C:\\a "b"\\node.exe', electronPath: 'C:\\Code\\Code.exe' });
    assert.ok(s.includes('claudecode-switcher 9.9.9'));
    assert.ok(s.includes('NODE_BIN = @"C:\\a ""b""\\node.exe"'));
    assert.ok(s.includes('ELECTRON_BIN = @"C:\\Code\\Code.exe"'));
    assert.ok(s.includes(PROVIDER_SETTINGS) && s.includes('" --settings "'));
  } finally {
    await sb.cleanup();
  }
});

test('materializeHelpers writes once, then only on change', { skip: noCsc && 'no csc.exe' }, async () => {
  const sb = await sandbox();
  try {
    const input = { version: '1.0.0', resolveScriptSource: '// resolve v1\n' };
    const a = await materializeHelpers(sb.p, input);
    assert.equal(a.changed, true);
    assert.equal(a.wrapperPath, path.join(sb.p.binDir, WRAPPER_NAME));
    assert.ok(fs.existsSync(a.wrapperPath));
    assert.equal(await fsp.readFile(a.resolvePath, 'utf8'), input.resolveScriptSource);
    assert.equal((await materializeHelpers(sb.p, input)).changed, false);
    assert.equal((await materializeHelpers(sb.p, { ...input, resolveScriptSource: '// resolve v2\n' })).changed, true);
  } finally {
    await sb.cleanup();
  }
});

test('removeHelpers removes only our files, and _bin only once empty', async () => {
  const sb = await sandbox();
  try {
    const ours = [WRAPPER_NAME, RESOLVE_NAME, LOG_NAME, `${WRAPPER_EXE}.old-123`, 'ccprof-wrapper.sh'];
    for (const f of [...ours, 'foreign.sh']) await write(path.join(sb.p.binDir, f), 'x');
    await write(path.join(sb.p.locksDir, 'l.json'), '{}');
    const removed = await removeHelpers(sb.p);
    assert.deepEqual(removed.map((f) => path.basename(f)).sort(), [...ours].sort());
    assert.deepEqual(await fsp.readdir(sb.p.binDir), ['foreign.sh']);
    assert.equal(fs.existsSync(sb.p.locksDir), false);

    await fsp.rm(path.join(sb.p.binDir, 'foreign.sh'));
    await write(path.join(sb.p.binDir, RESOLVE_NAME), 'x');
    await removeHelpers(sb.p);
    assert.equal(fs.existsSync(sb.p.binDir), false);
    assert.deepEqual(await removeHelpers(sb.p), [], 'absent _bin is fine');
  } finally {
    await sb.cleanup();
  }
});

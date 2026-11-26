import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { sandbox, mkdirp, write } from './helpers';
import { createProfile, importLegacyProfile } from '../src/profiles';
import { doctor } from '../src/doctor';
import { verifyProfile } from '../src/storage';
import { acquireLock } from '../src/locks';
import { longestMatch } from '../src/map';
import { CREDENTIALS_FILE } from '../src/paths';
import { listSessions, projectDirFor } from '../src/sessions';
import { main } from '../src/resolve-cli';

test('doctor reports a missing default login and two accounts on one project', async () => {
  const sb = await sandbox();
  try {
    await fsp.rm(sb.p.defaultClaudeJson);
    const proj = path.join(sb.home, 'proj');
    await acquireLock(sb.p, proj, 'Work', process.pid);
    await acquireLock(sb.p, proj, 'Personal', process.ppid);
    const rep = await doctor(sb.p);
    assert.ok(rep.global.some((f) => f.code === 'NO_DEFAULT_LOGIN'));
    assert.ok(rep.global.some((f) => f.code === 'CONTENTION' && f.message.includes('Work') && f.message.includes('Personal')));
  } finally {
    await sb.cleanup();
  }
});

test('verifyProfile: missing directory, shared credentials, missing link', async () => {
  const sb = await sandbox();
  try {
    assert.deepEqual((await verifyProfile(sb.p, 'Ghost', 'own')).map((f) => f.code), ['MISSING_DIR']);

    const own = await createProfile(sb.p, 'Work', { mode: 'own' });
    await write(path.join(sb.home, 'creds.json'), '{}');
    await fsp.symlink(path.join(sb.home, 'creds.json'), path.join(own.info.dir, CREDENTIALS_FILE), 'file');
    assert.ok((await verifyProfile(sb.p, 'Work', 'own')).some((f) => f.code === 'CREDENTIALS_SYMLINK' && f.severity === 'error'));

    const shared = await createProfile(sb.p, 'Personal', { mode: 'shared' });
    await fsp.unlink(path.join(shared.info.dir, 'settings.json'));
    assert.ok((await verifyProfile(sb.p, 'Personal', 'shared')).some((f) => f.code === 'LINK_MISSING' && f.path?.endsWith('settings.json')));
  } finally {
    await sb.cleanup();
  }
});

test('createProfile: shared needs ~/.claude; legacy import refuses symlinks', async () => {
  const sb = await sandbox();
  try {
    const legacy = await mkdirp(sb.p.profilesRoot, 'Old');
    await write(path.join(legacy, '.claude.json'), '{}');
    await fsp.symlink(path.join(sb.p.claudeDir, 'settings.json'), path.join(legacy, 'settings.json'), 'file');
    await assert.rejects(importLegacyProfile(sb.p, 'Old'), { code: 'LEGACY_HAS_SYMLINKS' });
    await assert.rejects(importLegacyProfile(sb.p, 'Nope'), { code: 'NOT_FOUND' });

    await fsp.rm(sb.p.claudeDir, { recursive: true });
    await assert.rejects(createProfile(sb.p, 'Personal', { mode: 'shared' }), { code: 'NO_DEFAULT' });
  } finally {
    await sb.cleanup();
  }
});

test('longestMatch picks the deepest prefix on a path boundary', () => {
  const a = path.resolve('/w/a');
  const ab = path.join(a, 'b');
  const entries = [{ prefix: a, profile: 'A' }, { prefix: ab, profile: 'AB' }];
  assert.equal(longestMatch(entries, path.join(ab, 'c'))?.profile, 'AB');
  assert.equal(longestMatch(entries, path.join(a, 'bc'))?.profile, 'A');
  assert.equal(longestMatch(entries, path.resolve('/w/ab')), undefined);
  assert.equal(longestMatch([{ prefix: path.parse(a).root, profile: 'R' }], a)?.profile, 'R');
});

test('listSessions: unparsable lines are skipped, untitled sessions get no title', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Work', { mode: 'own' });
    const folder = path.join(sb.home, 'repo');
    const dir = projectDirFor(sb.p, 'Work', folder);
    const id = '33333333-3333-3333-3333-333333333333';
    await write(path.join(dir, `${id}.jsonl`), 'not json\n\n' + JSON.stringify({ type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: 'hello' }] } }) + '\n');
    const empty = '44444444-4444-4444-4444-444444444444';
    await write(path.join(dir, `${empty}.jsonl`), JSON.stringify({ type: 'assistant' }) + '\n');
    const titles = Object.fromEntries((await listSessions(sb.p, 'Work', folder)).map((s) => [s.id, s.title]));
    assert.equal(titles[id], 'hello');
    assert.ok(empty in titles);
  } finally {
    await sb.cleanup();
  }
});

test('resolve-cli warns when a project is already open under another account', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Work', { mode: 'own' });
    const proj = await mkdirp(sb.home, 'proj');
    const err: string[] = [];
    const run = (env: NodeJS.ProcessEnv) => main(['--cwd', proj, '--lock'], { ...sb.env, ...env }, () => undefined, (s) => err.push(s));
    assert.equal(await run({ CLAUDE_PROFILE: 'Work', CLAUDECODE_SWITCHER_LOCK_PID: String(process.pid) }), 0);
    assert.equal(await run({ CLAUDECODE_SWITCHER_LOCK_PID: String(process.ppid) }), 0);
    assert.ok(err.some((e) => e.includes('already open under profile "Work"')), err.join('\n'));

    const out: string[] = [];
    const code = await main(['--cwd', proj, '--json'], { ...sb.env, CLAUDE_PROFILE: 'Ghost' }, (s) => out.push(s), () => undefined);
    assert.equal(code, 3);
    assert.deepEqual(JSON.parse(out[0]), { error: 'UNKNOWN_PROFILE', profile: 'Ghost', source: 'env-profile: CLAUDE_PROFILE=Ghost' });
  } finally {
    await sb.cleanup();
  }
});

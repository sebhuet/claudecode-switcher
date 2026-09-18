import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { sandbox } from './helpers';
import { changeMode, createProfile, deleteProfile, getProfile, importLegacyProfile, listProfiles } from '../src/profiles';
import { ClaudeCodeSwitcherError, ModeChangeRefusedError } from '../src/errors';
import { buildSeedFromRootJson, copyMcpServers, sanitizeSettings } from '../src/seed';
import { doctor } from '../src/doctor';
import { setMapping, readMap, removeMapping, parseMap, serializeMap } from '../src/map';
import { acquireLock, readLocks, releaseLock } from '../src/locks';
import { profileClaudeJson, validateProfileName } from '../src/paths';

test('create writes mode once and lists correctly', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Work', { mode: 'own' });
    await createProfile(sb.p, 'Personal', { mode: 'shared' });
    const list = await listProfiles(sb.p);
    assert.deepEqual(list.map((x) => [x.name, x.mode, x.isDefault]), [
      ['default', 'own', true],
      ['Personal', 'shared', false],
      ['Work', 'own', false],
    ]);
    const meta = JSON.parse(await fsp.readFile(path.join(sb.p.profilesRoot, 'Personal', 'profile.json'), 'utf8'));
    assert.equal(meta.mode, 'shared');
    assert.equal(meta.sharedTarget, sb.p.claudeDir);
    const st = await fsp.stat(sb.p.profilesRoot);
    assert.equal(st.mode & 0o777, 0o700);
    assert.equal((await fsp.stat(path.join(sb.p.profilesRoot, 'Personal', '.claude.json'))).mode & 0o777, 0o600);
  } finally {
    await sb.cleanup();
  }
});

test('create rejects bad names, duplicates, default', async () => {
  const sb = await sandbox();
  try {
    await assert.rejects(createProfile(sb.p, '_bin', { mode: 'own' }), (e: unknown) => (e as ClaudeCodeSwitcherError).code === 'BAD_NAME');
    await assert.rejects(createProfile(sb.p, '../x', { mode: 'own' }), (e: unknown) => (e as ClaudeCodeSwitcherError).code === 'BAD_NAME');
    await assert.rejects(createProfile(sb.p, 'default', { mode: 'own' }), (e: unknown) => (e as ClaudeCodeSwitcherError).code === 'EXISTS');
    await createProfile(sb.p, 'Work', { mode: 'own' });
    await assert.rejects(createProfile(sb.p, 'Work', { mode: 'shared' }), (e: unknown) => (e as ClaudeCodeSwitcherError).code === 'EXISTS');
    assert.equal(validateProfileName('Work-2.x'), undefined);
    assert.ok(validateProfileName('with space'));
  } finally {
    await sb.cleanup();
  }
});

test('mode change is refused both ways with an explanation', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Work', { mode: 'own' });
    await createProfile(sb.p, 'Personal', { mode: 'shared' });
    await assert.rejects(changeMode(sb.p, 'Work', 'shared'), (e: unknown) => e instanceof ModeChangeRefusedError && /session-ID collisions/.test(e.message) && /delete/.test(e.message));
    await assert.rejects(changeMode(sb.p, 'Personal', 'own'), (e: unknown) => e instanceof ModeChangeRefusedError && /IS the shared history/.test(e.message));
    await assert.rejects(changeMode(sb.p, 'Work', 'own'), (e: unknown) => (e as ClaudeCodeSwitcherError).code === 'MODE_UNCHANGED');
    await assert.rejects(changeMode(sb.p, 'default', 'shared'), (e: unknown) => (e as ClaudeCodeSwitcherError).code === 'MODE_CHANGE_REFUSED');
    // metadata untouched
    assert.equal((await getProfile(sb.p, 'Work'))!.mode, 'own');
    assert.equal((await getProfile(sb.p, 'Personal'))!.mode, 'shared');
  } finally {
    await sb.cleanup();
  }
});

test('seed copies trust + onboarding, never credentials or identity', async () => {
  const sb = await sandbox();
  try {
    const { seed } = await createProfile(sb.p, 'Work', { mode: 'own', copySettings: true });
    assert.equal(seed.trustedProjects, 1);
    const j = JSON.parse(await fsp.readFile(profileClaudeJson(sb.p, 'Work'), 'utf8'));
    assert.equal(j.hasCompletedOnboarding, true);
    assert.equal(j.oauthAccount, undefined);
    assert.equal(j.mcpServers, undefined);
    assert.deepEqual(j.projects, { '/repo/x': { hasTrustDialogAccepted: true } });
    assert.ok(!JSON.stringify(j).includes('NOPE'));
    const s = JSON.parse(await fsp.readFile(path.join(sb.p.profilesRoot, 'Work', 'settings.json'), 'utf8'));
    assert.deepEqual(s, { theme: 'dark' });
    assert.deepEqual(buildSeedFromRootJson(undefined), {});
    assert.deepEqual(sanitizeSettings({ a: 1, env: {}, apiKeyHelper: 'x' }), { a: 1 });
  } finally {
    await sb.cleanup();
  }
});

test('copyMcpServers moves user-scope servers between profiles', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Personal', { mode: 'shared' });
    const r = await copyMcpServers(sb.p, 'default', 'Personal');
    assert.deepEqual(r.copied, ['srv']);
    const j = JSON.parse(await fsp.readFile(profileClaudeJson(sb.p, 'Personal'), 'utf8'));
    assert.deepEqual(j.mcpServers, { srv: { command: 'x' } });
    assert.equal(j.oauthAccount, undefined);
  } finally {
    await sb.cleanup();
  }
});

test('legacy (prior-art) profile: listed as legacy, importable as own', async () => {
  const sb = await sandbox();
  try {
    const dir = path.join(sb.p.profilesRoot, 'Old');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'profile.json'), JSON.stringify({ name: 'Old', createdAt: 'x', schemaVersion: 2 }));
    await fsp.writeFile(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u-old', emailAddress: 'old@example.com' } }));
    const info = (await getProfile(sb.p, 'Old'))!;
    assert.equal(info.legacy, true);
    assert.equal(info.mode, undefined);
    assert.equal(info.email, 'old@example.com');
    const rep = await doctor(sb.p);
    assert.ok(rep.profiles.find((r) => r.profile.name === 'Old')!.findings.some((f) => f.code === 'LEGACY_NO_MODE'));
    const meta = await importLegacyProfile(sb.p, 'Old');
    assert.equal(meta.mode, 'own');
    assert.equal((await getProfile(sb.p, 'Old'))!.legacy, false);
    await assert.rejects(importLegacyProfile(sb.p, 'Old'), (e: unknown) => (e as ClaudeCodeSwitcherError).code === 'NOT_LEGACY');
  } finally {
    await sb.cleanup();
  }
});

test('doctor flags duplicate accountUuid loudly and unknown map targets', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Work', { mode: 'own' });
    const rj = profileClaudeJson(sb.p, 'Work');
    const j = JSON.parse(await fsp.readFile(rj, 'utf8'));
    j.oauthAccount = { accountUuid: 'uuid-default', emailAddress: 'default@example.com' };
    await fsp.writeFile(rj, JSON.stringify(j));
    await setMapping(sb.p, path.join(sb.home, 'proj'), 'Ghost');
    const rep = await doctor(sb.p);
    assert.equal(rep.ok, false);
    assert.ok(rep.global.some((f) => f.code === 'DUPLICATE_ACCOUNT' && f.message.includes('"default"') && f.message.includes('"Work"')));
    assert.ok(rep.global.some((f) => f.code === 'MAP_UNKNOWN_PROFILE'));
    // never leaks token-looking values
    assert.ok(!JSON.stringify(rep).includes('NOPE'));
  } finally {
    await sb.cleanup();
  }
});

test('doctor is clean on a healthy setup', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Work', { mode: 'own' });
    await createProfile(sb.p, 'Personal', { mode: 'shared' });
    const rep = await doctor(sb.p);
    assert.equal(rep.ok, true, JSON.stringify(rep, null, 1));
  } finally {
    await sb.cleanup();
  }
});

test('map: set/remove/parse round-trip and delete cleans mappings', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Work', { mode: 'own' });
    await setMapping(sb.p, path.join(sb.home, 'a'), 'Work');
    await setMapping(sb.p, path.join(sb.home, 'a/'), 'Work'); // same prefix, replaces
    await setMapping(sb.p, path.join(sb.home, 'b'), 'default');
    assert.equal((await readMap(sb.p)).length, 2);
    const text = serializeMap(await readMap(sb.p));
    assert.deepEqual(parseMap(text), await readMap(sb.p));
    assert.equal(parseMap('~/x|Work', sb.p)[0].prefix, path.join(sb.home, 'x'));
    assert.equal(await removeMapping(sb.p, path.join(sb.home, 'b')), true);
    assert.equal(await removeMapping(sb.p, path.join(sb.home, 'b')), false);
    const res = await deleteProfile(sb.p, 'Work');
    assert.deepEqual(res.removedMappings, [path.join(sb.home, 'a')]);
    assert.equal((await readMap(sb.p)).length, 0);
  } finally {
    await sb.cleanup();
  }
});

test('locks: contention reported, stale pids pruned, release works', async () => {
  const sb = await sandbox();
  try {
    const proj = path.join(sb.home, 'proj');
    const a = await acquireLock(sb.p, proj, 'Personal', process.pid);
    assert.deepEqual(a.contention, []);
    // a dead pid never counts
    await acquireLock(sb.p, proj, 'Other', 999999);
    const b = await acquireLock(sb.p, proj, 'default', process.pid + 0); // same pid, different profile → replaces own entry
    assert.deepEqual(b.contention, []);
    assert.equal((await readLocks(sb.p, proj)).length, 1);
    await releaseLock(sb.p, proj, process.pid);
    assert.equal((await readLocks(sb.p, proj)).length, 0);
  } finally {
    await sb.cleanup();
  }
});

test('delete default is refused; delete missing errors', async () => {
  const sb = await sandbox();
  try {
    await assert.rejects(deleteProfile(sb.p, 'default'), (e: unknown) => (e as ClaudeCodeSwitcherError).code === 'DELETE_DEFAULT');
    await assert.rejects(deleteProfile(sb.p, 'Nope'), (e: unknown) => (e as ClaudeCodeSwitcherError).code === 'NOT_FOUND');
  } finally {
    await sb.cleanup();
  }
});

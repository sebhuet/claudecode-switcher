import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { sandbox } from './helpers';
import { createProfile, deleteProfile, getProfile } from '../src/profiles';
import { SHARED_LINKS, linkProfile, relinkProfile, verifyProfile } from '../src/storage';
import { ClaudeCodeSwitcherError } from '../src/errors';

test('shared: every manifest link points where declared', async () => {
  const sb = await sandbox();
  try {
    const { link } = await createProfile(sb.p, 'Personal', { mode: 'shared' });
    assert.equal(link!.linked.length, SHARED_LINKS.length);
    const dir = path.join(sb.p.profilesRoot, 'Personal');
    for (const e of SHARED_LINKS) {
      const st = await fsp.lstat(path.join(dir, e.rel));
      assert.ok(st.isSymbolicLink(), `${e.rel} should be a symlink`);
      assert.equal(await fsp.readlink(path.join(dir, e.rel)), path.join(sb.p.claudeDir, e.rel));
    }
    // memory rides along with projects: one symlink, not two.
    const mem = await fsp.readFile(path.join(dir, 'projects', '-repo-x', 'memory', 'MEMORY.md'), 'utf8');
    assert.equal(mem, '# mem\n');
    // .claude.json is REAL
    assert.ok((await fsp.lstat(path.join(dir, '.claude.json'))).isFile());
    assert.deepEqual(await verifyProfile(sb.p, 'Personal', 'shared'), []);
  } finally {
    await sb.cleanup();
  }
});

test('shared: writing memory through the profile lands in ~/.claude', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Personal', { mode: 'shared' });
    const viaProfile = path.join(sb.p.profilesRoot, 'Personal', 'projects', '-repo-z', 'memory');
    await fsp.mkdir(viaProfile, { recursive: true });
    await fsp.writeFile(path.join(viaProfile, 'note.md'), 'hello');
    const canonical = path.join(sb.p.claudeDir, 'projects', '-repo-z', 'memory', 'note.md');
    assert.equal(await fsp.readFile(canonical, 'utf8'), 'hello');
  } finally {
    await sb.cleanup();
  }
});

test('shared: linking is idempotent', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Personal', { mode: 'shared' });
    const again = await linkProfile(sb.p, 'Personal');
    assert.equal(again.linked.length, 0);
    assert.equal(again.alreadyOk.length, SHARED_LINKS.length);
    assert.equal(again.movedAside.length, 0);
    assert.deepEqual(again.findings, []);
  } finally {
    await sb.cleanup();
  }
});

test('shared: real directory where a link belongs is moved aside, never deleted', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Personal', { mode: 'shared' });
    const dir = path.join(sb.p.profilesRoot, 'Personal');
    // simulate a Claude Code upgrade replacing the symlink with a real dir
    await fsp.unlink(path.join(dir, 'projects'));
    await fsp.mkdir(path.join(dir, 'projects', '-repo-q'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'projects', '-repo-q', 'abc.jsonl'), '{}');

    const drift = await verifyProfile(sb.p, 'Personal', 'shared');
    assert.ok(drift.some((f) => f.code === 'LINK_REPLACED' && f.severity === 'error'));

    const res = await relinkProfile(sb.p, 'Personal');
    assert.equal(res.movedAside.length, 1);
    assert.ok(res.findings.some((f) => f.code === 'MOVED_ASIDE' && f.severity === 'warning'));
    const aside = res.movedAside[0].to;
    assert.equal(await fsp.readFile(path.join(aside, '-repo-q', 'abc.jsonl'), 'utf8'), '{}');
    assert.ok((await fsp.lstat(path.join(dir, 'projects'))).isSymbolicLink());
    assert.deepEqual(await verifyProfile(sb.p, 'Personal', 'shared'), []);
  } finally {
    await sb.cleanup();
  }
});

test('shared: a real file where a file-link belongs is moved aside', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Personal', { mode: 'shared' });
    const f = path.join(sb.p.profilesRoot, 'Personal', 'settings.json');
    await fsp.unlink(f);
    await fsp.writeFile(f, '{"changed":true}');
    const res = await relinkProfile(sb.p, 'Personal');
    assert.equal(res.movedAside.length, 1);
    assert.equal(await fsp.readFile(res.movedAside[0].to, 'utf8'), '{"changed":true}');
    assert.ok((await fsp.lstat(f)).isSymbolicLink());
  } finally {
    await sb.cleanup();
  }
});

test('shared: wrong-target symlink is re-pointed with a warning', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Personal', { mode: 'shared' });
    const f = path.join(sb.p.profilesRoot, 'Personal', 'skills');
    await fsp.unlink(f);
    await fsp.symlink('/nowhere', f);
    assert.ok((await verifyProfile(sb.p, 'Personal', 'shared')).some((x) => x.code === 'LINK_WRONG_TARGET'));
    const res = await relinkProfile(sb.p, 'Personal');
    assert.ok(res.findings.some((x) => x.code === 'RELINKED'));
    assert.equal(await fsp.readlink(f), path.join(sb.p.claudeDir, 'skills'));
  } finally {
    await sb.cleanup();
  }
});

test('shared: missing file target yields a dangling link; first write creates the shared file', async () => {
  const sb = await sandbox();
  try {
    await fsp.rm(path.join(sb.p.claudeDir, 'CLAUDE.md'));
    await createProfile(sb.p, 'Personal', { mode: 'shared' });
    const link = path.join(sb.p.profilesRoot, 'Personal', 'CLAUDE.md');
    assert.ok((await fsp.lstat(link)).isSymbolicLink());
    assert.deepEqual(await verifyProfile(sb.p, 'Personal', 'shared'), []);
    await fsp.writeFile(link, 'new');
    assert.equal(await fsp.readFile(path.join(sb.p.claudeDir, 'CLAUDE.md'), 'utf8'), 'new');
  } finally {
    await sb.cleanup();
  }
});

test('own: contains zero symlinks and verify is clean', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Work', { mode: 'own', copySettings: true, copyClaudeMd: true });
    const dir = path.join(sb.p.profilesRoot, 'Work');
    for (const child of await fsp.readdir(dir)) {
      assert.ok(!(await fsp.lstat(path.join(dir, child))).isSymbolicLink(), `${child} is a symlink`);
    }
    assert.deepEqual(await verifyProfile(sb.p, 'Work', 'own'), []);
    // isolation: nothing from own reaches ~/.claude
    await fsp.mkdir(path.join(dir, 'projects', '-repo-w'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'projects', '-repo-w', 's.jsonl'), '{}');
    await assert.rejects(fsp.stat(path.join(sb.p.claudeDir, 'projects', '-repo-w')));
  } finally {
    await sb.cleanup();
  }
});

test('own: a stray symlink is reported by verify', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Work', { mode: 'own' });
    await fsp.symlink(path.join(sb.p.claudeDir, 'projects'), path.join(sb.p.profilesRoot, 'Work', 'projects'));
    const f = await verifyProfile(sb.p, 'Work', 'own');
    assert.ok(f.some((x) => x.code === 'OWN_HAS_SYMLINK' && x.severity === 'error'));
  } finally {
    await sb.cleanup();
  }
});

test('a symlinked .claude.json is a hard error', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Personal', { mode: 'shared' });
    const rj = path.join(sb.p.profilesRoot, 'Personal', '.claude.json');
    await fsp.unlink(rj);
    await fsp.symlink(sb.p.defaultClaudeJson, rj);
    const f = await verifyProfile(sb.p, 'Personal', 'shared');
    assert.ok(f.some((x) => x.code === 'ROOT_JSON_SYMLINK' && x.severity === 'error'));
    await assert.rejects(linkProfile(sb.p, 'Personal'), (e: unknown) => e instanceof ClaudeCodeSwitcherError && e.code === 'ROOT_JSON_SYMLINK');
  } finally {
    await sb.cleanup();
  }
});

test('linking the default profile is refused', async () => {
  const sb = await sandbox();
  try {
    await assert.rejects(linkProfile(sb.p, 'default'), (e: unknown) => e instanceof ClaudeCodeSwitcherError && e.code === 'LINK_DEFAULT');
  } finally {
    await sb.cleanup();
  }
});

test('delete shared: symlinks go, canonical store stays', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Personal', { mode: 'shared' });
    const res = await deleteProfile(sb.p, 'Personal');
    assert.ok(res.snapshotDir);
    assert.ok((await fsp.stat(path.join(res.snapshotDir!, '.claude.json'))).isFile());
    assert.equal(await getProfile(sb.p, 'Personal'), undefined);
    assert.equal(await fsp.readFile(path.join(sb.p.claudeDir, 'projects', '-repo-x', 'memory', 'MEMORY.md'), 'utf8'), '# mem\n');
    assert.ok((await fsp.stat(path.join(sb.p.claudeDir, 'settings.json'))).isFile());
  } finally {
    await sb.cleanup();
  }
});

test('delete shared with drift refuses', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Personal', { mode: 'shared' });
    const dir = path.join(sb.p.profilesRoot, 'Personal');
    await fsp.unlink(path.join(dir, 'projects'));
    await fsp.mkdir(path.join(dir, 'projects'));
    await assert.rejects(deleteProfile(sb.p, 'Personal'), (e: unknown) => e instanceof ClaudeCodeSwitcherError && e.code === 'DELETE_DRIFT');
    assert.ok(await getProfile(sb.p, 'Personal'));
  } finally {
    await sb.cleanup();
  }
});

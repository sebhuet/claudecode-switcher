import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { sandbox } from './helpers';
import { createProfile } from '../src/profiles';
import { projectSlug } from '../src/paths';
import { listSessions, projectDirFor } from '../src/sessions';

test('projectSlug matches Claude Code naming', () => {
  assert.equal(projectSlug('/Users/prasunroy/Documents/Work'), '-Users-prasunroy-Documents-Work');
  assert.equal(projectSlug('/a/b.c_d/'), '-a-b-c-d');
});

test('listSessions reads a profile\'s transcripts for a folder, newest first, with titles', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Work', { mode: 'own' });
    const folder = path.join(sb.home, 'repo');
    const dir = projectDirFor(sb.p, 'Work', folder);
    await fsp.mkdir(dir, { recursive: true });
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    await fsp.writeFile(path.join(dir, `${a}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the   login bug' } }) + '\n');
    await fsp.writeFile(path.join(dir, `${b}.jsonl`), JSON.stringify({ type: 'summary', summary: 'Refactor auth' }) + '\n' + JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'x' }] } }) + '\n');
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'ignored');
    await fsp.utimes(path.join(dir, `${a}.jsonl`), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    const list = await listSessions(sb.p, 'Work', folder);
    assert.deepEqual(list.map((s) => [s.id, s.title]), [[b, 'Refactor auth'], [a, 'fix the login bug']]);
    assert.deepEqual(await listSessions(sb.p, 'default', folder), []);
  } finally {
    await sb.cleanup();
  }
});

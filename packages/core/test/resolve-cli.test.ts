import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { sandbox, mkdirp } from './helpers';
import { createProfile } from '../src/profiles';
import { setMapping } from '../src/map';
import { main } from '../src/resolve-cli';

async function run(argv: string[], env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, env, (s) => out.push(s), (s) => err.push(s));
  return { code, out, err };
}

test('resolve-cli prints configDir or empty; exit 3 on unknown profile', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Work', { mode: 'own' });
    const proj = await mkdirp(sb.home, 'proj');
    await setMapping(sb.p, proj, 'Work');
    let r = await run(['--cwd', proj], sb.env);
    assert.equal(r.code, 0);
    assert.deepEqual(r.out, [path.join(sb.p.profilesRoot, 'Work')]);
    r = await run(['--cwd', sb.home], sb.env);
    assert.deepEqual(r.out, ['']);
    r = await run(['--cwd', proj, '--json'], sb.env);
    assert.equal(JSON.parse(r.out[0]).source, 'map');
    r = await run(['--cwd', proj], { ...sb.env, CLAUDE_PROFILE: 'Ghost' });
    assert.equal(r.code, 3);
    assert.ok(r.err[0].includes('Unknown profile "Ghost"'));
    // lock path: second profile on the same project warns
    r = await run(['--cwd', proj, '--lock'], { ...sb.env, CLAUDECODE_SWITCHER_LOCK_PID: String(process.pid) });
    assert.equal(r.code, 0);
    r = await run(['--cwd', proj, '--lock'], { ...sb.env, CLAUDE_PROFILE: 'default', CLAUDECODE_SWITCHER_LOCK_PID: String(process.pid) });
    assert.equal(r.code, 0); // same pid replaces, so no contention from itself
  } finally {
    await sb.cleanup();
  }
});

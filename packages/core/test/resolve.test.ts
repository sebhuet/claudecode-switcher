import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { sandbox, mkdirp, write } from './helpers';
import { createProfile } from '../src/profiles';
import { resolve } from '../src/resolve';
import { writeMap } from '../src/map';
import { UnknownProfileError } from '../src/errors';

interface Case {
  name: string;
  env?: Record<string, string>;
  cwd: string; // relative to $HOME unless absolute
  map?: [string, string][]; // [prefix rel to home, profile]
  pins?: [string, string][]; // [dir rel to home, profile]
  label?: string;
  expect: { profile: string; source: string; configDir?: 'unset' | string } | 'unknown';
}

const CASES: Case[] = [
  { name: 'nothing configured → default', cwd: 'src/x', expect: { profile: 'default', source: 'default', configDir: 'unset' } },
  { name: 'explicit CLAUDE_CONFIG_DIR wins over everything', env: { CLAUDE_CONFIG_DIR: '/somewhere/else', CLAUDE_PROFILE: 'Work' }, cwd: 'src/x', map: [['src', 'Personal']], pins: [['src/x', 'Personal']], expect: { profile: 'external', source: 'env-config-dir', configDir: '/somewhere/else' } },
  { name: 'explicit CLAUDE_CONFIG_DIR that is a known profile dir reports its name', env: { CLAUDE_CONFIG_DIR: '.claude-profiles/Work' }, cwd: 'src', expect: { profile: 'Work', source: 'env-config-dir', configDir: '.claude-profiles/Work' } },
  { name: 'explicit CLAUDE_CONFIG_DIR = ~/.claude → default, still respected verbatim', env: { CLAUDE_CONFIG_DIR: '.claude' }, cwd: 'src', expect: { profile: 'default', source: 'env-config-dir', configDir: '.claude' } },
  { name: 'empty CLAUDE_CONFIG_DIR is ignored', env: { CLAUDE_CONFIG_DIR: '  ' }, cwd: 'src', map: [['src', 'Work']], expect: { profile: 'Work', source: 'map' } },
  { name: 'CLAUDE_PROFILE beats pin and map', env: { CLAUDE_PROFILE: 'Work' }, cwd: 'src/x', map: [['src', 'Personal']], pins: [['src/x', 'Personal']], expect: { profile: 'Work', source: 'env-profile' } },
  { name: 'CLAUDE_PROFILE=default → default', env: { CLAUDE_PROFILE: 'default' }, cwd: 'src', map: [['src', 'Work']], expect: { profile: 'default', source: 'env-profile', configDir: 'unset' } },
  { name: 'CLAUDE_PROFILE=Default (case) → default', env: { CLAUDE_PROFILE: 'Default' }, cwd: 'src', expect: { profile: 'default', source: 'env-profile', configDir: 'unset' } },
  { name: 'CLAUDE_PROFILE unknown → error, no silent fallback', env: { CLAUDE_PROFILE: 'Nope' }, cwd: 'src', map: [['src', 'Work']], expect: 'unknown' },
  { name: 'pin in cwd', cwd: 'src/x', pins: [['src/x', 'Personal']], expect: { profile: 'Personal', source: 'pin-file' } },
  { name: 'pin in parent', cwd: 'src/x/deep/er', pins: [['src', 'Personal']], expect: { profile: 'Personal', source: 'pin-file' } },
  { name: 'nested pin beats parent pin', cwd: 'src/x/deep', pins: [['src', 'Personal'], ['src/x', 'Work']], expect: { profile: 'Work', source: 'pin-file' } },
  { name: 'pin beats map', cwd: 'src/x', pins: [['src', 'Personal']], map: [['src/x', 'Work']], expect: { profile: 'Personal', source: 'pin-file' } },
  { name: 'pin at $HOME itself is honoured', cwd: 'src/x', pins: [['', 'Work']], expect: { profile: 'Work', source: 'pin-file' } },
  { name: 'pin above $HOME is NOT honoured', cwd: 'src/x', pins: [['..', 'Work']], expect: { profile: 'default', source: 'default' } },
  { name: 'pin naming default → default', cwd: 'src', pins: [['src', 'default']], map: [['src', 'Work']], expect: { profile: 'default', source: 'pin-file', configDir: 'unset' } },
  { name: 'pin unknown → error', cwd: 'src', pins: [['src', 'Ghost']], expect: 'unknown' },
  { name: 'pin with comment and blank lines', cwd: 'src', pins: [['src', '# which account\n\nWork\n']], expect: { profile: 'Work', source: 'pin-file' } },
  { name: 'pin with CRLF', cwd: 'src', pins: [['src', 'Work\r\n']], expect: { profile: 'Work', source: 'pin-file' } },
  { name: 'map exact match', cwd: 'src/x', map: [['src/x', 'Work']], expect: { profile: 'Work', source: 'map' } },
  { name: 'map prefix match on child', cwd: 'src/x/deep', map: [['src/x', 'Work']], expect: { profile: 'Work', source: 'map' } },
  { name: 'longest prefix beats shorter', cwd: 'src/x/deep', map: [['src', 'Personal'], ['src/x', 'Work']], expect: { profile: 'Work', source: 'map' } },
  { name: 'longest prefix order-independent', cwd: 'src/x/deep', map: [['src/x', 'Work'], ['src', 'Personal']], expect: { profile: 'Work', source: 'map' } },
  { name: 'map does not match on string prefix without boundary', cwd: 'src/xy', map: [['src/x', 'Work']], expect: { profile: 'default', source: 'default' } },
  { name: 'map trailing slash normalised', cwd: 'src/x/deep', map: [['src/x/', 'Work']], expect: { profile: 'Work', source: 'map' } },
  { name: 'map entry pointing at default → default', cwd: 'src/x', map: [['src', 'Work'], ['src/x', 'default']], expect: { profile: 'default', source: 'map', configDir: 'unset' } },
  { name: 'map unknown profile → error', cwd: 'src', map: [['src', 'Ghost']], expect: 'unknown' },
  { name: 'map non-matching unknown profile is harmless', cwd: 'other', map: [['src', 'Ghost']], expect: { profile: 'default', source: 'default' } },
  { name: '_default.label alias → default', cwd: 'src', map: [['src', 'Me']], label: 'Me', expect: { profile: 'default', source: 'map', configDir: 'unset' } },
  { name: 'cwd outside $HOME with map', cwd: '/tmp', map: [['/tmp', 'Work']], expect: { profile: 'Work', source: 'map' } },
  { name: 'shared profile resolves with mode', cwd: 'src', map: [['src', 'Personal']], expect: { profile: 'Personal', source: 'map' } },
];

test('resolver fixture table', async (t) => {
  for (const c of CASES) {
    await t.test(c.name, async () => {
      const sb = await sandbox();
      try {
        await createProfile(sb.p, 'Work', { mode: 'own' });
        await createProfile(sb.p, 'Personal', { mode: 'shared' });
        const abs = (rel: string) => (path.isAbsolute(rel) ? rel : path.join(sb.home, rel));
        const cwd = abs(c.cwd);
        await mkdirp(cwd);
        for (const [dir, prof] of c.pins ?? []) await write(path.join(abs(dir), '.claude-profile'), prof.includes('\n') ? prof : prof + '\n');
        if (c.map) await writeMap(sb.p, c.map.map(([pre, prof]) => ({ prefix: abs(pre), profile: prof })));
        if (c.label) await fsp.writeFile(sb.p.defaultLabelFile, c.label + '\n');
        const env: NodeJS.ProcessEnv = { ...sb.env };
        for (const [k, v] of Object.entries(c.env ?? {})) env[k] = k === 'CLAUDE_CONFIG_DIR' && v.trim() && !path.isAbsolute(v) ? abs(v) : v;

        if (c.expect === 'unknown') {
          await assert.rejects(resolve({ cwd, env, paths: sb.p }), (e: unknown) => e instanceof UnknownProfileError);
          return;
        }
        const r = await resolve({ cwd, env, paths: sb.p });
        assert.equal(r.profile, c.expect.profile);
        assert.equal(r.source, c.expect.source);
        if (c.expect.configDir === 'unset' || (c.expect.profile === 'default' && !c.expect.configDir)) assert.equal(r.configDir, undefined);
        else if (c.expect.configDir) assert.equal(r.configDir, path.isAbsolute(c.expect.configDir) ? c.expect.configDir : abs(c.expect.configDir));
        else assert.equal(r.configDir, path.join(sb.p.profilesRoot, c.expect.profile));
        if (c.expect.profile === 'Personal') assert.equal(r.mode, 'shared');
        if (c.expect.profile === 'Work') assert.equal(r.mode, 'own');
        if (c.expect.profile === 'default') assert.equal(r.mode, 'own');
      } finally {
        await sb.cleanup();
      }
    });
  }
});

test('resolve never touches the real ~/.claude', async () => {
  const sb = await sandbox();
  try {
    const r = await resolve({ cwd: sb.home, env: sb.env, paths: sb.p });
    assert.equal(r.profile, 'default');
    assert.ok(sb.p.claudeDir.startsWith(sb.home));
  } finally {
    await sb.cleanup();
  }
});

test('symlinked cwd: pin above $HOME ignored, map matches via realpath', async () => {
  const sb = await sandbox();
  try {
    await createProfile(sb.p, 'Work', { mode: 'own' });
    // $HOME reachable through a symlink; cwd handed over as the symlinked (logical) path
    const link = path.join(path.dirname(sb.home), path.basename(sb.home) + '-link');
    await fsp.symlink(sb.home, link);
    try {
      const cwdLogical = path.join(link, 'src', 'x');
      await mkdirp(path.join(sb.home, 'src', 'x'));
      // a pin in the parent OF $HOME must not be honoured even though the logical walk passes it
      await write(path.join(path.dirname(sb.home), '.claude-profile'), 'Work\n');
      let r = await resolve({ cwd: cwdLogical, env: sb.env, paths: sb.p });
      assert.equal(r.profile, 'default');
      // and the other way round: physical cwd, logical map prefix
      await writeMap(sb.p, [{ prefix: path.join(link, 'src'), profile: 'Work' }]);
      r = await resolve({ cwd: path.join(sb.home, 'src', 'x'), env: sb.env, paths: sb.p });
      assert.equal(r.profile, 'Work', 'logical map prefix matches physical cwd');
      await writeMap(sb.p, [{ prefix: path.join(sb.home, 'src'), profile: 'Work' }]);
      r = await resolve({ cwd: cwdLogical, env: sb.env, paths: sb.p });
      assert.equal(r.profile, 'Work');
      assert.equal(r.source, 'map');
    } finally {
      await fsp.rm(path.join(path.dirname(sb.home), '.claude-profile'), { force: true });
      await fsp.unlink(link);
    }
  } finally {
    await sb.cleanup();
  }
});

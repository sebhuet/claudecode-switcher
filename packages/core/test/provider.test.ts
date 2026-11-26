import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { sandbox } from './helpers';
import { PROVIDER_SETTINGS, Provider, createProfile, getProfile, providerSettings } from '../src/profiles';
import { doctor } from '../src/doctor';

const ollama: Provider = { kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3-coder' };

test('providerSettings maps every model alias to the one local model', () => {
  const s = providerSettings(ollama);
  assert.equal(s.model, 'qwen3-coder');
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'http://localhost:11434');
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, 'ollama');
  assert.equal(s.env.ANTHROPIC_API_KEY, '');
  for (const v of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
    assert.equal(s.env[v], 'qwen3-coder', v);
  }
});

test('a bad provider is refused before anything is created', async () => {
  const sb = await sandbox();
  try {
    const bad: Provider[] = [
      { ...ollama, kind: 'openai' as 'ollama' },
      { ...ollama, baseUrl: 'localhost:11434' },
      { ...ollama, model: 'two words' },
    ];
    for (const provider of bad) {
      await assert.rejects(createProfile(sb.p, 'Local', { mode: 'own', provider }), { code: 'BAD_PROVIDER' });
    }
    assert.equal(fs.existsSync(path.join(sb.p.profilesRoot, 'Local')), false);
  } finally {
    await sb.cleanup();
  }
});

test('a provider profile stores its settings and needs no sign-in', async () => {
  const sb = await sandbox();
  try {
    for (const [name, mode] of [['Local', 'shared'], ['LocalOwn', 'own']] as const) {
      await createProfile(sb.p, name, { mode, provider: ollama });
      const file = path.join(sb.p.profilesRoot, name, PROVIDER_SETTINGS);
      assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), providerSettings(ollama));
      assert.deepEqual((await getProfile(sb.p, name))?.meta?.provider, ollama);
    }
    await createProfile(sb.p, 'Work', { mode: 'own' });
    const rep = await doctor(sb.p);
    const codes = (n: string) => rep.profiles.find((r) => r.profile.name === n)!.findings.map((f) => f.code);
    assert.ok(codes('Local').includes('PROVIDER'));
    assert.ok(!codes('Local').includes('NOT_LOGGED_IN'));
    assert.ok(codes('Work').includes('NOT_LOGGED_IN'));
  } finally {
    await sb.cleanup();
  }
});

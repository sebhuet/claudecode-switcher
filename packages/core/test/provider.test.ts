import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { sandbox, write } from './helpers';
import { PROVIDER_SETTINGS, createProfile, getProfile, listProfiles } from '../src/profiles';
import { Provider, providerSettings } from '../src/engines';
import { doctor } from '../src/doctor';

const ollama: Provider = { kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3-coder' };

/** provider-settings.json as written for this account since 0.2.0. Changing it changes every new Ollama account. */
const OLLAMA_SETTINGS = {
  model: 'qwen3-coder',
  env: {
    ANTHROPIC_BASE_URL: 'http://localhost:11434',
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: 'qwen3-coder',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3-coder',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3-coder',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'qwen3-coder',
    CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3-coder',
  },
};

test('providerSettings maps every model alias to the one local model', () => {
  assert.deepEqual(providerSettings(ollama), OLLAMA_SETTINGS);
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
      assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), OLLAMA_SETTINGS);
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

test('accounts written by 0.2.0 and unknown engines are read without failing', async () => {
  const sb = await sandbox();
  try {
    const meta = (name: string, provider: object) => ({ name, mode: 'own', createdAt: '2026-11-26T00:00:00.000Z', schemaVersion: 3, provider });
    await write(path.join(sb.p.profilesRoot, 'Old', 'profile.json'), JSON.stringify(meta('Old', ollama)));
    await write(path.join(sb.p.profilesRoot, 'Future', 'profile.json'), JSON.stringify(meta('Future', { kind: 'future', model: 'm' })));
    assert.deepEqual((await getProfile(sb.p, 'Old'))?.meta?.provider, ollama);
    assert.deepEqual((await listProfiles(sb.p)).map((x) => x.name), ['default', 'Future', 'Old']);
    await write(path.join(sb.p.profilesRoot, 'Old', PROVIDER_SETTINGS), JSON.stringify(OLLAMA_SETTINGS));
    const codes = async (n: string) => (await doctor(sb.p)).profiles.find((r) => r.profile.name === n)!.findings.map((f) => f.code);
    const engineCodes = async (n: string) => (await codes(n)).filter((c) => c.includes('PROVIDER'));
    assert.deepEqual(await engineCodes('Old'), ['PROVIDER']);
    assert.deepEqual(await engineCodes('Future'), ['PROVIDER', 'UNKNOWN_PROVIDER', 'PROVIDER_SETTINGS_MISSING']);
    assert.ok((await doctor(sb.p)).profiles.every((r) => r.findings.every((f) => !f.message.includes('undefined'))));
  } finally {
    await sb.cleanup();
  }
});

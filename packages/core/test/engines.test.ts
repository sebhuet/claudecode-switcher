import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getEngine, providerLabel, providerSettings } from '../src/engines';

/** A local HTTP server answering every request with `body`; returns its base URL and a closer. */
async function serve(body: unknown, status = 200): Promise<{ url: string; seen: http.IncomingMessage[]; close(): Promise<void> }> {
  const seen: http.IncomingMessage[] = [];
  const srv = http.createServer((req, res) => (seen.push(req), res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => srv.close(() => r())) };
}

test('providerLabel names the engine, and the URL only when there is one', () => {
  assert.equal(providerLabel({ kind: 'ollama', model: 'qwen3-coder', baseUrl: 'http://h:1' }), 'Ollama · qwen3-coder');
  assert.equal(providerLabel({ kind: 'ollama', model: 'qwen3-coder', baseUrl: 'http://h:1' }, true), 'Ollama · qwen3-coder at http://h:1');
  assert.equal(providerLabel({ kind: 'future', model: 'm' }, true), 'future · m');
});

test('Ollama lists its models, and says what is wrong when it cannot', async () => {
  const list = getEngine('ollama')!.listModels!;
  const ok = await serve({ models: [{ name: 'qwen3-coder', size: 18_600_000_000 }] });
  try {
    assert.deepEqual(await list({ baseUrl: ok.url }), [{ name: 'qwen3-coder', detail: '18.6 GB' }]);
  } finally {
    await ok.close();
  }
  const empty = await serve({ models: [] });
  try {
    await assert.rejects(list({ baseUrl: empty.url }), /has no model\. Pull one first/);
  } finally {
    await empty.close();
  }
  await assert.rejects(list({ baseUrl: empty.url }), /Ollama is not answering at/);
});

test('Anthropic-compatible server: models listed with the key, or typed by hand', async () => {
  const gw = getEngine('gateway')!;
  const srv = await serve({ data: [{ id: 'qwen/qwen3-coder' }, { id: 'glm-4.6' }] });
  try {
    assert.deepEqual(await gw.listModels!({ baseUrl: srv.url, token: 'sk-1' }), [{ name: 'qwen/qwen3-coder' }, { name: 'glm-4.6' }]);
    assert.equal(srv.seen[0].url, '/v1/models');
    assert.equal(srv.seen[0].headers.authorization, 'Bearer sk-1');
  } finally {
    await srv.close();
  }
  const err = await serve({ error: 'no' }, 404);
  try {
    assert.deepEqual(await gw.listModels!({ baseUrl: err.url, token: '' }), []);
    assert.equal(err.seen[0].headers.authorization, undefined, 'no key, no header');
  } finally {
    await err.close();
  }
  assert.deepEqual(await gw.listModels!({ baseUrl: err.url, token: '' }), [], 'server down');
});

test('Anthropic-compatible server: the key is the token, never empty, never the Anthropic key', () => {
  const env = (token: string) => providerSettings({ kind: 'gateway', baseUrl: 'https://gw', model: 'm', token }).env;
  assert.equal(env('sk-1').ANTHROPIC_AUTH_TOKEN, 'sk-1');
  assert.equal(env('').ANTHROPIC_AUTH_TOKEN, 'gateway');
  assert.equal(env('sk-1').ANTHROPIC_API_KEY, '');
  assert.equal(env('').ANTHROPIC_DEFAULT_FABLE_MODEL, 'm');
});

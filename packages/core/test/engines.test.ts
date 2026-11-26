import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getEngine, providerLabel } from '../src/engines';

/** A local HTTP server answering every request with `body`; returns its base URL and a closer. */
async function serve(body: unknown, status = 200): Promise<{ url: string; close(): Promise<void> }> {
  const srv = http.createServer((_req, res) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise((r) => srv.close(() => r())) };
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

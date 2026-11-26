import { fake } from './fake-vscode';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type * as core from '../../core/src';
import { promptProvider } from '../src/engine-prompt';

const engine = (listed: core.ModelChoice[] | undefined): core.Engine => ({
  kind: 'test',
  label: 'Test',
  description: '',
  fields: [
    { key: 'baseUrl', title: 'server URL', value: 'http://localhost:1', validate: (v) => (v.startsWith('http') ? undefined : 'bad') },
    { key: 'token', title: 'API key', secret: true },
  ],
  listModels: listed && (async () => listed),
  settings: () => ({ model: '', env: {} }),
});

beforeEach(() => fake.reset());

test('fields are asked in order, URL cleaned, secret hidden, model picked from the list', async () => {
  const asked: Record<string, unknown>[] = [];
  const answers = [' http://x:1/ ', ' k '];
  fake.answerInput = (o) => (asked.push(o), answers.shift());
  fake.answerPick = (_t, items) => (items as { label: string }[])[1];
  const pr = await promptProvider(engine([{ name: 'a' }, { name: 'b', detail: '1 GB' }]));
  assert.deepEqual(pr, { kind: 'test', baseUrl: 'http://x:1', token: 'k', model: 'b' });
  assert.deepEqual(asked.map((o) => [o.title, o.value, o.password]), [['Test — server URL', 'http://localhost:1', undefined], ['Test — API key', undefined, true]]);
  assert.equal((asked[0].validateInput as (v: string) => unknown)('nope'), 'bad');
});

test('no model list: the model is typed; cancelling anywhere returns undefined', async () => {
  const answers = ['http://x', '', ' m1 '];
  fake.answerInput = () => answers.shift();
  assert.deepEqual(await promptProvider(engine([])), { kind: 'test', baseUrl: 'http://x', token: '', model: 'm1' });
  assert.deepEqual(await promptProvider({ ...engine(undefined), fields: [] }), undefined);
  fake.answerInput = () => 'http://x';
  fake.answerPick = () => undefined;
  assert.equal(await promptProvider(engine([{ name: 'a' }])), undefined);
});

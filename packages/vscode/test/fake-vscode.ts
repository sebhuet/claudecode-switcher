/**
 * A minimal stand-in for the `vscode` module: just what routing.ts touches.
 * Imported first by each test file, so `require('vscode')` in the bundle gets this.
 */
import Module from 'node:module';

type Answer = (msg: string, items: unknown[]) => unknown;

export const fake = {
  settings: new Map<string, unknown>(),
  globalState: new Map<string, unknown>(),
  messages: [] as string[],
  officialInstalled: true,
  answerMessage: (() => undefined) as Answer,
  answerPick: (() => undefined) as Answer,
  reset(): void {
    this.settings.clear();
    this.globalState.clear();
    this.messages.length = 0;
    this.officialInstalled = true;
    this.answerMessage = () => undefined;
    this.answerPick = () => undefined;
  },
};

const vscode = {
  ConfigurationTarget: { Global: 1 },
  extensions: { getExtension: (id: string) => (fake.officialInstalled && id === 'anthropic.claude-code' ? {} : undefined) },
  workspace: {
    getConfiguration: (section: string) => ({
      get: (k: string, d?: unknown) => fake.settings.get(`${section}.${k}`) ?? d,
      inspect: (k: string) => ({ globalValue: fake.settings.get(`${section}.${k}`) }),
      update: async (k: string, v: unknown) => {
        if (v === undefined) fake.settings.delete(`${section}.${k}`);
        else fake.settings.set(`${section}.${k}`, v);
      },
    }),
  },
  window: {
    showErrorMessage: async (m: string) => void fake.messages.push(m),
    showInformationMessage: async (m: string, ...items: unknown[]) => (fake.messages.push(m), fake.answerMessage(m, items)),
    showQuickPick: async (items: unknown[], o: { title?: string }) => fake.answerPick(o.title ?? '', items),
  },
};

const M = Module as unknown as { _load: (req: string, ...a: unknown[]) => unknown };
const load = M._load;
M._load = function (req: string, ...a: unknown[]) {
  return req === 'vscode' ? vscode : load.call(this, req, ...a);
};

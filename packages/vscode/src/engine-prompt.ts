/**
 * engine-prompt.ts — asks an engine's fields, then its model, from the engine's own
 * description (core/engines.ts). One generic flow; no per-engine UI.
 */
import * as vscode from 'vscode';
import * as core from '../../core/src';

/** The account's provider, or undefined when the user cancels. Listing errors propagate. */
export async function promptProvider(engine: core.Engine): Promise<core.Provider | undefined> {
  const options: Record<string, string> = {};
  for (const f of engine.fields) {
    const v = await vscode.window.showInputBox({
      title: `${engine.label} — ${f.title}`,
      value: f.value,
      password: f.secret,
      validateInput: (x) => f.validate?.(x.trim()),
    });
    if (v === undefined) return undefined;
    const t = v.trim();
    options[f.key] = /^https?:\/\//.test(t) ? t.replace(/\/+$/, '') : t;
  }
  const title = `${engine.label} — model`;
  const models = (await engine.listModels?.(options)) ?? [];
  const model = models.length
    ? (await vscode.window.showQuickPick(models.map((m) => ({ label: m.name, description: m.detail })), {
        title,
        placeHolder: 'Pick a model with tool calling; Claude Code sends ~15k tokens of prompt per request',
      }))?.label
    : (await vscode.window.showInputBox({ title, prompt: 'The server did not list its models; type one.', validateInput: (x) => (/^\S+$/.test(x.trim()) ? undefined : 'A model name.') }))?.trim();
  return model ? { ...options, kind: engine.kind, model } : undefined;
}

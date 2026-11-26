/**
 * engines.ts — the non-Anthropic backends an account can use instead of a Claude login.
 *
 * Adding one is an `Engine` object here and its entry in ENGINES; the extension builds its
 * questions from `fields`. On disk an account stores `provider` (kind, model, options) in
 * profile.json and the output of `settings()` in provider-settings.json, which the wrapper
 * passes with `--settings`: that outranks the user's settings.json, whose `model` or `env`
 * would otherwise send Claude model names to the engine.
 */
import { ClaudeCodeSwitcherError } from './errors';

/** profile.json `provider`: the engine kind, the model and the engine's options (by field key). */
export interface Provider {
  kind: string;
  model: string;
  [option: string]: string;
}

export interface EngineField {
  key: string;
  title: string;
  /** Default value offered. */
  value?: string;
  /** Goes to provider-settings.json only, never to profile.json; typed hidden. */
  secret?: boolean;
  /** Error message, or undefined when valid. */
  validate?(v: string): string | undefined;
}

export interface ModelChoice {
  name: string;
  detail?: string;
}

export interface Engine {
  kind: string;
  label: string;
  description: string;
  /** Asked in order, before the model. */
  fields: EngineField[];
  /** Models to pick from; an empty list means the model is typed by hand. */
  listModels?(options: Record<string, string>): Promise<ModelChoice[]>;
  settings(pr: Provider): { model: string; env: Record<string, string> };
}

const MODEL_VARS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

/**
 * Settings for a server that speaks the Anthropic Messages API at `baseUrl`. Every model alias
 * maps to the one model. The token is never empty and the API key always is, so an Anthropic
 * credential from the environment never reaches a third-party server.
 */
export function anthropicCompat(pr: Provider, token?: string): { model: string; env: Record<string, string> } {
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: pr.baseUrl, ANTHROPIC_AUTH_TOKEN: token || pr.kind, ANTHROPIC_API_KEY: '' };
  for (const v of MODEL_VARS) env[v] = pr.model;
  return { model: pr.model, env };
}

const httpUrl = (v: string): string | undefined => (/^https?:\/\/\S+$/.test(v) ? undefined : `"${v}" is not an http(s) URL.`);

async function getJson(url: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}`, 'x-api-key': token } : {};
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const ollama: Engine = {
  kind: 'ollama',
  label: 'Ollama',
  description: 'a local model, no sign-in',
  fields: [{ key: 'baseUrl', title: 'server URL', value: 'http://localhost:11434', validate: httpUrl }],
  async listModels(o) {
    let models: { name: string; size: number }[];
    try {
      models = ((await getJson(`${o.baseUrl}/api/tags`)) as { models?: { name: string; size: number }[] }).models ?? [];
    } catch (e) {
      throw new Error(`Ollama is not answering at ${o.baseUrl} (${(e as Error).message}). Start it, then try again.`);
    }
    if (!models.length) throw new Error(`Ollama at ${o.baseUrl} has no model. Pull one first (ollama pull <model>).`);
    return models.map((m) => ({ name: m.name, detail: `${(m.size / 1e9).toFixed(1)} GB` }));
  },
  settings: (pr) => anthropicCompat(pr),
};

/** Any server speaking the Anthropic Messages API: LM Studio, llama.cpp, vLLM, LiteLLM, OpenRouter… */
const gateway: Engine = {
  kind: 'gateway',
  label: 'Anthropic-compatible server',
  description: 'LM Studio, llama.cpp, vLLM, LiteLLM, OpenRouter… (Messages API)',
  fields: [
    { key: 'baseUrl', title: 'server URL', validate: httpUrl },
    { key: 'token', title: 'API key (empty if none)', secret: true },
  ],
  async listModels(o) {
    try {
      return (((await getJson(`${o.baseUrl}/v1/models`, o.token)) as { data?: { id: string }[] }).data ?? []).map((m) => ({ name: m.id }));
    } catch {
      return []; // not every server lists its models: the model is then typed by hand
    }
  },
  settings: (pr) => anthropicCompat(pr, pr.token),
};

export const ENGINES: Engine[] = [ollama, gateway];

export function getEngine(kind: string): Engine | undefined {
  return ENGINES.find((e) => e.kind === kind);
}

export function validateProvider(pr: Provider): Engine {
  const engine = getEngine(pr.kind);
  if (!engine) throw new ClaudeCodeSwitcherError('BAD_PROVIDER', `Unknown provider "${String(pr.kind)}".`);
  for (const f of engine.fields) {
    const bad = f.validate?.(pr[f.key] ?? '');
    if (bad) throw new ClaudeCodeSwitcherError('BAD_PROVIDER', `${engine.label} ${f.title}: ${bad}`);
  }
  if (!/^\S+$/.test(pr.model ?? '')) throw new ClaudeCodeSwitcherError('BAD_PROVIDER', `"${pr.model}" is not a model name.`);
  return engine;
}

/** What provider-settings.json holds for this account. */
export function providerSettings(pr: Provider): { model: string; env: Record<string, string> } {
  return validateProvider(pr).settings(pr);
}

/** The provider as stored in profile.json: without its secret fields, which live in provider-settings.json only. */
export function publicProvider(pr: Provider): Provider {
  const secret = new Set(getEngine(pr.kind)?.fields.filter((f) => f.secret).map((f) => f.key));
  return Object.fromEntries(Object.entries(pr).filter(([k]) => !secret.has(k))) as Provider;
}

/** `Ollama · qwen3-coder`, with ` at <url>` when asked and the engine has one. Works for unknown kinds. */
export function providerLabel(pr: Provider, withUrl = false): string {
  return `${getEngine(pr.kind)?.label ?? pr.kind} · ${pr.model}${withUrl && pr.baseUrl ? ` at ${pr.baseUrl}` : ''}`;
}

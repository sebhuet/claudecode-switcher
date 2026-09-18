/**
 * resolve.ts — THE resolver. The only implementation of routing that exists.
 *
 * The extension imports it; the wrapper script and the shell helper call it
 * via `node`. Never reimplement this in shell.
 *
 * Order:
 *  1. CLAUDE_CONFIG_DIR already in the environment → respect it, change nothing.
 *  2. CLAUDE_PROFILE=<name>                         → that profile.
 *  3. `.claude-profile` file in cwd or any parent up to $HOME → that profile.
 *  4. Longest matching prefix in the folder→profile map → that profile.
 *  5. Otherwise → default.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULT_PROFILE, PIN_FILE, Paths, configDirEnvFor, isDefaultProfile, profileNameForDir, stripTrailingSlash } from './paths';
import { UnknownProfileError } from './errors';
import { getProfile, profileExists } from './profiles';
import { longestMatchReal, readMap } from './map';
import { StorageMode } from './storage';

export type ResolveSource = 'env-config-dir' | 'env-profile' | 'pin-file' | 'map' | 'default';

export interface Resolution {
  /** Profile name; `external` when CLAUDE_CONFIG_DIR points outside the profiles root. */
  profile: string;
  /** Value to put in CLAUDE_CONFIG_DIR for a NEW process. `undefined` = leave unset. */
  configDir: string | undefined;
  mode: StorageMode | 'unknown';
  source: ResolveSource;
  /** Which file / map line / env value fired. */
  detail?: string;
}

export interface ResolveInput {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  paths: Paths;
}

async function readPin(dir: string): Promise<string | undefined> {
  try {
    const raw = await fsp.readFile(path.join(dir, PIN_FILE), 'utf8');
    const first = raw.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'));
    return first?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function realpathSafe(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Walk from cwd upward. Stops after $HOME (inclusive) when cwd is under $HOME;
 * else at `/`. Both the logical path and its realpath are compared, because
 * `process.cwd()` returns the physical path while $HOME/$PWD are logical
 * (macOS: /var vs /private/var).
 */
export async function findPinFile(p: Paths, cwd: string): Promise<{ dir: string; profile: string } | undefined> {
  let dir = stripTrailingSlash(path.resolve(cwd));
  const home = stripTrailingSlash(path.resolve(p.home));
  const homeReal = stripTrailingSlash(await realpathSafe(home));
  const isHome = async (d: string) => d === home || d === homeReal || stripTrailingSlash(await realpathSafe(d)) === homeReal;
  const dirReal = stripTrailingSlash(await realpathSafe(dir));
  const underHome = (await isHome(dir)) || dir.startsWith(home + path.sep) || dirReal.startsWith(homeReal + path.sep);
  for (;;) {
    const name = await readPin(dir);
    if (name) return { dir, profile: name };
    if (underHome && (await isHome(dir))) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function aliasToDefault(p: Paths, name: string): Promise<boolean> {
  if (isDefaultProfile(name)) return true;
  try {
    const label = (await fsp.readFile(p.defaultLabelFile, 'utf8')).trim();
    return !!label && label === name;
  } catch {
    return false;
  }
}

async function finish(p: Paths, name: string, source: ResolveSource, detail: string): Promise<Resolution> {
  if (await aliasToDefault(p, name)) {
    return { profile: DEFAULT_PROFILE, configDir: undefined, mode: 'own', source, detail };
  }
  if (!(await profileExists(p, name))) throw new UnknownProfileError(name, `${source}: ${detail}`);
  const info = await getProfile(p, name);
  return { profile: name, configDir: configDirEnvFor(p, name), mode: info?.mode ?? 'unknown', source, detail };
}

export async function resolve(input: ResolveInput): Promise<Resolution> {
  const { paths: p } = input;
  const env = input.env ?? process.env;
  const cwd = path.resolve(input.cwd);

  // 1. Explicit CLAUDE_CONFIG_DIR outranks the tool.
  const explicit = env.CLAUDE_CONFIG_DIR;
  if (explicit && explicit.trim()) {
    const name = profileNameForDir(p, explicit.trim());
    let mode: Resolution['mode'] = 'unknown';
    if (name) mode = (await getProfile(p, name))?.mode ?? 'unknown';
    return { profile: name ?? 'external', configDir: explicit, mode, source: 'env-config-dir', detail: explicit };
  }

  // 2. CLAUDE_PROFILE
  const envProfile = env.CLAUDE_PROFILE?.trim();
  if (envProfile) return finish(p, envProfile, 'env-profile', `CLAUDE_PROFILE=${envProfile}`);

  // 3. .claude-profile pin file
  const pin = await findPinFile(p, cwd);
  if (pin) return finish(p, pin.profile, 'pin-file', path.join(pin.dir, PIN_FILE));

  // 4. map.conf longest prefix
  const hit = await longestMatchReal(await readMap(p), cwd);
  if (hit) return finish(p, hit.profile, 'map', `${hit.prefix}|${hit.profile}`);

  // 5. default
  return { profile: DEFAULT_PROFILE, configDir: undefined, mode: 'own', source: 'default' };
}

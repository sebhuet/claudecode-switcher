/**
 * paths.ts — every `~/.claude` vs `CLAUDE_CONFIG_DIR` asymmetry, in one place.
 *
 * Rules that live here and nowhere else:
 *  - Profile `default` IS `~/.claude`. Its root JSON is `~/.claude.json`
 *    (a sibling of the directory), and a new Claude process for it must run
 *    with CLAUDE_CONFIG_DIR *unset*.
 *  - Every other profile lives at `<profilesRoot>/<name>` and its root JSON
 *    is `<profileDir>/.claude.json` (inside the directory).
 */
import * as os from 'node:os';
import * as path from 'node:path';

export const DEFAULT_PROFILE = 'default';
export const PROFILE_META = 'profile.json';
export const ROOT_JSON = '.claude.json';
export const CREDENTIALS_FILE = '.credentials.json';
export const MAP_FILE = 'map.conf';
export const DEFAULT_LABEL_FILE = '_default.label';
export const PIN_FILE = '.claude-profile';

/** Directory names under the profiles root that are never profiles. */
export const RESERVED_DIRS = new Set(['_bin', '_locks', '_backups']);

export interface Paths {
  /** $HOME used for everything. Tests point this at a temp dir. */
  home: string;
  /** `~/.claude` — the `default` profile and the canonical store for `shared` profiles. */
  claudeDir: string;
  /** `~/.claude.json` — the default profile's root JSON. */
  defaultClaudeJson: string;
  /** `~/.claude-profiles` */
  profilesRoot: string;
  binDir: string;
  locksDir: string;
  backupsDir: string;
  mapFile: string;
  defaultLabelFile: string;
}

export interface PathsOptions {
  home?: string;
  profilesRoot?: string;
}

export function getPaths(opts: PathsOptions = {}): Paths {
  const home = opts.home ?? process.env.HOME ?? os.homedir();
  const profilesRoot = opts.profilesRoot ?? path.join(home, '.claude-profiles');
  return {
    home,
    claudeDir: path.join(home, '.claude'),
    defaultClaudeJson: path.join(home, ROOT_JSON),
    profilesRoot,
    binDir: path.join(profilesRoot, '_bin'),
    locksDir: path.join(profilesRoot, '_locks'),
    backupsDir: path.join(profilesRoot, '_backups'),
    mapFile: path.join(profilesRoot, MAP_FILE),
    defaultLabelFile: path.join(profilesRoot, DEFAULT_LABEL_FILE),
  };
}

export function isDefaultProfile(name: string): boolean {
  return name.toLowerCase() === DEFAULT_PROFILE;
}

/** The directory a profile's Claude state lives in. */
export function profileDir(p: Paths, name: string): string {
  return isDefaultProfile(name) ? p.claudeDir : path.join(p.profilesRoot, name);
}

/** The root JSON (`.claude.json`) for a profile — the asymmetric one. */
export function profileClaudeJson(p: Paths, name: string): string {
  return isDefaultProfile(name) ? p.defaultClaudeJson : path.join(profileDir(p, name), ROOT_JSON);
}

export function profileCredentials(p: Paths, name: string): string {
  return path.join(profileDir(p, name), CREDENTIALS_FILE);
}

export function profileMeta(p: Paths, name: string): string {
  return path.join(profileDir(p, name), PROFILE_META);
}

/**
 * The CLAUDE_CONFIG_DIR value a *new* Claude process should get for a profile.
 * `undefined` for `default`: leave the variable unset. Setting it explicitly to
 * `~/.claude` has broken skill resolution in some Claude Code builds.
 */
export function configDirEnvFor(p: Paths, name: string): string | undefined {
  return isDefaultProfile(name) ? undefined : profileDir(p, name);
}

/** Reverse lookup: which profile owns this config directory, if any. */
export function profileNameForDir(p: Paths, dir: string): string | undefined {
  const norm = stripTrailingSlash(path.resolve(dir));
  if (norm === stripTrailingSlash(p.claudeDir)) return DEFAULT_PROFILE;
  const root = stripTrailingSlash(p.profilesRoot);
  if (norm.startsWith(root + path.sep)) {
    const rel = norm.slice(root.length + 1);
    if (!rel.includes(path.sep) && !RESERVED_DIRS.has(rel)) return rel;
  }
  return undefined;
}

export function expandHome(p: Paths, target: string): string {
  if (target === '~') return p.home;
  if (target.startsWith('~/')) return path.join(p.home, target.slice(2));
  return target;
}

export function stripTrailingSlash(s: string): string {
  return s.length > 1 && s.endsWith('/') ? s.replace(/\/+$/, '') : s;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Profile names are directory names: conservative charset, no reserved names. */
export function validateProfileName(name: string): string | undefined {
  if (!NAME_RE.test(name)) {
    return 'Use 1-64 characters: letters, digits, ".", "_" or "-", starting with a letter or digit.';
  }
  if (name.startsWith('_') || RESERVED_DIRS.has(name)) return `"${name}" is reserved.`;
  if (name === '.' || name === '..') return 'Invalid name.';
  return undefined;
}

/** Claude Code's on-disk name for a project: every non-alphanumeric char becomes "-". */
export function projectSlug(folder: string): string {
  return stripTrailingSlash(folder).replace(/[^A-Za-z0-9]/g, '-');
}

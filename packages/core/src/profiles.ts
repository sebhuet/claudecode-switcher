/**
 * profiles.ts — create / list / delete; owns `profile.json`.
 *
 * `mode` is written exactly once, by `createProfile`. No other code path in
 * this package assigns it (see `changeMode`, which only ever refuses).
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  CREDENTIALS_FILE,
  DEFAULT_PROFILE,
  Paths,
  RESERVED_DIRS,
  ROOT_JSON,
  isDefaultProfile,
  profileClaudeJson,
  profileDir,
  profileMeta,
  validateProfileName,
} from './paths';
import { ClaudeCodeSwitcherError, ModeChangeRefusedError } from './errors';
import { chmodQuiet, ensureDir, exists, lstatOrNull, readJson, timestampSlug, writeJsonAtomic } from './fsx';
import { StorageMode, hasTopLevelSymlinks, linkProfile, LinkResult } from './storage';
import { SeedOptions, SeedResult, seedProfile } from './seed';
import { removeMappingsFor } from './map';

export const SCHEMA_VERSION = 3;

export interface ProfileMeta {
  name: string;
  mode: StorageMode;
  createdAt: string;
  schemaVersion: number;
  /** For `shared`: the canonical store the links point at. */
  sharedTarget?: string;
  /** Set by the legacy importer when a v2 (prior-art) profile was adopted. */
  importedFrom?: string;
}

export interface AccountIdentity {
  /** Login presence only — never token values. */
  loggedIn: boolean;
  accountUuid?: string;
  email?: string;
  organizationName?: string;
}

export interface ProfileInfo extends AccountIdentity {
  name: string;
  dir: string;
  /** `default` is `~/.claude` and has no profile.json. */
  isDefault: boolean;
  /** `undefined` for legacy directories that have no readable mode. */
  mode: StorageMode | undefined;
  meta?: ProfileMeta;
  /** True for a directory without profile.json or without a mode field. */
  legacy: boolean;
}

export async function ensureProfilesRoot(p: Paths): Promise<void> {
  await ensureDir(p.profilesRoot, 0o700);
  await chmodQuiet(p.profilesRoot, 0o700);
}

export async function readProfileMeta(p: Paths, name: string): Promise<ProfileMeta | undefined> {
  if (isDefaultProfile(name)) return undefined;
  return readJson<ProfileMeta>(profileMeta(p, name));
}

/** Identity from a root JSON. Reads presence + accountUuid + email; never a token. */
export async function readIdentity(rootJsonPath: string): Promise<AccountIdentity> {
  const j = await readJson<Record<string, unknown>>(rootJsonPath);
  const acct = j?.oauthAccount as Record<string, unknown> | undefined;
  if (!acct || typeof acct !== 'object') return { loggedIn: false };
  return {
    loggedIn: true,
    accountUuid: typeof acct.accountUuid === 'string' ? acct.accountUuid : undefined,
    email: typeof acct.emailAddress === 'string' ? acct.emailAddress : undefined,
    organizationName: typeof acct.organizationName === 'string' ? acct.organizationName : undefined,
  };
}

export async function profileExists(p: Paths, name: string): Promise<boolean> {
  if (isDefaultProfile(name)) return true;
  if (validateProfileName(name)) return false;
  const st = await lstatOrNull(profileDir(p, name));
  return !!st && st.isDirectory();
}

export async function getProfile(p: Paths, name: string): Promise<ProfileInfo | undefined> {
  if (isDefaultProfile(name)) {
    return {
      name: DEFAULT_PROFILE,
      dir: p.claudeDir,
      isDefault: true,
      mode: 'own',
      legacy: false,
      ...(await readIdentity(p.defaultClaudeJson)),
    };
  }
  if (!(await profileExists(p, name))) return undefined;
  const meta = await readProfileMeta(p, name);
  const mode = meta?.mode === 'shared' || meta?.mode === 'own' ? meta.mode : undefined;
  return {
    name,
    dir: profileDir(p, name),
    isDefault: false,
    mode,
    meta,
    legacy: !mode,
    ...(await readIdentity(profileClaudeJson(p, name))),
  };
}

export async function listProfiles(p: Paths): Promise<ProfileInfo[]> {
  const out: ProfileInfo[] = [(await getProfile(p, DEFAULT_PROFILE))!];
  let children: string[] = [];
  try {
    children = await fsp.readdir(p.profilesRoot);
  } catch {
    return out;
  }
  for (const child of children.sort((a, b) => a.localeCompare(b))) {
    if (RESERVED_DIRS.has(child) || child.startsWith('.') || child.startsWith('_')) continue;
    if (validateProfileName(child)) continue;
    const st = await lstatOrNull(path.join(p.profilesRoot, child));
    if (!st?.isDirectory()) continue;
    const info = await getProfile(p, child);
    if (info) out.push(info);
  }
  return out;
}

export interface CreateOptions extends SeedOptions {
  mode: StorageMode;
}

export interface CreateResult {
  info: ProfileInfo;
  seed: SeedResult;
  link?: LinkResult;
}

/**
 * Create a profile. The ONLY writer of `mode`.
 */
export async function createProfile(p: Paths, name: string, opts: CreateOptions): Promise<CreateResult> {
  const bad = validateProfileName(name);
  if (bad) throw new ClaudeCodeSwitcherError('BAD_NAME', bad);
  if (isDefaultProfile(name)) throw new ClaudeCodeSwitcherError('EXISTS', `"${DEFAULT_PROFILE}" is ~/.claude and already exists.`);
  if (opts.mode !== 'shared' && opts.mode !== 'own') throw new ClaudeCodeSwitcherError('BAD_MODE', `Unknown mode "${String(opts.mode)}".`);

  await ensureProfilesRoot(p);
  const dir = profileDir(p, name);
  if (await exists(dir)) throw new ClaudeCodeSwitcherError('EXISTS', `Profile "${name}" already exists at ${dir}.`);
  if (opts.mode === 'shared' && !(await exists(p.claudeDir))) {
    throw new ClaudeCodeSwitcherError('NO_DEFAULT', `${p.claudeDir} does not exist yet; run Claude Code once on the default account before creating a shared profile.`);
  }

  await fsp.mkdir(dir, { mode: 0o700 });
  const meta: ProfileMeta = {
    name,
    mode: opts.mode,
    createdAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    ...(opts.mode === 'shared' ? { sharedTarget: p.claudeDir } : {}),
  };
  await writeJsonAtomic(profileMeta(p, name), meta, 0o600);

  const seed = await seedProfile(p, name, {
    // shared profiles get settings/CLAUDE.md via symlink; copying would collide with the link.
    copySettings: opts.mode === 'own' && !!opts.copySettings,
    copyClaudeMd: opts.mode === 'own' && !!opts.copyClaudeMd,
  });
  let link: LinkResult | undefined;
  if (opts.mode === 'shared') link = await linkProfile(p, name);

  const info = (await getProfile(p, name))!;
  return { info, seed, link };
}

/**
 * Both conversions are lossy. This function exists so callers have one place
 * to ask and always get the same refusal (with the escape hatch spelled out).
 */
export async function changeMode(p: Paths, name: string, to: StorageMode): Promise<never> {
  const info = await getProfile(p, name);
  if (!info) throw new ClaudeCodeSwitcherError('NOT_FOUND', `Profile "${name}" does not exist.`);
  if (info.isDefault) throw new ClaudeCodeSwitcherError('MODE_CHANGE_REFUSED', `"${DEFAULT_PROFILE}" is ~/.claude itself and has no mode to change.`);
  const from = info.mode ?? 'own';
  if (from === to) throw new ClaudeCodeSwitcherError('MODE_UNCHANGED', `"${name}" is already ${to}.`);
  throw new ModeChangeRefusedError(name, from, to);
}

export interface DeleteResult {
  snapshotDir?: string;
  removedMappings: string[];
}

/**
 * Snapshot login files (.claude.json + .credentials.json if present) into
 * `_backups/<name>-<ts>/`, then remove the profile directory. For a `shared`
 * profile the symlinks go with the directory; the shared store is untouched.
 * A real directory found where a link belongs (drift) is NOT removed: the
 * delete refuses so no shared-looking data is destroyed.
 */
export async function deleteProfile(p: Paths, name: string, opts: { snapshot?: boolean } = {}): Promise<DeleteResult> {
  const info = await getProfile(p, name);
  if (!info) throw new ClaudeCodeSwitcherError('NOT_FOUND', `Profile "${name}" does not exist.`);
  if (info.isDefault) throw new ClaudeCodeSwitcherError('DELETE_DEFAULT', `Refusing to delete "${DEFAULT_PROFILE}" (~/.claude).`);

  const dir = info.dir;
  const result: DeleteResult = { removedMappings: [] };

  if (opts.snapshot !== false) {
    await ensureDir(p.backupsDir, 0o700);
    const snap = path.join(p.backupsDir, `${name}-${timestampSlug()}`);
    await fsp.mkdir(snap, { mode: 0o700 });
    for (const f of [ROOT_JSON, CREDENTIALS_FILE, 'profile.json']) {
      const src = path.join(dir, f);
      const st = await lstatOrNull(src);
      if (st?.isFile()) {
        await fsp.copyFile(src, path.join(snap, f));
        await chmodQuiet(path.join(snap, f), 0o600);
      }
    }
    result.snapshotDir = snap;
  }

  if (info.mode === 'shared') {
    // Drift guard: a real `projects/` (etc.) in a shared profile may hold data
    // that never reached the shared store. Refuse rather than rm -rf it.
    const { SHARED_LINKS } = await import('./storage');
    for (const e of SHARED_LINKS) {
      const st = await lstatOrNull(path.join(dir, e.rel));
      if (st && !st.isSymbolicLink()) {
        throw new ClaudeCodeSwitcherError(
          'DELETE_DRIFT',
          `"${name}" is shared but ${e.rel} is a real ${st.isDirectory() ? 'directory' : 'file'}, not a symlink. ` +
            `It may hold data that never reached ~/.claude. Run relink (moves it aside) and inspect before deleting.`,
        );
      }
    }
  }

  await fsp.rm(dir, { recursive: true, force: true });
  result.removedMappings = await removeMappingsFor(p, name);
  return result;
}

/**
 * Legacy importer: adopt a directory created by the prior-art tool
 * (profile.json without `mode`). Such directories are structurally `own`.
 * This is the single sanctioned exception to "only createProfile writes mode":
 * it only writes `own`, only when `mode` is absent, and only after confirming
 * the directory contains zero symlinks.
 */
export async function importLegacyProfile(p: Paths, name: string): Promise<ProfileMeta> {
  const info = await getProfile(p, name);
  if (!info || info.isDefault) throw new ClaudeCodeSwitcherError('NOT_FOUND', `Profile "${name}" does not exist.`);
  if (info.mode) throw new ClaudeCodeSwitcherError('NOT_LEGACY', `"${name}" already declares mode ${info.mode}.`);
  if (await hasTopLevelSymlinks(info.dir)) {
    throw new ClaudeCodeSwitcherError('LEGACY_HAS_SYMLINKS', `"${name}" has no mode but contains symlinks; refusing to guess. Inspect it by hand.`);
  }
  const meta: ProfileMeta = {
    name,
    mode: 'own',
    createdAt: info.meta?.createdAt ?? new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    importedFrom: info.meta ? `schemaVersion ${String(info.meta.schemaVersion ?? '?')}` : 'no profile.json',
  };
  await writeJsonAtomic(profileMeta(p, name), meta, 0o600);
  return meta;
}

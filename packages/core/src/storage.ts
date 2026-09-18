/**
 * storage.ts — what is INSIDE a profile directory: real files or symlinks.
 *
 * Owns the shared-path manifest and link / verify / relink. Knows nothing
 * about routing (see resolve.ts) and never calls it.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { CREDENTIALS_FILE, Paths, ROOT_JSON, profileClaudeJson, profileDir } from './paths';
import { ClaudeCodeSwitcherError } from './errors';
import { ensureDir, exists, lstatOrNull, moveAside, statOrNull } from './fsx';

export type StorageMode = 'shared' | 'own';

export type EntryKind = 'dir' | 'file';

export interface ManifestEntry {
  /** Relative path inside the profile dir (and inside ~/.claude). */
  rel: string;
  kind: EntryKind;
  why: string;
}

/**
 * In a `shared` profile these are REAL and per-account. Listed so `doctor`
 * can explain the shape; nothing is created for them — Claude Code does.
 */
export const SHARED_REAL: ManifestEntry[] = [
  { rel: ROOT_JSON, kind: 'file', why: 'oauthAccount lives here — the whole point' },
  { rel: CREDENTIALS_FILE, kind: 'file', why: 'login token (macOS: Keychain, keyed off the config dir path)' },
  { rel: 'statsig', kind: 'dir', why: 'usage accounting is per-account' },
  { rel: 'stats-cache.json', kind: 'file', why: 'usage accounting is per-account' },
  { rel: 'usage-data', kind: 'dir', why: 'usage accounting is per-account' },
  { rel: 'remote-settings.json', kind: 'file', why: 'org policy must not leak between accounts' },
  { rel: 'policy-limits.json', kind: 'file', why: 'org policy must not leak between accounts' },
  { rel: 'sessions', kind: 'dir', why: 'live process state; sharing invites corruption' },
  { rel: 'jobs', kind: 'dir', why: 'live process state' },
  { rel: 'daemon', kind: 'dir', why: 'live process state' },
  { rel: 'backups', kind: 'dir', why: 'per-account' },
  { rel: 'debug', kind: 'dir', why: 'per-account' },
  { rel: 'shell-snapshots', kind: 'dir', why: 'per-process' },
  { rel: 'cache', kind: 'dir', why: 'per-account caches' },
  { rel: 'telemetry', kind: 'dir', why: 'per-account' },
];

/**
 * In a `shared` profile these are SYMLINKS back into ~/.claude.
 * Auto-memory is NOT separate: it lives at projects/<project>/memory/, so the
 * single `projects` link carries transcripts and memory together.
 */
export const SHARED_LINKS: ManifestEntry[] = [
  { rel: 'projects', kind: 'dir', why: 'transcripts AND auto-memory (projects/<project>/memory/)' },
  { rel: 'file-history', kind: 'dir', why: 'checkpoints, so rewind works across accounts' },
  { rel: 'paste-cache', kind: 'dir', why: 'transcripts reference these by absolute path' },
  { rel: 'image-cache', kind: 'dir', why: 'transcripts reference these by absolute path' },
  { rel: 'uploads', kind: 'dir', why: 'transcripts reference these by absolute path' },
  { rel: 'plans', kind: 'dir', why: 'plan-mode documents' },
  { rel: 'tasks', kind: 'dir', why: 'task state' },
  { rel: 'session-env', kind: 'dir', why: 'per-session env, referenced from transcripts' },
  { rel: 'agent-memory', kind: 'dir', why: 'agent memory' },
  { rel: 'plugins', kind: 'dir', why: 'installed plugins' },
  { rel: 'skills', kind: 'dir', why: 'user skills' },
  { rel: 'commands', kind: 'dir', why: 'user slash commands' },
  { rel: 'agents', kind: 'dir', why: 'user agents' },
  { rel: 'workflows', kind: 'dir', why: 'user workflows' },
  { rel: 'rules', kind: 'dir', why: 'user rules' },
  { rel: 'output-styles', kind: 'dir', why: 'user output styles' },
  { rel: 'themes', kind: 'dir', why: 'user themes' },
  { rel: 'ide', kind: 'dir', why: 'VS Code <-> CLI lock files; /ide breaks without it' },
  { rel: 'settings.json', kind: 'file', why: 'user settings' },
  { rel: 'CLAUDE.md', kind: 'file', why: 'global instructions' },
  { rel: 'keybindings.json', kind: 'file', why: 'keybindings' },
  { rel: 'history.jsonl', kind: 'file', why: 'prompt history' },
];

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  path?: string;
}

export interface LinkResult {
  linked: string[];
  alreadyOk: string[];
  movedAside: { from: string; to: string }[];
  findings: Finding[];
}

function targetFor(p: Paths, entry: ManifestEntry): string {
  return path.join(p.claudeDir, entry.rel);
}

async function readLinkOrNull(p: string): Promise<string | null> {
  try {
    return await fsp.readlink(p);
  } catch {
    return null;
  }
}

function sameTarget(link: string, linkPath: string, wanted: string): boolean {
  const abs = path.isAbsolute(link) ? link : path.resolve(path.dirname(linkPath), link);
  return path.resolve(abs) === path.resolve(wanted);
}

/**
 * Create every symlink a `shared` profile needs. Idempotent. A real file or
 * directory found where a symlink belongs is MOVED ASIDE with a warning —
 * never deleted. Targets that are directories are created in ~/.claude if
 * missing; file targets are left alone (a dangling link is fine: the first
 * write through it creates the shared file).
 */
export async function linkProfile(p: Paths, name: string): Promise<LinkResult> {
  const dir = profileDir(p, name);
  if (path.resolve(dir) === path.resolve(p.claudeDir)) {
    throw new ClaudeCodeSwitcherError('LINK_DEFAULT', 'Refusing to link the default profile into itself.');
  }
  await ensureDir(dir, 0o700);
  await assertRootJsonNotSymlink(p, name);

  const res: LinkResult = { linked: [], alreadyOk: [], movedAside: [], findings: [] };
  for (const entry of SHARED_LINKS) {
    const linkPath = path.join(dir, entry.rel);
    const target = targetFor(p, entry);

    if (entry.kind === 'dir') {
      const tst = await lstatOrNull(target);
      if (!tst) await ensureDir(target);
    }

    const st = await lstatOrNull(linkPath);
    if (st) {
      if (st.isSymbolicLink()) {
        const cur = await readLinkOrNull(linkPath);
        if (cur && sameTarget(cur, linkPath, target)) {
          res.alreadyOk.push(entry.rel);
          continue;
        }
        // A symlink to the wrong place carries no data; replace it, but say so.
        res.findings.push({
          severity: 'warning',
          code: 'RELINKED',
          message: `${entry.rel} pointed at ${cur ?? '?'}; re-pointed to ${target}.`,
          path: linkPath,
        });
        await fsp.unlink(linkPath);
      } else {
        const to = await moveAside(linkPath);
        res.movedAside.push({ from: linkPath, to });
        res.findings.push({
          severity: 'warning',
          code: 'MOVED_ASIDE',
          message: `A real ${st.isDirectory() ? 'directory' : 'file'} was found at ${entry.rel} where a symlink belongs. ` +
            `It was moved to ${path.basename(to)} (nothing deleted). Anything written there did NOT reach the shared store.`,
          path: to,
        });
      }
    }
    await ensureDir(path.dirname(linkPath));
    await fsp.symlink(target, linkPath, entry.kind === 'dir' ? 'dir' : 'file');
    res.linked.push(entry.rel);
  }
  return res;
}

/**
 * Verify that a profile directory matches its declared mode. Never rewrites
 * metadata, never fixes anything — it only reports.
 */
export async function verifyProfile(p: Paths, name: string, mode: StorageMode): Promise<Finding[]> {
  const dir = profileDir(p, name);
  const out: Finding[] = [];
  if (!(await exists(dir))) {
    return [{ severity: 'error', code: 'MISSING_DIR', message: `Profile directory is missing: ${dir}`, path: dir }];
  }

  // Applies to every mode: the root JSON carries the login identity and must be a real file.
  const rootJson = profileClaudeJson(p, name);
  const rj = await lstatOrNull(rootJson);
  if (rj?.isSymbolicLink()) {
    out.push({ severity: 'error', code: 'ROOT_JSON_SYMLINK', message: `${ROOT_JSON} is a symlink. It must be a real per-profile file.`, path: rootJson });
  }
  const cred = await lstatOrNull(path.join(dir, CREDENTIALS_FILE));
  if (cred?.isSymbolicLink()) {
    out.push({ severity: 'error', code: 'CREDENTIALS_SYMLINK', message: `${CREDENTIALS_FILE} is a symlink. Credentials must never be shared.`, path: path.join(dir, CREDENTIALS_FILE) });
  }
  if (cred && !cred.isSymbolicLink() && process.platform !== 'win32' && (cred.mode & 0o077) !== 0) {
    out.push({ severity: 'warning', code: 'CREDENTIALS_PERMS', message: `${CREDENTIALS_FILE} is not 0600.`, path: path.join(dir, CREDENTIALS_FILE) });
  }

  if (mode === 'shared') {
    for (const entry of SHARED_LINKS) {
      const linkPath = path.join(dir, entry.rel);
      const target = targetFor(p, entry);
      const st = await lstatOrNull(linkPath);
      if (!st) {
        out.push({ severity: 'warning', code: 'LINK_MISSING', message: `${entry.rel} is missing (expected symlink -> ${target}).`, path: linkPath });
      } else if (!st.isSymbolicLink()) {
        out.push({
          severity: 'error',
          code: 'LINK_REPLACED',
          message: `${entry.rel} is a real ${st.isDirectory() ? 'directory' : 'file'} but should be a symlink -> ${target}. ` +
            `Shared state has diverged (a Claude Code upgrade can do this). Run relink to move it aside and restore the link.`,
          path: linkPath,
        });
      } else {
        const cur = await readLinkOrNull(linkPath);
        if (!cur || !sameTarget(cur, linkPath, target)) {
          out.push({ severity: 'error', code: 'LINK_WRONG_TARGET', message: `${entry.rel} -> ${cur ?? '?'} but should point at ${target}.`, path: linkPath });
        }
      }
    }
    for (const entry of SHARED_REAL) {
      const st = await lstatOrNull(path.join(dir, entry.rel));
      if (st?.isSymbolicLink()) {
        out.push({ severity: 'error', code: 'REAL_IS_SYMLINK', message: `${entry.rel} must be real and per-account (${entry.why}) but is a symlink.`, path: path.join(dir, entry.rel) });
      }
    }
  } else {
    // own: zero symlinks at the top level.
    for (const child of await fsp.readdir(dir)) {
      const st = await lstatOrNull(path.join(dir, child));
      if (st?.isSymbolicLink()) {
        out.push({ severity: 'error', code: 'OWN_HAS_SYMLINK', message: `own profile contains a symlink: ${child}. own profiles must not share anything.`, path: path.join(dir, child) });
      }
    }
  }
  return out;
}

/** Re-run linking for a `shared` profile after drift. Same guarantees as linkProfile. */
export async function relinkProfile(p: Paths, name: string): Promise<LinkResult> {
  return linkProfile(p, name);
}

export async function assertRootJsonNotSymlink(p: Paths, name: string): Promise<void> {
  const rootJson = profileClaudeJson(p, name);
  const st = await lstatOrNull(rootJson);
  if (st?.isSymbolicLink()) {
    throw new ClaudeCodeSwitcherError('ROOT_JSON_SYMLINK', `${rootJson} is a symlink; ${ROOT_JSON} must be a real per-profile file.`);
  }
}

/** True when `dir` (already existing) contains at least one top-level symlink. */
export async function hasTopLevelSymlinks(dir: string): Promise<boolean> {
  if (!(await statOrNull(dir))) return false;
  for (const child of await fsp.readdir(dir)) {
    const st = await lstatOrNull(path.join(dir, child));
    if (st?.isSymbolicLink()) return true;
  }
  return false;
}

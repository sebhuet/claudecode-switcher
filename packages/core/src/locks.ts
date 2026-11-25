/**
 * locks.ts — advisory locks: two `shared` profiles on ONE project at once
 * contend over the same session JSONL. Warn, never block. Different projects
 * in parallel is the normal case and stays frictionless.
 */
import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Paths, pathKey, stripTrailingSlash } from './paths';
import { ensureDir, readJson, writeJsonAtomic } from './fsx';

export interface Lock {
  profile: string;
  pid: number;
  projectPath: string;
  since: string;
}

export function lockFileFor(p: Paths, projectPath: string): string {
  const h = crypto.createHash('sha1').update(pathKey(stripTrailingSlash(path.resolve(projectPath)))).digest('hex').slice(0, 16);
  return path.join(p.locksDir, `${h}.json`);
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Every live lock on `projectPath` (stale ones are removed as a side effect). */
export async function readLocks(p: Paths, projectPath: string): Promise<Lock[]> {
  const file = lockFileFor(p, projectPath);
  const data = await readJson<{ locks: Lock[] }>(file);
  if (!data?.locks) return [];
  const live = data.locks.filter((l) => pidAlive(l.pid));
  if (live.length !== data.locks.length) {
    if (live.length) await writeJsonAtomic(file, { locks: live }, 0o600);
    else await fsp.rm(file, { force: true });
  }
  return live;
}

export interface AcquireResult {
  /** Other live holders of a DIFFERENT profile on the same project. */
  contention: Lock[];
}

export async function acquireLock(p: Paths, projectPath: string, profile: string, pid = process.pid): Promise<AcquireResult> {
  await ensureDir(p.locksDir, 0o700);
  const file = lockFileFor(p, projectPath);
  const live = await readLocks(p, projectPath);
  const contention = live.filter((l) => l.profile !== profile && l.pid !== pid);
  const mine: Lock = { profile, pid, projectPath: stripTrailingSlash(path.resolve(projectPath)), since: new Date().toISOString() };
  await writeJsonAtomic(file, { locks: [...live.filter((l) => l.pid !== pid), mine] }, 0o600);
  return { contention };
}

export async function releaseLock(p: Paths, projectPath: string, pid = process.pid): Promise<void> {
  const file = lockFileFor(p, projectPath);
  const live = (await readLocks(p, projectPath)).filter((l) => l.pid !== pid);
  if (live.length) await writeJsonAtomic(file, { locks: live }, 0o600);
  else await fsp.rm(file, { force: true });
}

/** All live locks across all projects (for status views). */
export async function listAllLocks(p: Paths): Promise<Lock[]> {
  let files: string[] = [];
  try {
    files = await fsp.readdir(p.locksDir);
  } catch {
    return [];
  }
  const out: Lock[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const data = await readJson<{ locks: Lock[] }>(path.join(p.locksDir, f));
    for (const l of data?.locks ?? []) if (pidAlive(l.pid)) out.push(l);
  }
  return out;
}

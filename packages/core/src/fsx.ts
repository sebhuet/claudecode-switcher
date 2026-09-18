/** Small fs helpers shared by the core. No token material ever passes through here. */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(p);
  } catch {
    return null;
  }
}

export async function statOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

export async function readJson<T = unknown>(p: string): Promise<T | undefined> {
  try {
    const raw = await fsp.readFile(p, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function readJsonSync<T = unknown>(p: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Write JSON atomically (tmp + rename) with the given mode. */
export async function writeJsonAtomic(p: string, data: unknown, mode = 0o600): Promise<void> {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  await fsp.rename(tmp, p);
  await chmodQuiet(p, mode);
}

export async function writeTextAtomic(p: string, text: string, mode = 0o644): Promise<void> {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, text, { mode });
  await fsp.rename(tmp, p);
  await chmodQuiet(p, mode);
}

export async function chmodQuiet(p: string, mode: number): Promise<void> {
  try {
    await fsp.chmod(p, mode);
  } catch {
    /* best effort (foreign filesystems, Windows) */
  }
}

export async function ensureDir(p: string, mode = 0o755): Promise<void> {
  await fsp.mkdir(p, { recursive: true, mode });
}

export function timestampSlug(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** `<name>.moved-aside-<ts>` beside the original; never overwrites. */
export async function moveAside(p: string): Promise<string> {
  let dest = `${p}.moved-aside-${timestampSlug()}`;
  let i = 0;
  while (await exists(dest)) dest = `${p}.moved-aside-${timestampSlug()}-${++i}`;
  await fsp.rename(p, dest);
  return dest;
}

export function relOrAbs(from: string, to: string): string {
  return path.isAbsolute(to) ? to : path.resolve(from, to);
}

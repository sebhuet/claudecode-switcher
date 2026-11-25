/**
 * map.ts — the folder→profile routing map (`~/.claude-profiles/map.conf`).
 * Format: `/absolute/path/prefix|profile-name`, one per line, `#` comments.
 * Longest matching prefix wins. Compatible with the prior-art map format.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Paths, expandHome, pathKey, stripTrailingSlash } from './paths';
import { ensureDir, writeTextAtomic } from './fsx';

export interface MapEntry {
  prefix: string;
  profile: string;
}

const HEADER = `# Claude Code account routing: which profile NEW sessions use, per folder.
# Format:  /absolute/path/prefix|profile-name     (longest match wins)
# Managed by claudecode-switcher. CLAUDE_CONFIG_DIR, CLAUDE_PROFILE and a .claude-profile
# file in the folder (or a parent) always take precedence over this map.
`;

export function parseMap(text: string, p?: Paths): MapEntry[] {
  const out: MapEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.lastIndexOf('|');
    if (idx <= 0) continue;
    let prefix = line.slice(0, idx).trim();
    const profile = line.slice(idx + 1).trim();
    if (!prefix || !profile) continue;
    if (p) prefix = expandHome(p, prefix);
    out.push({ prefix: stripTrailingSlash(path.normalize(prefix)), profile });
  }
  return out;
}

export function serializeMap(entries: MapEntry[]): string {
  const lines = [...entries]
    .sort((a, b) => a.prefix.localeCompare(b.prefix))
    .map((e) => `${e.prefix}|${e.profile}`);
  return HEADER + lines.join('\n') + (lines.length ? '\n' : '');
}

export async function readMap(p: Paths): Promise<MapEntry[]> {
  try {
    return parseMap(await fsp.readFile(p.mapFile, 'utf8'), p);
  } catch {
    return [];
  }
}

export async function writeMap(p: Paths, entries: MapEntry[]): Promise<void> {
  await ensureDir(p.profilesRoot, 0o700);
  await writeTextAtomic(p.mapFile, serializeMap(entries), 0o644);
}

/** Route `folder` to `profile`. Pass profile `default` to route explicitly to the default account. */
export async function setMapping(p: Paths, folder: string, profile: string): Promise<MapEntry[]> {
  const prefix = stripTrailingSlash(path.resolve(folder));
  const entries = (await readMap(p)).filter((e) => pathKey(e.prefix) !== pathKey(prefix));
  entries.push({ prefix, profile });
  await writeMap(p, entries);
  return entries;
}

export async function removeMapping(p: Paths, folder: string): Promise<boolean> {
  const prefix = stripTrailingSlash(path.resolve(folder));
  const before = await readMap(p);
  const after = before.filter((e) => pathKey(e.prefix) !== pathKey(prefix));
  if (after.length === before.length) return false;
  await writeMap(p, after);
  return true;
}

/** Remove every mapping that points at `profile` (used on delete). */
export async function removeMappingsFor(p: Paths, profile: string): Promise<string[]> {
  const before = await readMap(p);
  const removed = before.filter((e) => e.profile === profile).map((e) => e.prefix);
  if (removed.length) await writeMap(p, before.filter((e) => e.profile !== profile));
  return removed;
}

/** Path-boundary prefix match: `/a/b` matches `/a/b` and `/a/b/c`, never `/a/bc`. */
export function prefixMatches(prefix: string, dir: string): boolean {
  const pfx = pathKey(stripTrailingSlash(prefix));
  const d = pathKey(stripTrailingSlash(dir));
  if (pfx.endsWith(path.sep)) return d.startsWith(pfx); // a root: `/` or `D:\`
  return d === pfx || d.startsWith(pfx + path.sep);
}

export function longestMatch(entries: MapEntry[], dir: string): MapEntry | undefined {
  let best: MapEntry | undefined;
  for (const e of entries) {
    if (!prefixMatches(e.prefix, dir)) continue;
    if (!best || e.prefix.length > best.prefix.length) best = e;
  }
  return best;
}

async function realpathSafe(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Like longestMatch, but tolerant of symlinked paths on either side: `cwd`
 * from process.cwd() is physical, map prefixes and $PWD are logical
 * (macOS: /var vs /private/var). Longest matching prefix (as written) wins.
 */
export async function longestMatchReal(entries: MapEntry[], cwd: string): Promise<MapEntry | undefined> {
  const cwdReal = await realpathSafe(cwd);
  let best: MapEntry | undefined;
  for (const e of entries) {
    let hit = prefixMatches(e.prefix, cwd) || prefixMatches(e.prefix, cwdReal);
    if (!hit) {
      const pr = stripTrailingSlash(await realpathSafe(e.prefix));
      hit = prefixMatches(pr, cwd) || prefixMatches(pr, cwdReal);
    }
    if (hit && (!best || e.prefix.length > best.prefix.length)) best = e;
  }
  return best;
}

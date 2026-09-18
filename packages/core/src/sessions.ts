/**
 * sessions.ts — list a profile's transcripts for a folder. Read-only.
 *
 * Why this exists: with a process wrapper configured, the official VS Code
 * extension builds its history list from ITS OWN environment (~/.claude or the
 * host's CLAUDE_CONFIG_DIR), not from wrapper routing. For `shared` profiles
 * that is the right store anyway; for `own` profiles the panel shows the
 * default account's list. This lets front ends offer the routed profile's list.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Paths, profileDir, projectSlug } from './paths';

export interface SessionInfo {
  id: string;
  file: string;
  modified: Date;
  bytes: number;
  /** Best-effort title: transcript summary or first user message, truncated. Never tool output. */
  title: string;
}

export function projectDirFor(p: Paths, profile: string, folder: string): string {
  return path.join(profileDir(p, profile), 'projects', projectSlug(folder));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function titleOf(file: string): Promise<string> {
  let head = '';
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      head = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
  let firstUser = '';
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (j.type === 'summary' && typeof j.summary === 'string') return truncate(j.summary);
    if (!firstUser && j.type === 'user') {
      const msg = j.message as { content?: unknown } | undefined;
      const c = msg?.content;
      if (typeof c === 'string') firstUser = c;
      else if (Array.isArray(c)) {
        const t = c.find((x) => x && typeof x === 'object' && (x as { type?: string }).type === 'text') as { text?: string } | undefined;
        if (t?.text) firstUser = t.text;
      }
    }
  }
  return truncate(firstUser);
}

function truncate(s: string, n = 90): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/** Sessions of `profile` for `folder`, newest first. */
export async function listSessions(p: Paths, profile: string, folder: string): Promise<SessionInfo[]> {
  const dir = projectDirFor(p, profile, folder);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const id = n.slice(0, -'.jsonl'.length);
    if (!UUID_RE.test(id)) continue;
    const file = path.join(dir, n);
    const st = await fsp.stat(file);
    out.push({ id, file, modified: st.mtime, bytes: st.size, title: await titleOf(file) });
  }
  return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

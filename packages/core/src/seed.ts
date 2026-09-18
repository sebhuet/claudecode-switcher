/**
 * seed.ts — copy trust + onboarding state into a new profile. NEVER credentials.
 *
 * Without this every new profile re-runs the trust dialogs for every folder.
 * The allow-list below is the entire set of keys that cross over; `oauthAccount`
 * and anything token-like are structurally excluded because they are not listed.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Paths, profileClaudeJson, profileDir } from './paths';
import { exists, readJson, writeJsonAtomic } from './fsx';

/** Top-level keys of `.claude.json` that are safe, non-identity preferences. */
export const SEED_TOP_LEVEL_KEYS = [
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'theme',
  'preferredNotifChannel',
  'autoUpdaterStatus',
  'autoUpdates',
  'installMethod',
  'editorMode',
  'verbose',
  'showSpinnerTree',
] as const;

/** Per-project keys that are trust decisions, not usage or identity. */
export const SEED_PROJECT_KEYS = [
  'hasTrustDialogAccepted',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
] as const;

/** settings.json keys that may carry secrets or machine-specific helpers; never copied. */
export const SETTINGS_STRIP_KEYS = ['env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper', 'proxyAuthHelper', 'forceLoginMethod', 'forceLoginOrgUUID'];

export interface SeedOptions {
  /** Copy a sanitised settings.json into an `own` profile (default false). */
  copySettings?: boolean;
  /** Copy ~/.claude/CLAUDE.md into an `own` profile (default false). */
  copyClaudeMd?: boolean;
}

export interface SeedResult {
  seededKeys: string[];
  trustedProjects: number;
  copiedSettings: boolean;
  copiedClaudeMd: boolean;
}

type Json = Record<string, unknown>;

export function buildSeedFromRootJson(src: Json | undefined): Json {
  const seed: Json = {};
  if (!src) return seed;
  for (const k of SEED_TOP_LEVEL_KEYS) {
    if (k in src) seed[k] = src[k];
  }
  const projects = src.projects;
  if (projects && typeof projects === 'object') {
    const out: Json = {};
    for (const [proj, v] of Object.entries(projects as Json)) {
      if (!v || typeof v !== 'object') continue;
      const pv = v as Json;
      if (!pv.hasTrustDialogAccepted) continue;
      const keep: Json = {};
      for (const k of SEED_PROJECT_KEYS) if (k in pv) keep[k] = pv[k];
      out[proj] = keep;
    }
    if (Object.keys(out).length) seed.projects = out;
  }
  return seed;
}

export function sanitizeSettings(src: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(src)) {
    if (SETTINGS_STRIP_KEYS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Seed `<profile>/.claude.json` from the default profile's `~/.claude.json`.
 * Refuses to overwrite an existing root JSON (that would destroy a login).
 */
export async function seedProfile(p: Paths, name: string, opts: SeedOptions = {}): Promise<SeedResult> {
  const dest = profileClaudeJson(p, name);
  const result: SeedResult = { seededKeys: [], trustedProjects: 0, copiedSettings: false, copiedClaudeMd: false };
  if (await exists(dest)) return result;

  const src = await readJson<Json>(p.defaultClaudeJson);
  const seed = buildSeedFromRootJson(src);
  result.seededKeys = Object.keys(seed).filter((k) => k !== 'projects');
  result.trustedProjects = seed.projects ? Object.keys(seed.projects as Json).length : 0;
  await writeJsonAtomic(dest, seed, 0o600);

  const dir = profileDir(p, name);
  if (opts.copySettings) {
    const s = await readJson<Json>(path.join(p.claudeDir, 'settings.json'));
    const target = path.join(dir, 'settings.json');
    if (s && !(await exists(target))) {
      await writeJsonAtomic(target, sanitizeSettings(s), 0o644);
      result.copiedSettings = true;
    }
  }
  if (opts.copyClaudeMd) {
    const from = path.join(p.claudeDir, 'CLAUDE.md');
    const target = path.join(dir, 'CLAUDE.md');
    if ((await exists(from)) && !(await exists(target))) {
      await fsp.copyFile(from, target);
      result.copiedClaudeMd = true;
    }
  }
  return result;
}

/**
 * Copy user-scope MCP servers (`mcpServers` in .claude.json) from one profile
 * to another. The known cost of `shared` mode: .claude.json stays per-profile,
 * so MCP servers do not follow you. Overwrites same-named servers, keeps others.
 * Server configs can contain secrets in `env`; this copies them verbatim, so the
 * caller should say so before invoking.
 */
export async function copyMcpServers(p: Paths, from: string, to: string): Promise<{ copied: string[] }> {
  const src = await readJson<Json>(profileClaudeJson(p, from));
  const servers = (src?.mcpServers ?? {}) as Json;
  const names = Object.keys(servers);
  if (!names.length) return { copied: [] };
  const destPath = profileClaudeJson(p, to);
  const dest = (await readJson<Json>(destPath)) ?? {};
  dest.mcpServers = { ...((dest.mcpServers as Json) ?? {}), ...servers };
  await writeJsonAtomic(destPath, dest, 0o600);
  return { copied: names };
}

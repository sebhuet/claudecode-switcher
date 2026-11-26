/**
 * doctor.ts — health checks. Reports; never repairs metadata.
 * Never reads, prints, or logs token values: presence + accountUuid only.
 */
import * as path from 'node:path';
import { CREDENTIALS_FILE, Paths, ROOT_JSON, profileClaudeJson } from './paths';
import { lstatOrNull } from './fsx';
import { listProfiles, ProfileInfo } from './profiles';
import { Finding, verifyProfile } from './storage';
import { readMap } from './map';
import { listAllLocks } from './locks';

export interface ProfileReport {
  profile: ProfileInfo;
  findings: Finding[];
}

export interface DoctorReport {
  profiles: ProfileReport[];
  global: Finding[];
  ok: boolean;
}

export async function doctor(p: Paths): Promise<DoctorReport> {
  const global: Finding[] = [];
  const profiles = await listProfiles(p);
  const reports: ProfileReport[] = [];

  const rootSt = await lstatOrNull(p.profilesRoot);
  if (rootSt && process.platform !== 'win32' && (rootSt.mode & 0o077) !== 0) {
    global.push({ severity: 'warning', code: 'ROOT_PERMS', message: `${p.profilesRoot} is not 0700.`, path: p.profilesRoot });
  }
  if (!(await lstatOrNull(p.defaultClaudeJson))) {
    global.push({ severity: 'info', code: 'NO_DEFAULT_LOGIN', message: `${p.defaultClaudeJson} not found: the default account has never run Claude Code here.` });
  }

  const byUuid = new Map<string, string[]>();
  for (const pr of profiles) {
    const findings: Finding[] = [];
    if (!pr.isDefault) {
      if (pr.legacy) {
        findings.push({ severity: 'warning', code: 'LEGACY_NO_MODE', message: `profile.json has no mode (created by another tool?). Import it to declare it "own".`, path: pr.dir });
      }
      findings.push(...(await verifyProfile(p, pr.name, pr.mode ?? 'own')));
      const rj = await lstatOrNull(profileClaudeJson(p, pr.name));
      if (rj && !rj.isSymbolicLink() && process.platform !== 'win32' && (rj.mode & 0o077) !== 0) {
        findings.push({ severity: 'warning', code: 'ROOT_JSON_PERMS', message: `${ROOT_JSON} is not 0600.`, path: profileClaudeJson(p, pr.name) });
      }
    } else {
      const rj = await lstatOrNull(p.defaultClaudeJson);
      if (rj?.isSymbolicLink()) findings.push({ severity: 'error', code: 'ROOT_JSON_SYMLINK', message: `${p.defaultClaudeJson} is a symlink.`, path: p.defaultClaudeJson });
    }
    const prov = pr.meta?.provider;
    if (prov) {
      findings.push({ severity: 'info', code: 'PROVIDER', message: `Uses ${prov.kind} (${prov.model} at ${prov.baseUrl}); no sign-in.` });
    } else if (!pr.loggedIn) {
      findings.push({ severity: 'info', code: 'NOT_LOGGED_IN', message: `Not logged in (no oauthAccount in ${ROOT_JSON}).` });
    } else if (pr.accountUuid) {
      byUuid.set(pr.accountUuid, [...(byUuid.get(pr.accountUuid) ?? []), pr.name]);
    }
    const credSt = await lstatOrNull(path.join(pr.dir, CREDENTIALS_FILE));
    findings.push({ severity: 'info', code: 'CREDENTIALS', message: credSt ? `${CREDENTIALS_FILE} present.` : `${CREDENTIALS_FILE} absent (macOS keeps it in Keychain; that is normal).` });
    reports.push({ profile: pr, findings });
  }

  for (const [uuid, names] of byUuid) {
    if (names.length > 1) {
      global.push({
        severity: 'error',
        code: 'DUPLICATE_ACCOUNT',
        message: `Profiles ${names.map((n) => `"${n}"`).join(', ')} are logged in as the SAME account (${uuid}). One of them is not the second account you think it is.`,
      });
    }
  }

  const known = new Set(profiles.map((x) => x.name.toLowerCase()));
  for (const e of await readMap(p)) {
    if (!known.has(e.profile.toLowerCase())) {
      global.push({ severity: 'error', code: 'MAP_UNKNOWN_PROFILE', message: `${p.mapFile}: "${e.prefix}" routes to unknown profile "${e.profile}".`, path: p.mapFile });
    }
  }

  const locks = await listAllLocks(p);
  const byProject = new Map<string, Set<string>>();
  for (const l of locks) byProject.set(l.projectPath, new Set([...(byProject.get(l.projectPath) ?? []), l.profile]));
  for (const [proj, names] of byProject) {
    if (names.size > 1) {
      global.push({ severity: 'warning', code: 'CONTENTION', message: `Project ${proj} is open under ${[...names].join(' and ')} at the same time; if both are shared they write the same session store.` });
    }
  }

  const ok = ![...global, ...reports.flatMap((r) => r.findings)].some((f) => f.severity === 'error');
  return { profiles: reports, global, ok };
}

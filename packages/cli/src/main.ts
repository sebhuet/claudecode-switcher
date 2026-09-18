/**
 * claudecode-switcher — CLI front end. Same core, same ~/.claude-profiles as the extension.
 * The only file in the repo allowed to call process.exit.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as core from '../../core/src';

const VERSION = '0.1.0';

const HELP = `claudecode-switcher ${VERSION} — ClaudeCode Switcher CLI (development build, not published)

usage: claudecode-switcher <command> [args]

  add <name> [--mode shared|own] [--copy-settings] create a profile (default shared; mode is permanent)
  list                                             profiles, mode, login, routed folders
  use <profile> [folder]                           route folder (default: cwd) → profile; "default" allowed
  unuse [folder]                                   remove the folder's routing entry
  pin <profile>                                    write .claude-profile in cwd (beats the map)
  unpin                                            remove .claude-profile from cwd
  which [--json]                                   what a NEW claude here would use, and why
  run <profile> [-- claude args...]                run claude once under a profile
  login <profile>                                  run \`claude\` under the profile to sign in
  doctor                                           health checks (presence + accountUuid only, never tokens)
  verify [profile]                                 does on-disk shape match declared mode?
  relink <profile>                                 restore a shared profile's symlinks (moves strays aside)
  change-mode <profile> <shared|own>               refused with explanation (delete + re-add instead)
  delete <profile> [--yes]                         login snapshot first, then remove
  copy-mcp <from> <to>                             copy user-scope MCP servers between profiles
  import-legacy [name]                             mark mode-less (prior-art) profiles as own
  shell-init                                       print a shell function; eval "$(claudecode-switcher shell-init)"
  install-wrapper                                  write _bin/claudecode-switcher-wrapper.sh for the VS Code setting
  root                                             print the profiles root

env:  CLAUDECODE_SWITCHER_ROOT overrides ~/.claude-profiles.  Resolution order for every command that routes:
      CLAUDE_CONFIG_DIR (explicit, respected) > CLAUDE_PROFILE > .claude-profile file > map > default
`;

interface Args {
  cmd: string;
  pos: string[];
  flags: Record<string, string | boolean>;
  rest: string[];
}

function parse(argv: string[]): Args {
  const [cmd = 'help', ...tail] = argv;
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a === '--') {
      rest = tail.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (tail[i + 1] && !tail[i + 1].startsWith('--') && ['mode'].includes(k)) flags[k] = tail[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { cmd, pos, flags, rest };
}

/** Prefer the shell's logical $PWD when it names the same directory as cwd() (macOS /var vs /private/var). */
function cwd(): string {
  const pwd = process.env.PWD;
  if (pwd) {
    try {
      if (fs.realpathSync(pwd) === fs.realpathSync(process.cwd())) return pwd;
    } catch {
      /* fall through */
    }
  }
  return process.cwd();
}

function paths(): core.Paths {
  return core.getPaths({ profilesRoot: process.env.CLAUDECODE_SWITCHER_ROOT });
}

function print(s = ''): void {
  process.stdout.write(s + '\n');
}
function warn(s: string): void {
  process.stderr.write(s + '\n');
}

function fmtFinding(f: core.Finding): string {
  return `    [${f.severity}] ${f.code}: ${f.message}${f.path ? `\n        ${f.path}` : ''}`;
}

async function cmdList(p: core.Paths): Promise<void> {
  const profiles = await core.listProfiles(p);
  const map = await core.readMap(p);
  const locks = await core.listAllLocks(p);
  for (const pr of profiles) {
    const routed = map.filter((m) => m.profile.toLowerCase() === pr.name.toLowerCase()).map((m) => m.prefix);
    print(`${pr.name}${pr.isDefault ? '  (~/.claude)' : `  [${pr.mode ?? 'legacy: no mode'}]`}`);
    print(`    login:   ${pr.loggedIn ? `${pr.email ?? '?'}${pr.organizationName ? ` · ${pr.organizationName}` : ''} · ${pr.accountUuid ?? '?'}` : 'not signed in'}`);
    print(`    dir:     ${pr.dir}`);
    if (routed.length) print(`    folders: ${routed.join(', ')}`);
    const held = locks.filter((l) => l.profile === pr.name);
    if (held.length) print(`    live:    ${held.map((l) => `${l.projectPath} (pid ${l.pid})`).join(', ')}`);
  }
  print();
  print('Status is a prediction for NEW sessions; /usage inside a session is ground truth.');
}

function envFor(r: core.Resolution): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (r.configDir) env.CLAUDE_CONFIG_DIR = r.configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function realClaude(): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const c = path.join(dir, 'claude');
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* next */
    }
  }
  return undefined;
}

async function runClaude(p: core.Paths, profile: string, args: string[]): Promise<number> {
  const info = await core.getProfile(p, profile);
  if (!info) throw new core.ClaudeCodeSwitcherError('NOT_FOUND', `Unknown profile "${profile}".`);
  const claude = realClaude();
  if (!claude) throw new core.ClaudeCodeSwitcherError('NO_CLAUDE', 'No `claude` on PATH.');
  const r: core.Resolution = { profile: info.name, configDir: core.configDirEnvFor(p, info.name), mode: info.mode ?? 'unknown', source: 'env-profile' };
  const projectDir = cwd();
  const { contention } = await core.acquireLock(p, projectDir, info.name);
  for (const c of contention) warn(`claudecode-switcher: warning: ${c.projectPath} is already open under "${c.profile}" (pid ${c.pid}).`);
  return new Promise((res) => {
    const child = spawn(claude, args, { stdio: 'inherit', env: envFor(r) });
    child.on('exit', (code) => {
      void core.releaseLock(p, projectDir).finally(() => res(code ?? 0));
    });
  });
}

function shellInit(): string {
  const self = path.resolve(process.argv[1]);
  const node = process.execPath;
  return `# claudecode-switcher shell-init — eval "$(claudecode-switcher shell-init)" in ~/.zshrc or ~/.bashrc
# Wraps \`claude\` so a NEW session picks the profile for the current folder.
# Routing is decided by claudecode-switcher (core/resolve.ts), never here. An explicit
# CLAUDE_CONFIG_DIR is respected untouched.
claude() {
  if [ -z "\${CLAUDE_CONFIG_DIR:-}" ]; then
    local __claudecode_switcher_dir
    __claudecode_switcher_dir="$(CLAUDECODE_SWITCHER_LOCK_PID=$$ ${core.sh(node)} ${core.sh(self)} _resolve --lock)"
    if [ -n "$__claudecode_switcher_dir" ]; then
      CLAUDE_CONFIG_DIR="$__claudecode_switcher_dir" command claude "$@"
      return $?
    fi
  fi
  command claude "$@"
}
`;
}

async function main(argv: string[]): Promise<number> {
  const a = parse(argv);
  const p = paths();
  switch (a.cmd) {
    case 'help':
    case '--help':
    case '-h':
      print(HELP);
      return 0;
    case '--version':
    case 'version':
      print(VERSION);
      return 0;
    case 'root':
      print(p.profilesRoot);
      return 0;

    case 'add': {
      const name = a.pos[0];
      const mode = a.flags.mode ?? 'shared';
      if (!name || (mode !== 'shared' && mode !== 'own')) {
        warn('usage: claudecode-switcher add <name> [--mode shared|own] [--copy-settings]');
        return 2;
      }
      const res = await core.createProfile(p, name, { mode, copySettings: !!a.flags['copy-settings'], copyClaudeMd: !!a.flags['copy-settings'] });
      print(`created ${res.info.name} [${res.info.mode}] at ${res.info.dir}`);
      print(`  seeded ${res.seed.trustedProjects} trusted project(s), keys: ${res.seed.seededKeys.join(', ') || 'none'}`);
      if (res.link) print(`  linked ${res.link.linked.length} path(s) into ${p.claudeDir}`);
      for (const f of res.link?.findings ?? []) print(fmtFinding(f));
      print(`next: claudecode-switcher use ${name} [folder]   then   claudecode-switcher login ${name}`);
      return 0;
    }
    case 'list':
    case 'ls':
      await cmdList(p);
      return 0;

    case 'use': {
      const [profile, folder = cwd()] = a.pos;
      if (!profile) {
        warn('usage: claudecode-switcher use <profile> [folder]');
        return 2;
      }
      if (!(await core.profileExists(p, profile))) throw new core.ClaudeCodeSwitcherError('NOT_FOUND', `Unknown profile "${profile}".`);
      await core.setMapping(p, folder, profile);
      print(`${path.resolve(folder)} → ${profile}`);
      return 0;
    }
    case 'unuse': {
      const folder = a.pos[0] ?? cwd();
      print((await core.removeMapping(p, folder)) ? `removed routing for ${path.resolve(folder)}` : `no routing entry for ${path.resolve(folder)}`);
      return 0;
    }
    case 'pin': {
      const profile = a.pos[0];
      if (!profile) {
        warn('usage: claudecode-switcher pin <profile>');
        return 2;
      }
      if (!(await core.profileExists(p, profile))) throw new core.ClaudeCodeSwitcherError('NOT_FOUND', `Unknown profile "${profile}".`);
      fs.writeFileSync(path.join(cwd(), core.PIN_FILE), profile + '\n');
      print(`wrote ${path.join(cwd(), core.PIN_FILE)} → ${profile}`);
      return 0;
    }
    case 'unpin': {
      const f = path.join(cwd(), core.PIN_FILE);
      if (fs.existsSync(f)) {
        fs.rmSync(f);
        print(`removed ${f}`);
      } else print(`no ${core.PIN_FILE} here`);
      return 0;
    }
    case 'which': {
      const r = await core.resolve({ cwd: cwd(), env: process.env, paths: p });
      if (a.flags.json) print(JSON.stringify(r));
      else {
        print(`${r.profile} [${r.mode}]  via ${r.source}${r.detail ? `: ${r.detail}` : ''}`);
        print(`CLAUDE_CONFIG_DIR=${r.configDir ?? '(unset → ~/.claude)'}`);
      }
      return 0;
    }
    case '_resolve': {
      // internal: used by shell-init. Same bridge as the extension's wrapper.
      const { main: rmain } = await import('../../core/src/resolve-cli');
      return rmain(a.flags.lock ? ['--lock'] : [], process.env, print, warn);
    }
    case 'run': {
      const profile = a.pos[0];
      if (!profile) {
        warn('usage: claudecode-switcher run <profile> [-- claude args]');
        return 2;
      }
      return runClaude(p, profile, [...a.pos.slice(1), ...a.rest]);
    }
    case 'login': {
      const profile = a.pos[0];
      if (!profile) {
        warn('usage: claudecode-switcher login <profile>');
        return 2;
      }
      print(`Starting claude under "${profile}". Type /login if it does not prompt you; confirm with /usage.`);
      return runClaude(p, profile, a.rest);
    }
    case 'doctor': {
      const rep = await core.doctor(p);
      for (const g of rep.global) print(`[${g.severity}] ${g.code}: ${g.message}`);
      for (const r of rep.profiles) {
        print(`${r.profile.name} [${r.profile.isDefault ? '~/.claude' : r.profile.mode ?? 'legacy'}]${r.profile.loggedIn ? `  ${r.profile.email ?? ''}` : '  (not signed in)'}`);
        for (const f of r.findings) print(fmtFinding(f));
      }
      print(rep.ok ? 'OK — no errors.' : 'Errors found.');
      return rep.ok ? 0 : 1;
    }
    case 'verify': {
      const targets = a.pos[0] ? [a.pos[0]] : (await core.listProfiles(p)).filter((x) => !x.isDefault).map((x) => x.name);
      let bad = 0;
      for (const name of targets) {
        const info = await core.getProfile(p, name);
        if (!info || info.isDefault) {
          warn(`unknown profile "${name}"`);
          bad++;
          continue;
        }
        const f = await core.verifyProfile(p, name, info.mode ?? 'own');
        const problems = f.filter((x) => x.severity !== 'info');
        print(`${name} [${info.mode ?? 'legacy'}]: ${problems.length ? `${problems.length} problem(s)` : 'ok'}`);
        for (const x of problems) print(fmtFinding(x));
        if (problems.some((x) => x.severity === 'error')) bad++;
      }
      return bad ? 1 : 0;
    }
    case 'relink': {
      const name = a.pos[0];
      const info = name ? await core.getProfile(p, name) : undefined;
      if (!info || info.isDefault) {
        warn('usage: claudecode-switcher relink <shared profile>');
        return 2;
      }
      if (info.mode !== 'shared') throw new core.ClaudeCodeSwitcherError('NOT_SHARED', `"${name}" is ${info.mode ?? 'legacy'}; only shared profiles have links.`);
      const r = await core.relinkProfile(p, info.name);
      print(`linked ${r.linked.length}, already ok ${r.alreadyOk.length}, moved aside ${r.movedAside.length}`);
      for (const f of r.findings) print(fmtFinding(f));
      return 0;
    }
    case 'change-mode': {
      const [name, to] = a.pos;
      if (!name || (to !== 'shared' && to !== 'own')) {
        warn('usage: claudecode-switcher change-mode <profile> <shared|own>');
        return 2;
      }
      await core.changeMode(p, name, to); // always throws
      return 1;
    }
    case 'delete':
    case 'rm': {
      const name = a.pos[0];
      if (!name) {
        warn('usage: claudecode-switcher delete <profile> [--yes]');
        return 2;
      }
      const info = await core.getProfile(p, name);
      if (!info) throw new core.ClaudeCodeSwitcherError('NOT_FOUND', `Unknown profile "${name}".`);
      if (!a.flags.yes) {
        warn(`This deletes ${info.dir} (${info.mode ?? 'legacy'}). ${info.mode === 'shared' ? 'Only its links and login go; ~/.claude is untouched.' : 'ALL of its sessions, memory and settings go with it.'}`);
        warn('A login snapshot is written to _backups/ first. Re-run with --yes to proceed.');
        return 2;
      }
      const r = await core.deleteProfile(p, name);
      print(`deleted ${name}; snapshot: ${r.snapshotDir}; unrouted: ${r.removedMappings.join(', ') || 'none'}`);
      return 0;
    }
    case 'copy-mcp': {
      const [from, to] = a.pos;
      if (!from || !to) {
        warn('usage: claudecode-switcher copy-mcp <from> <to>');
        return 2;
      }
      const r = await core.copyMcpServers(p, from, to);
      print(r.copied.length ? `copied ${r.copied.join(', ')} → ${to}` : `"${from}" has no user-scope MCP servers`);
      return 0;
    }
    case 'import-legacy': {
      const targets = a.pos[0] ? [a.pos[0]] : (await core.listProfiles(p)).filter((x) => x.legacy).map((x) => x.name);
      if (!targets.length) print('no legacy profiles');
      for (const n of targets) {
        const m = await core.importLegacyProfile(p, n);
        print(`${n}: marked ${m.mode}`);
      }
      return 0;
    }
    case 'shell-init':
      print(shellInit());
      return 0;
    case 'install-wrapper': {
      // The wrapper needs a `node` entry that prints the resolved CLAUDE_CONFIG_DIR.
      // Reuse this very bundle: a two-line shim that invokes `claudecode-switcher _resolve`.
      const shim = `#!/usr/bin/env node\nprocess.argv.splice(2, 0, '_resolve');\nrequire(${JSON.stringify(path.resolve(process.argv[1]))});\n`;
      const res = await core.materializeHelpers(p, { version: VERSION, nodePath: process.execPath, claudePath: realClaude(), resolveScriptSource: shim });
      print(`wrote ${res.wrapperPath}`);
      print(`set VS Code user setting  "claudeCode.claudeProcessWrapper": "${res.wrapperPath}"  (the extension does this for you)`);
      return 0;
    }
    default:
      warn(`unknown command "${a.cmd}"\n`);
      print(HELP);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    const err = e as core.ClaudeCodeSwitcherError;
    process.stderr.write(`claudecode-switcher: ${err.message}\n`);
    if (err instanceof core.UnknownProfileError) process.exit(3);
    process.exit(err.code === 'MODE_CHANGE_REFUSED' ? 4 : 1);
  },
);

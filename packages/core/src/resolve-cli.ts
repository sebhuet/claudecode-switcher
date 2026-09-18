/**
 * resolve-cli.ts — the tiny `node` entry the generated wrapper and shell helper
 * call. It is the ONLY bridge from shell to `resolve()`; it never re-implements
 * routing. Bundled to `_bin/claudecode-switcher-resolve.cjs`.
 *
 * Usage:  node claudecode-switcher-resolve.cjs [--cwd DIR] [--lock] [--json]
 * stdout: the CLAUDE_CONFIG_DIR to export (empty line = leave unset),
 *         or a JSON Resolution with --json.
 * exit:   0 resolved · 3 unknown profile (stderr says which; caller falls back
 *         loudly to default) · 1 unexpected error.
 * Never prints token values. `--lock` records an advisory lock for $PWD.
 */
import { getPaths } from './paths';
import { resolve } from './resolve';
import { acquireLock } from './locks';
import { UnknownProfileError } from './errors';

export async function main(argv: string[], env: NodeJS.ProcessEnv, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  let cwd = env.PWD || process.cwd();
  let lock = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') cwd = argv[++i] ?? cwd;
    else if (a === '--lock') lock = true;
    else if (a === '--json') json = true;
  }
  const p = getPaths({ home: env.HOME, profilesRoot: env.CLAUDECODE_SWITCHER_ROOT });
  try {
    const r = await resolve({ cwd, env, paths: p });
    if (lock && r.profile !== 'external') {
      try {
        const { contention } = await acquireLock(p, cwd, r.profile, Number(env.CLAUDECODE_SWITCHER_LOCK_PID) || process.ppid);
        for (const c of contention) {
          err(`claudecode-switcher: warning: ${c.projectPath} is already open under profile "${c.profile}" (pid ${c.pid}); ` +
            `you are starting it under "${r.profile}". Two shared profiles on one project write the same session store.`);
        }
      } catch {
        /* locks are advisory */
      }
    }
    out(json ? JSON.stringify(r) : (r.configDir ?? ''));
    return 0;
  } catch (e) {
    if (e instanceof UnknownProfileError) {
      err(`claudecode-switcher: ${e.message} Falling back to the default account.`);
      if (json) out(JSON.stringify({ error: e.code, profile: e.profile, source: e.source }));
      return 3;
    }
    err(`claudecode-switcher: ${(e as Error).message}`);
    return 1;
  }
}

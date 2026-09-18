import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getPaths, Paths } from '../src/paths';

export interface Sandbox {
  home: string;
  p: Paths;
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

/** A throwaway $HOME with a fake ~/.claude. Never touches the real one. */
export async function sandbox(): Promise<Sandbox> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudecode-switcher-test-'));
  const realHome = await fsp.realpath(home);
  const p = getPaths({ home: realHome });
  await fsp.mkdir(p.claudeDir, { recursive: true });
  await fsp.mkdir(path.join(p.claudeDir, 'projects', '-repo-x', 'memory'), { recursive: true });
  await fsp.writeFile(path.join(p.claudeDir, 'projects', '-repo-x', 'memory', 'MEMORY.md'), '# mem\n');
  await fsp.writeFile(path.join(p.claudeDir, 'settings.json'), JSON.stringify({ theme: 'dark', env: { SECRET: 'x' }, apiKeyHelper: 'echo' }));
  await fsp.writeFile(path.join(p.claudeDir, 'CLAUDE.md'), '# global\n');
  await fsp.writeFile(
    p.defaultClaudeJson,
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: 'dark',
      oauthAccount: { accountUuid: 'uuid-default', emailAddress: 'default@example.com', accessTokenLikeThing: 'NOPE' },
      mcpServers: { srv: { command: 'x' } },
      projects: {
        '/repo/x': { hasTrustDialogAccepted: true, allowedTools: ['Bash'], lastCost: 1 },
        '/repo/y': { hasTrustDialogAccepted: false, allowedTools: [] },
      },
    }),
  );
  const env: NodeJS.ProcessEnv = { HOME: realHome, PATH: process.env.PATH };
  return {
    home: realHome,
    p,
    env,
    cleanup: async () => {
      await fsp.rm(home, { recursive: true, force: true });
    },
  };
}

export async function mkdirp(...parts: string[]): Promise<string> {
  const p = path.join(...parts);
  await fsp.mkdir(p, { recursive: true });
  return p;
}

export async function write(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
}

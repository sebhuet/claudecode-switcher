import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
await esbuild.build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/claudecode-switcher.cjs',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
fs.chmodSync('dist/claudecode-switcher.cjs', 0o755);

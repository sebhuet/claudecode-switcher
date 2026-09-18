import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, platform: 'node', target: 'node18', format: 'cjs', sourcemap: true, logLevel: 'info' };

const ctxs = await Promise.all([
  esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] }),
  // The bridge the generated wrapper calls via `node`. Self-contained: no node_modules at runtime.
  esbuild.context({ ...common, entryPoints: ['../core/src/resolve-cli-bin.ts'], outfile: 'dist/claudecode-switcher-resolve.cjs', sourcemap: false, minify: false }),
]);
if (watch) {
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(ctxs.map((c) => c.rebuild()));
  await Promise.all(ctxs.map((c) => c.dispose()));
}

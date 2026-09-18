/** Executable entry for resolve-cli: bundled to `_bin/claudecode-switcher-resolve.cjs`. */
import { main } from './resolve-cli';

main(process.argv.slice(2), process.env, (s) => process.stdout.write(s + '\n'), (s) => process.stderr.write(s + '\n')).then(
  (code) => { process.exitCode = code; },
  (e) => { process.stderr.write(`claudecode-switcher: ${String(e)}\n`); process.exitCode = 1; },
);

// Windows end-to-end test of the compiled wrapper, in a throwaway $HOME. Never touches
// your real ~/.claude. Run after `npm run build`:  node scripts/e2e-win.cjs
// Covers: routing via the map (stale PWD, lowercase drive), verbatim argv, an Ollama profile's env, kill-on-close,
// recompiling while the exe is locked, and a shared profile (needs Developer Mode).
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'win32') {
  console.log('e2e-win: skipped (not Windows)');
  process.exit(0);
}
const repo = path.resolve(__dirname, '..');
const core = require(path.join(repo, 'packages/core/dist/src/index.js'));
const sb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudecode-switcher-e2e-win-')));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const pass = (what) => console.log(`ok - ${what}`);

(async () => {
  const home = path.join(sb, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  const p = core.getPaths({ home });
  await core.createProfile(p, 'Work', { mode: 'own' });
  const proj = path.join(sb, 'Proj Dir');
  fs.mkdirSync(proj);
  await core.setMapping(p, proj, 'Work');
  const res = await core.materializeHelpers(p, {
    version: 'e2e',
    nodePath: process.execPath,
    resolveScriptSource: fs.readFileSync(path.join(repo, 'packages/vscode/dist/claudecode-switcher-resolve.cjs'), 'utf8'),
  });
  assert.ok(fs.existsSync(res.wrapperPath));
  pass('wrapper compiled');

  // Same shape as the Agent SDK: spawn(wrapper, [binary, ...args]), no shell.
  const probe = path.join(sb, 'probe.cjs');
  fs.writeFileSync(probe, 'console.log(JSON.stringify({dir:process.env.CLAUDE_CONFIG_DIR??null,args:process.argv.slice(2)}))');
  const env = { ...process.env, PWD: 'C:\\stale' };
  for (const k of Object.keys(env)) if (/^(CLAUDE_CONFIG_DIR|ANTHROPIC_|CLAUDE_CODE_SUBAGENT_MODEL)/.test(k)) delete env[k];
  const args = ['--settings', '{"a":"b c","q":"\\"x\\""}', 'with space', 'trailing\\'];
  const lowerDrive = proj[0].toLowerCase() + proj.slice(1);
  const r = cp.spawnSync(res.wrapperPath, [process.execPath, probe, ...args], { cwd: lowerDrive, env, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dir, path.join(p.profilesRoot, 'Work'));
  pass('routed by the map (stale PWD, lowercase drive)');
  assert.deepEqual(out.args, args);
  pass('argv passed through verbatim');

  await core.createProfile(p, 'Local', { mode: 'own', provider: { kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b' } });
  const lproj = path.join(sb, 'Local Proj');
  fs.mkdirSync(lproj);
  await core.setMapping(p, lproj, 'Local');
  const settings = path.join(p.profilesRoot, 'Local', core.PROVIDER_SETTINGS);
  const lr = cp.spawnSync(res.wrapperPath, [process.execPath, probe, 'x y'], { cwd: lproj, env, encoding: 'utf8', windowsHide: true });
  assert.deepEqual(JSON.parse(lr.stdout).args, ['x y', '--settings', settings]);
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'qwen3:8b');
  pass('Ollama profile: --settings appended after the verbatim args');

  const c = cp.spawn(res.wrapperPath, [process.execPath, '-e', 'console.log(process.pid);setInterval(()=>{},1000)'], { cwd: proj, env, windowsHide: true });
  const childPid = await new Promise((ok) => c.stdout.once('data', (d) => ok(Number(String(d).trim()))));
  c.kill();
  await sleep(800);
  assert.throws(() => process.kill(childPid, 0));
  pass('child dies with the wrapper');

  const hold = cp.spawn(res.wrapperPath, [process.execPath, '-e', 'setTimeout(()=>{},3000)'], { cwd: proj, env, windowsHide: true });
  await sleep(500);
  const res2 = await core.materializeHelpers(p, { version: 'e2e-2', nodePath: process.execPath, resolveScriptSource: 'x' });
  assert.ok(res2.changed && fs.existsSync(res2.wrapperPath));
  hold.kill();
  pass('recompiled while the exe was running');

  try {
    await core.createProfile(p, 'Shared', { mode: 'shared' });
  } catch (e) {
    assert.equal(e.code, 'SYMLINK_PRIVILEGE');
    assert.ok(!fs.existsSync(path.join(p.profilesRoot, 'Shared')));
    console.log('skip - shared profile: Developer Mode is off (refused cleanly, nothing left behind)');
    return;
  }
  assert.deepEqual(await core.verifyProfile(p, 'Shared', 'shared'), []);
  fs.writeFileSync(path.join(p.profilesRoot, 'Shared', 'projects', 'mem.md'), 'x');
  assert.ok(fs.existsSync(path.join(home, '.claude', 'projects', 'mem.md')));
  await core.deleteProfile(p, 'Shared', { snapshot: false });
  assert.ok(fs.existsSync(path.join(home, '.claude', 'projects', 'mem.md')));
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')));
  pass('shared profile: links verify, write through, delete keeps ~/.claude');
})()
  .catch((e) => {
    console.error('not ok -', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sleep(500); // let killed wrappers release their exe
    fs.rmSync(sb, { recursive: true, force: true, maxRetries: 5 });
  });

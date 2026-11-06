// Persistent-mode smoke test of the real Electron app, in two launches.
// Uses only a temporary test folder and a temporary data folder, deleted at the end.
//   launch 1: register the test folder, complete one attempt, start a second and quit while it is reviewing;
//   launch 2: start-up recovery runs; check what survived on disk and in SQLite.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const electron = path.resolve('node_modules/.bin/electron');
const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'helo-smoke-persist-')));
const folder = path.join(base, 'fictional-test-clone');
const data = path.join(base, 'app-data');
mkdirSync(folder);
mkdirSync(data);
writeFileSync(path.join(folder, 'RULES.md'), '# RULES.md (fictional smoke-test folder)\n\nBusiness in this repository: Example Business A (fictional)\n');

function launch(phase) {
  const out = execFileSync(electron, ['.', '--smoke-persist'], {
    env: { ...process.env, HELO_DATA_DIR: data, HELO_TEST_FOLDER: folder, HELO_SMOKE_PHASE: phase },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const line = out.split('\n').find((l) => l.startsWith('SMOKE-PERSIST '));
  if (!line) throw new Error(`no SMOKE-PERSIST line from phase ${phase}:\n${out}`);
  console.log(line);
  return JSON.parse(line.slice('SMOKE-PERSIST '.length));
}

const failures = [];
const check = (ok, what) => (ok ? console.log(`  ok: ${what}`) : failures.push(what));
try {
  const run = launch('run');
  check(run.stateA === 'complete', 'launch 1: attempt A completed');
  check(run.filesA.length === 9, 'launch 1: attempt A has nine record files');
  check(run.stateB === 'reviewing', 'launch 1: quit while attempt B was reviewing');
  const verify = launch('verify');
  const a = verify.attempts.find((x) => x.id === run.attemptA);
  const b = verify.attempts.find((x) => x.id === run.attemptB);
  check(verify.projects === 1 && verify.tasks === 2, 'launch 2: project and both tasks survived the relaunch');
  check(a && a.state === 'complete' && a.final && a.record === 'intact', 'launch 2: attempt A still complete, record intact');
  check(b && b.state === 'interrupted' && b.final && b.record === 'intact', 'launch 2: attempt B interrupted by start-up recovery, record intact');
  check(b && b.unresolved.join() === 'review', 'launch 2: attempt B review stage marked not confirmed stopped');
  check(verify.page.banner && verify.page.persistentNote && verify.page.projectRows === 1, 'launch 2: window shows the banner, persistent mode and the project');
  const files = readdirSync(path.join(data));
  check(files.some((f) => f.endsWith('.sqlite')), 'SQLite store is in the data folder');
  const records = readdirSync(path.join(folder));
  check(records.sort().join() === 'RULES.md,app-records', 'test folder holds only RULES.md and app-records/');
  check(readFileSync(path.join(folder, 'RULES.md'), 'utf8').includes('Example Business A (fictional)'), 'RULES.md unchanged');
} finally {
  rmSync(base, { recursive: true, force: true });
}
if (failures.length) {
  console.log('SMOKE-PERSIST FAILED: ' + failures.join('; '));
  process.exit(1);
}
console.log('SMOKE-PERSIST PASSED');

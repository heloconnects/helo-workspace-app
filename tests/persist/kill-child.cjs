// Child process for the process-kill tests. Runs the real compiled engine (dist/)
// on a real test folder and SQLite file, and kills itself with SIGKILL the
// moment the armed boundary is reached: no clean-up, no exception handling,
// no closing of the database.
// Arguments: dataDir folder point drafter scenario [mode]
//   mode "run" (default): start an attempt; "outside": save an outside review;
//   "recover": open the existing store and run start-up recovery.
//   point "list" prints every boundary the chosen mode passes, without killing.
const path = require('node:path');
const os = require('node:os');
const { openPersistentWorkspace, addTestFolder } = require('../../dist/persist/index.js');
const { CrashHooks } = require('../../dist/core/sim-store.js');

const [dataDir, folder, point, drafter, scenarioName, mode = 'run'] = process.argv.slice(2);
const hooks = new CrashHooks();
hooks.onFire = () => process.kill(process.pid, 'SIGKILL');
const timing = { responseMs: 1, lateResultMs: 25, stageTimeoutMs: 2000, attemptLimitMs: 10000, cancelGraceMs: 15 };
const { ws } = openPersistentWorkspace({ dataDir, timing, fullSync: false, hooks });
const listing = point === 'list';
const done = (mark) => {
  process.stdout.write(listing ? JSON.stringify([...new Set(hooks.seen.slice(mark))]) : 'NOT-KILLED');
  process.exit(0);
};

if (mode === 'recover') {
  const mark = hooks.seen.length;
  if (!listing) hooks.arm(point);
  ws.recover();
  done(mark);
} else {
  let project = ws.t.projects[0];
  if (!project) {
    const id = addTestFolder(ws, folder, { appRoot: path.resolve(__dirname, '../..'), home: os.homedir() }, false);
    project = ws.registerProject({ folderId: id, business: 'fictional-a', name: 'Kill test', repoConfirmed: true });
  }
  const scenario = scenarioName === 'review-fails' ? { draft: 'ok', review: 'fail', synthesis: 'ok' } : { draft: 'ok', review: 'ok', synthesis: 'ok' };
  const task = ws.createTask({ projectId: project.id, title: 'Kill test task', brief: 'Example brief.', acceptanceCriteria: ['Example criterion'], sourceIds: [], drafter, scenarioId: 'success-issues', scenario });
  const mark = hooks.seen.length;
  if (!listing) hooks.arm(point);
  if (mode === 'outside') {
    ws.saveOutsideReview({ taskId: task.id, source: 'chatgpt', text: 'Made-up outside review for a kill test.' });
    done(mark);
  } else {
    const a = ws.startAttempt({ taskId: task.id, approvedPacketHash: task.packetHash, idempotencyKey: 'k', acknowledgePriorStopped: false });
    ws.settled(a.id).then(() => done(mark));
  }
}

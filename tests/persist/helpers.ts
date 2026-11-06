// Real temporary folders for persistence tests. Each test creates its own and
// deletes it afterwards. Nothing outside the system temporary folder is touched.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineTiming } from '../../src/core/engine.js';
import { CrashHooks } from '../../src/core/sim-store.js';
import { addTestFolder, openPersistentWorkspace } from '../../src/persist/index.js';

export const FAST: EngineTiming = { responseMs: 1, lateResultMs: 25, stageTimeoutMs: 60, attemptLimitMs: 5000, cancelGraceMs: 15 };

const created: string[] = [];

export function tempDir(label: string): string {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), `helo-test-${label}-`)));
  created.push(d);
  return d;
}

export function cleanupTemp(): void {
  while (created.length) {
    const d = created.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
}

export const RULES_A = '# RULES.md (fictional test folder)\n\nBusiness in this repository: Example Business A (fictional)\n';

/** A fictional test folder shaped like a clone. */
export function makeTestFolder(rules = RULES_A): string {
  const root = tempDir('clone');
  writeFileSync(path.join(root, 'RULES.md'), rules);
  mkdirSync(path.join(root, 'notes'));
  writeFileSync(path.join(root, 'notes', 'untouched.md'), 'A made-up file the app must never change.\n');
  return root;
}

export const GUARDS = { appRoot: path.resolve(__dirname, '../..'), home: os.homedir() };

/** Open (or reopen) a persistent workspace on a data folder, with one registered test folder. */
export function openWs(dataDir: string, folder: string, hooks = new CrashHooks(), timing = FAST) {
  const { ws, db } = openPersistentWorkspace({ dataDir, timing, fullSync: false, hooks });
  let project = ws.t.projects[0];
  if (!project) {
    const folderId = addTestFolder(ws, folder, GUARDS, false);
    project = ws.registerProject({ folderId, business: 'fictional-a', name: 'Test folder project', repoConfirmed: true });
  }
  return { ws, db, project, hooks };
}

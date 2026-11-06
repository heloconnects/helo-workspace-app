// Persistent mode: the same engine, with a SQLite store in the app's data
// folder and records written into real, fictional test folders that Ahmed
// chooses. The adapters stay fake.

import path from 'node:path';
import { Workspace, type EngineTiming } from '../core/engine.js';
import type { CrashHooks } from '../core/sim-store.js';
import { openTestFolder, RealFolder, type TestFolderGuards } from './real-folder.js';
import { SqliteDb } from './sqlite-db.js';

export const STORE_FILE = 'helo-run-state.sqlite';

export interface PersistentOptions {
  /** The app's own data folder (never a project folder). */
  dataDir: string;
  timing: EngineTiming;
  /** Use macOS F_FULLFSYNC for record files and SQLite. On in the app; tests may turn it off for speed. */
  fullSync: boolean;
  hooks?: CrashHooks;
  onCrash?: (point: string) => void;
}

export function openPersistentWorkspace(o: PersistentOptions): { ws: Workspace; db: SqliteDb } {
  let db: SqliteDb | null = null;
  const ws = new Workspace({
    timing: o.timing,
    ...(o.hooks ? { hooks: o.hooks } : {}),
    ...(o.onCrash ? { onCrash: o.onCrash } : {}),
    folders: [],
    db: (hooks) => (db = new SqliteDb(path.join(o.dataDir, STORE_FILE), hooks, { fullSync: o.fullSync })),
    realFolder: (root) => new RealFolder(root, { fullSync: o.fullSync }),
  });
  return { ws, db: db! };
}

/** Check a chosen folder and make it available for registration. Returns its folder id. */
export function addTestFolder(ws: Workspace, chosen: string, guards: TestFolderGuards, fullSync: boolean): string {
  return ws.addFolder(openTestFolder(chosen, guards, { fullSync })).id;
}

export { RealFolder, openTestFolder, SqliteDb };

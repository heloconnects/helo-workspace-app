// The run-state store, on disk, using Node's built-in node:sqlite (no extra
// package). It lives in the app's own data folder, never in a project folder.
//
// The engine works on the same Tables shape as in the simulation. Each
// transaction is run on a copy, the changed rows are written in one SQLite
// transaction (BEGIN IMMEDIATE ... COMMIT), and only after the commit
// succeeds does the in-memory copy move forward. A crash at any point leaves
// all of it or none of it.

import { DatabaseSync } from 'node:sqlite';
import { emptyTables, type Tables } from '../core/schema.js';
import type { CrashHooks, DbLike } from '../core/sim-store.js';

/**
 * 1: persistence v1 as first built (dbb2fa4).
 * 2: real projects carry folderIdentity (null when recorded by version 1, to be confirmed by Ahmed).
 */
export const SCHEMA_VERSION = 2;

type TableName = keyof Tables;

/** SQL table per engine table (names follow the plan's data model where one exists), with each row's key. */
const TABLES: { name: TableName; sql: string; key: (row: never, ordinal: number) => string; owner: (row: never) => string | null }[] = [
  { name: 'projects', sql: 'projects', key: (r: { id: string }) => r.id, owner: (r: { id: string }) => r.id },
  { name: 'tasks', sql: 'tasks', key: (r: { id: string }) => r.id, owner: (r: { projectId: string }) => r.projectId },
  { name: 'attempts', sql: 'attempts', key: (r: { id: string }) => r.id, owner: (r: { projectId: string }) => r.projectId },
  {
    name: 'recordFiles',
    sql: 'record_files',
    key: (r: { attemptId: string; name: string }) => `${r.attemptId}|${r.name}`,
    owner: (r: { attemptId: string }) => r.attemptId,
  },
  {
    name: 'dispatch',
    sql: 'dispatch_journal',
    key: (r: { attemptId: string; stage: string }) => `${r.attemptId}|${r.stage}`,
    owner: (r: { attemptId: string }) => r.attemptId,
  },
  {
    name: 'artifacts',
    sql: 'artifacts',
    key: (r: { attemptId: string; stage: string }) => `${r.attemptId}|${r.stage}`,
    owner: (r: { attemptId: string }) => r.attemptId,
  },
  {
    name: 'rejections',
    sql: 'rejections',
    key: (r: { attemptId: string; stage: string }) => `${r.attemptId}|${r.stage}`,
    owner: (r: { attemptId: string }) => r.attemptId,
  },
  {
    name: 'lateResults',
    sql: 'late_results',
    key: (r: { attemptId: string; stage: string }, ordinal: number) => `${r.attemptId}|${r.stage}|${ordinal}`,
    owner: (r: { attemptId: string }) => r.attemptId,
  },
  { name: 'outsideSaves', sql: 'outside_saves', key: (r: { saveId: string }) => r.saveId, owner: (r: { taskId: string }) => r.taskId },
] as never;

export interface SqliteOptions {
  /** PRAGMA fullfsync (macOS: flush the drive's cache too). Tests may turn it off for speed; synchronous=FULL stays on. */
  fullSync: boolean;
}

export class SqliteDb implements DbLike<Tables> {
  private db: DatabaseSync;
  private cache: Tables;

  constructor(
    readonly file: string,
    private readonly hooks: CrashHooks,
    options: SqliteOptions,
  ) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(`PRAGMA fullfsync = ${options.fullSync ? 'ON' : 'OFF'}`);
    this.migrate();
    this.cache = this.load();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
    const current = row.v ?? 0;
    if (current > SCHEMA_VERSION) throw new Error(`The store was written by a newer version of the app (schema ${current}).`);
    if (current === SCHEMA_VERSION) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (current === 0) {
        for (const t of TABLES) {
          this.db.exec(`CREATE TABLE IF NOT EXISTS ${t.sql} (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, owner TEXT, data TEXT NOT NULL)`);
          this.db.exec(`CREATE INDEX IF NOT EXISTS ${t.sql}_owner ON ${t.sql} (owner)`);
        }
      }
      if (current === 1) {
        // Version 1 stored no folder identity. Mark it explicitly as not yet confirmed; history is kept.
        const rows = this.db.prepare('SELECT key, data FROM projects').all() as { key: string; data: string }[];
        for (const r of rows) {
          const p = JSON.parse(r.data) as Record<string, unknown>;
          if (!('folderIdentity' in p)) {
            p.folderIdentity = null;
            this.db.prepare('UPDATE projects SET data = ? WHERE key = ?').run(JSON.stringify(p), r.key);
          }
        }
      }
      this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private load(): Tables {
    const out = emptyTables();
    for (const t of TABLES) {
      const rows = this.db.prepare(`SELECT data FROM ${t.sql} ORDER BY seq`).all() as { data: string }[];
      (out[t.name] as unknown[]) = rows.map((r) => JSON.parse(r.data));
    }
    return out;
  }

  get tables(): Readonly<Tables> {
    return this.cache;
  }

  schemaVersion(): number {
    return (this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
  }

  transact<R>(label: string, fn: (draft: Tables) => R): R {
    this.hooks.point(`txn:${label}:before`);
    const draft = structuredClone(this.cache);
    const result = fn(draft);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const counter = { n: 0, label };
      for (const t of TABLES) this.writeDiff(t, this.cache[t.name] as unknown[], draft[t.name] as unknown[], counter);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.cache = draft;
    this.hooks.point(`txn:${label}:after`);
    return result;
  }

  private keyed(t: (typeof TABLES)[number], rows: unknown[]): Map<string, { json: string; owner: string | null }> {
    const m = new Map<string, { json: string; owner: string | null }>();
    const ordinals = new Map<string, number>();
    for (const r of rows) {
      const probe = t.key(r as never, 0);
      const n = ordinals.get(probe) ?? 0;
      ordinals.set(probe, n + 1);
      const key = t.key(r as never, n);
      if (m.has(key)) throw new Error(`Duplicate key ${key} in ${t.sql}`);
      m.set(key, { json: JSON.stringify(r), owner: t.owner(r as never) });
    }
    return m;
  }

  private writeDiff(t: (typeof TABLES)[number], before: unknown[], after: unknown[], counter: { n: number; label: string }): void {
    const a = this.keyed(t, before);
    const b = this.keyed(t, after);
    // A crash point after the first statement of each transaction: some rows are already
    // changed inside the open SQL transaction, which must then roll back as a whole.
    const step = () => {
      counter.n += 1;
      if (counter.n === 1) this.hooks.point(`txn:${counter.label}:mid`);
    };
    for (const key of a.keys()) {
      if (!b.has(key)) {
        this.db.prepare(`DELETE FROM ${t.sql} WHERE key = ?`).run(key);
        step();
      }
    }
    for (const [key, v] of b) {
      const old = a.get(key);
      if (!old) {
        this.db.prepare(`INSERT INTO ${t.sql} (key, owner, data) VALUES (?, ?, ?)`).run(key, v.owner, v.json);
        step();
      } else if (old.json !== v.json) {
        this.db.prepare(`UPDATE ${t.sql} SET data = ?, owner = ? WHERE key = ?`).run(v.json, v.owner, key);
        step();
      }
    }
  }

  close(): void {
    this.db.close();
  }
}

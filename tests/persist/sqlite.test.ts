// The SQLite run-state store (node:sqlite), on a real temporary file.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CrashHooks, SimulatedCrash } from '../../src/core/sim-store.js';
import { SCHEMA_VERSION, SqliteDb } from '../../src/persist/sqlite-db.js';
import { cleanupTemp, tempDir } from './helpers.js';

afterEach(cleanupTemp);

const project = (id: string) => ({
  id,
  name: `Project ${id}`,
  business: 'fictional-a' as const,
  folderId: 'f',
  folderPath: '/x',
  repoConfirmed: true as const,
  archived: false,
  registeredAt: 'now',
});

describe('SQLite store', () => {
  it('creates the schema with a migration record and survives reopening', () => {
    const file = path.join(tempDir('db'), 's.sqlite');
    const db = new SqliteDb(file, new CrashHooks(), { fullSync: false });
    expect(db.schemaVersion()).toBe(SCHEMA_VERSION);
    db.transact('add', (d) => {
      d.projects.push(project('p1'));
    });
    db.close();
    const again = new SqliteDb(file, new CrashHooks(), { fullSync: true });
    expect(again.tables.projects.map((p) => p.id)).toEqual(['p1']);
    const raw = new DatabaseSync(file);
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['projects', 'tasks', 'attempts', 'record_files', 'dispatch_journal', 'artifacts', 'outside_saves', 'schema_migrations']));
    expect((raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    raw.close();
    again.close();
  });

  it('a transaction that throws changes nothing, in memory or on disk', () => {
    const file = path.join(tempDir('db'), 's.sqlite');
    const db = new SqliteDb(file, new CrashHooks(), { fullSync: false });
    db.transact('add', (d) => {
      d.projects.push(project('p1'));
    });
    expect(() =>
      db.transact('bad', (d) => {
        d.projects.push(project('p2'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.tables.projects).toHaveLength(1);
    db.close();
    expect(new SqliteDb(file, new CrashHooks(), { fullSync: false }).tables.projects).toHaveLength(1);
  });

  it('a crash before the transaction leaves none of it; a crash after leaves all of it', () => {
    const file = path.join(tempDir('db'), 's.sqlite');
    const hooks = new CrashHooks();
    const db = new SqliteDb(file, hooks, { fullSync: false });
    hooks.arm('txn:one:before');
    expect(() => db.transact('one', (d) => void d.projects.push(project('p1')))).toThrow(SimulatedCrash);
    hooks.arm('txn:two:after');
    expect(() => db.transact('two', (d) => void d.projects.push(project('p2')))).toThrow(SimulatedCrash);
    db.close();
    expect(new SqliteDb(file, new CrashHooks(), { fullSync: false }).tables.projects.map((p) => p.id)).toEqual(['p2']);
  });

  it('writes only changed rows, keeps order, and deletes removed rows', () => {
    const file = path.join(tempDir('db'), 's.sqlite');
    const db = new SqliteDb(file, new CrashHooks(), { fullSync: false });
    db.transact('add', (d) => {
      d.projects.push(project('a'), project('b'), project('c'));
    });
    db.transact('edit', (d) => {
      d.projects.find((p) => p.id === 'b')!.name = 'renamed';
      d.projects = d.projects.filter((p) => p.id !== 'a');
    });
    db.close();
    const again = new SqliteDb(file, new CrashHooks(), { fullSync: false });
    expect(again.tables.projects.map((p) => [p.id, p.name])).toEqual([
      ['b', 'renamed'],
      ['c', 'Project c'],
    ]);
  });

  it('refuses a store written by a newer schema', () => {
    const file = path.join(tempDir('db'), 's.sqlite');
    new SqliteDb(file, new CrashHooks(), { fullSync: false }).close();
    const raw = new DatabaseSync(file);
    raw.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION + 1, 'later');
    raw.close();
    expect(() => new SqliteDb(file, new CrashHooks(), { fullSync: false })).toThrow(/newer version/);
  });
});

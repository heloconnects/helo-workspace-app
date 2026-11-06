// In-memory stand-ins for the SQLite store and for the clone's app-records
// folder. Real persistence (F3 file writing into clones, SQLite, carried item
// C1) is out of scope for this build; these keep the same ordering rules so
// the recovery logic can be exercised with simulated crashes.

import { sha256 } from './hash.js';

/** Thrown at a named boundary to simulate the app process dying there. */
export class SimulatedCrash extends Error {
  constructor(readonly point: string) {
    super(`Simulated crash at ${point}`);
    this.name = 'SimulatedCrash';
  }
}

/**
 * Crash points. Every durable step calls point(name). A test (or a scenario)
 * names one point; the first time it is reached the hook throws SimulatedCrash.
 * All points reached are recorded so tests can enumerate them.
 */
export class CrashHooks {
  readonly seen: string[] = [];
  private armed = new Set<string>();
  private fired = new Set<string>();
  /**
   * Test-only: what happens when an armed point is reached. Default: throw
   * SimulatedCrash. The process-kill tests set this to kill the process
   * outright (SIGKILL), so nothing after the point runs at all.
   */
  onFire: ((point: string) => void) | null = null;

  /** Arm a point: the next time it is reached, the hook throws once. */
  arm(point: string): void {
    this.fired.delete(point);
    this.armed.add(point);
  }

  disarmAll(): void {
    this.armed.clear();
  }

  point(name: string): void {
    this.seen.push(name);
    if (this.armed.has(name) && !this.fired.has(name)) {
      this.fired.add(name);
      this.armed.delete(name);
      this.onFire?.(name);
      throw new SimulatedCrash(name);
    }
  }
}

export class SimFsError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(`${code}: ${message} (${path})`);
    this.name = 'SimFsError';
  }
}

/**
 * A folder handle opened once for one publication. All operations are
 * relative to it (F3): create a new file exclusively, then move it to its
 * final name with a no-replace move (fails if the name exists). Nothing is
 * ever replaced and nothing is ever deleted.
 */
export interface DirHandle {
  createExclusive(name: string, content: string, faultKey?: string): void;
  /** No-replace move within this folder (macOS renameatx_np with RENAME_EXCL on real disk). */
  publish(from: string, to: string): void;
  sync(): void;
  close(): void;
}

/**
 * One project folder as the engine sees it. Paths are relative to the folder
 * root and always built by the app from fixed patterns. There is no overwrite
 * and no delete. Implemented in memory by SimFs and on disk by RealCloneFs.
 */
export interface CloneFs {
  readonly root: string;
  exists(path: string): boolean;
  read(path: string): string | undefined;
  hash(path: string): string | undefined;
  list(prefix: string): string[];
  /** Open (creating missing folders) the folder at a relative path, as a handle. Refused while the project is blocked. */
  openDir(dir: string): DirHandle;
  /** No-replace move of dir/name to dir/quarantine/qName; fails with EEXIST if qName exists. */
  quarantineMove(dir: string, name: string, qName: string): void;
  /** Simulated write faults (a real disk cannot be filled on demand). */
  injectFault(recordName: string, code: 'ENOSPC' | 'EACCES', times?: number): void;
  clearFaults(): void;
  /** Simulation and test helpers: outside interference with the folder. Only the in-memory folder supports them. */
  readonly supportsExternalEdits: boolean;
  externalWrite(path: string, content: string): void;
  externalDelete(path: string): void;
  snapshot(): Map<string, string>;
}

/** The simulated contents of one clone folder, in memory. */
export class SimFs implements CloneFs {
  private files = new Map<string, string>();
  private faults = new Map<string, { code: 'ENOSPC' | 'EACCES'; remaining: number }>();
  readonly supportsExternalEdits = true;

  constructor(readonly root: string) {}

  exists(path: string): boolean {
    return this.files.has(path);
  }

  read(path: string): string | undefined {
    return this.files.get(path);
  }

  hash(path: string): string | undefined {
    const f = this.files.get(path);
    return f === undefined ? undefined : sha256(f);
  }

  list(prefix: string): string[] {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  openDir(dir: string): DirHandle {
    const at = (name: string) => `${dir}/${checkName(name)}`;
    return {
      createExclusive: (name, content, faultKey) => {
        const path = at(name);
        if (faultKey !== undefined) {
          const fault = this.faults.get(faultKey);
          if (fault && fault.remaining !== 0) {
            if (fault.remaining > 0) fault.remaining -= 1;
            const msg = fault.code === 'ENOSPC' ? 'no space left on device (simulated)' : 'permission denied (simulated)';
            throw new SimFsError(fault.code, path, msg);
          }
        }
        if (this.files.has(path)) throw new SimFsError('EEXIST', path, 'file already exists');
        this.files.set(path, content);
      },
      publish: (from, to) => this.move(at(from), at(to)),
      sync: () => undefined,
      close: () => undefined,
    };
  }

  quarantineMove(dir: string, name: string, qName: string): void {
    this.move(`${dir}/${checkName(name)}`, `${dir}/quarantine/${checkName(qName)}`);
  }

  /** Atomic no-replace move. */
  private move(from: string, to: string): void {
    const f = this.files.get(from);
    if (f === undefined) throw new SimFsError('ENOENT', from, 'source missing');
    if (this.files.has(to)) throw new SimFsError('EEXIST', to, 'collision: destination name already exists');
    this.files.delete(from);
    this.files.set(to, f);
  }

  injectFault(recordName: string, code: 'ENOSPC' | 'EACCES', times = -1): void {
    this.faults.set(recordName, { code, remaining: times });
  }

  clearFaults(): void {
    this.faults.clear();
  }

  externalWrite(path: string, content: string): void {
    this.files.set(path, content);
  }

  externalDelete(path: string): void {
    this.files.delete(path);
  }

  snapshot(): Map<string, string> {
    return new Map(this.files);
  }
}

/** A single path component chosen by the app: never empty, ".", "..", or containing "/" or NUL. */
export function checkName(name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0') || name.length > 255) {
    throw new SimFsError('EINVAL', name, 'invalid file or folder name');
  }
  return name;
}

/** The run-state store as the engine sees it: SimDb in memory, SqliteDb on disk. */
export interface DbLike<T extends object> {
  readonly tables: Readonly<T>;
  transact<R>(label: string, fn: (draft: T) => R): R;
}

/**
 * Simulated SQLite: plain tables, changed only inside transact(). A
 * transaction runs on a copy and is swapped in whole, so a crash before or
 * after it leaves either all or none of it.
 */
export class SimDb<T extends object> implements DbLike<T> {
  private data: T;

  constructor(
    initial: T,
    private readonly hooks: CrashHooks,
  ) {
    this.data = structuredClone(initial);
  }

  get tables(): Readonly<T> {
    return this.data;
  }

  transact<R>(label: string, fn: (draft: T) => R): R {
    this.hooks.point(`txn:${label}:before`);
    const draft = structuredClone(this.data);
    const result = fn(draft);
    this.data = draft;
    this.hooks.point(`txn:${label}:after`);
    return result;
  }
}

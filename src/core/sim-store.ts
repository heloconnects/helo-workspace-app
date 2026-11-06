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
      throw new SimulatedCrash(name);
    }
  }
}

export class SimFsError extends Error {
  constructor(
    readonly code: 'EEXIST' | 'ENOENT' | 'ENOSPC' | 'EACCES',
    readonly path: string,
    message: string,
  ) {
    super(`${code}: ${message} (${path})`);
    this.name = 'SimFsError';
  }
}

/**
 * The simulated contents of one clone folder. Paths are relative to the clone
 * root and always built by the app from fixed patterns. Only create-exclusive,
 * no-replace hard link and unlink are offered: there is no rename and no
 * overwrite, matching F3's safe publication.
 */
export class SimFs {
  private files = new Map<string, string>();
  /** One-shot or persistent write faults keyed by record-file name. */
  private faults = new Map<string, { code: 'ENOSPC' | 'EACCES'; remaining: number }>();

  constructor(readonly root: string) {}

  exists(path: string): boolean {
    return this.files.has(path);
  }

  read(path: string): string | undefined {
    return this.files.get(path);
  }

  hash(path: string): string | undefined {
    const content = this.files.get(path);
    return content === undefined ? undefined : sha256(content);
  }

  list(prefix: string): string[] {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  /** Create a new file; fails if the name exists. */
  createExclusive(path: string, content: string, faultKey?: string): void {
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
  }

  /** Hard link: fails if the destination exists. Never replaces anything. */
  link(from: string, to: string): void {
    const content = this.files.get(from);
    if (content === undefined) throw new SimFsError('ENOENT', from, 'source missing');
    if (this.files.has(to)) throw new SimFsError('EEXIST', to, 'collision: destination name already exists');
    this.files.set(to, content);
  }

  unlink(path: string): void {
    if (!this.files.delete(path)) throw new SimFsError('ENOENT', path, 'no such file');
  }

  /** Simulation and test helpers: outside interference with the clone. */
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

/**
 * Simulated SQLite: plain tables, changed only inside transact(). A
 * transaction runs on a copy and is swapped in whole, so a crash before or
 * after it leaves either all or none of it.
 */
export class SimDb<T extends object> {
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

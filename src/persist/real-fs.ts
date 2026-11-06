// A real project folder for the engine. Every operation goes through the
// safe_publish native helper. Writes first open the project root as a handle,
// check that handle (its identity and the RULES.md read through it), and then
// open the target folder relative to that same handle, so the folder that was
// checked is the folder written to (F2 tied to F3). Files are created
// exclusively and published with a no-replace move. Nothing is ever replaced
// or deleted. This file never uses node:fs.

import { sha256 } from '../core/hash.js';
import { checkName, SimFsError, type CloneFs, type DirHandle } from '../core/sim-store.js';
import { loadSafePublish, nativeCode, type SafePublish } from './native.js';

export const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** Only this folder (and what is under it) is ever listed or written. */
export const RECORDS_ROOT = 'app-records';

export interface RealCloneOptions {
  /** macOS F_FULLFSYNC (flush the drive's cache too). Tests may turn it off for speed; plain fsync is still used. */
  fullSync: boolean;
}

/** Checks an open root handle before any write through it. Returns a blocking reason, or null. */
export type RootCheck = (rootFd: number) => string | null;

export class RealCloneFs implements CloneFs {
  readonly supportsExternalEdits = false;
  private readonly native: SafePublish;
  private faults = new Map<string, { code: 'ENOSPC' | 'EACCES'; remaining: number }>();
  /** Set when the folder is registered; until then every write is refused. */
  checkRoot: RootCheck = () => 'the folder is not registered as a project';

  constructor(
    readonly root: string,
    private readonly options: RealCloneOptions,
    native?: SafePublish,
  ) {
    if (!root.startsWith('/')) throw new Error('RealCloneFs needs an absolute folder path');
    this.native = native ?? loadSafePublish();
  }

  private segments(dir: string): string[] {
    if (dir === '') return [];
    const segs = dir.split('/');
    if (segs[0] !== RECORDS_ROOT) throw new SimFsError('EPERM', dir, `the app only works inside ${RECORDS_ROOT}/`);
    return segs.map(checkName);
  }

  private split(path: string): { dir: string; name: string } {
    const i = path.lastIndexOf('/');
    return i < 0 ? { dir: '', name: checkName(path) } : { dir: path.slice(0, i), name: checkName(path.slice(i + 1)) };
  }

  private fail(e: unknown, where: string): never {
    if (e instanceof SimFsError) throw e;
    throw new SimFsError(nativeCode(e), `${this.root}/${where}`, (e as Error).message);
  }

  /**
   * Open the folder at `dir` below the project root. For writes the root
   * handle is checked first and the folder is opened relative to it.
   */
  private openUnder(dir: string, opts: { create: boolean; forWrite: boolean }): number {
    const segs = this.segments(dir);
    let rootFd: number;
    try {
      rootFd = this.native.openRoot(this.root);
    } catch (e) {
      this.fail(e, '');
    }
    try {
      if (opts.forWrite) {
        const reason = this.checkRoot(rootFd);
        if (reason) throw new SimFsError('EPERM', this.root, `project blocked, nothing written: ${reason}`);
      }
      try {
        return this.native.openSub(rootFd, segs, opts.create);
      } catch (e) {
        this.fail(e, dir);
      }
    } finally {
      this.native.closeDir(rootFd);
    }
  }

  /** Open for reading, or null when the folder (or a parent) does not exist or is not a plain folder. */
  private tryOpen(dir: string): number | null {
    try {
      return this.openUnder(dir, { create: false, forWrite: false });
    } catch (e) {
      const code = e instanceof SimFsError ? e.code : nativeCode(e);
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return null;
      throw e;
    }
  }

  read(path: string): string | undefined {
    const { dir, name } = this.split(path);
    if (dir === '' && name !== 'RULES.md') return undefined;
    const fd = this.tryOpen(dir);
    if (fd === null) return undefined;
    try {
      const buf = this.native.readFile(fd, name, MAX_RECORD_BYTES);
      return buf === null ? undefined : buf.toString('utf8');
    } catch (e) {
      const code = nativeCode(e);
      // A symlink, a FIFO or device, or an oversized file where a record should be: not a valid record.
      if (code === 'ELOOP' || code === 'EINVAL' || code === 'EFBIG') return undefined;
      this.fail(e, path);
    } finally {
      this.native.closeDir(fd);
    }
  }

  exists(path: string): boolean {
    return this.read(path) !== undefined;
  }

  hash(path: string): string | undefined {
    const content = this.read(path);
    return content === undefined ? undefined : sha256(content);
  }

  /** Every entry under app-records/ whose path starts with the prefix (folders are walked, never followed). */
  list(prefix: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      const fd = this.tryOpen(dir);
      if (fd === null) return;
      let entries: { name: string; kind: string }[];
      try {
        entries = this.native.listDir(fd);
      } finally {
        this.native.closeDir(fd);
      }
      for (const e of entries) {
        const p = `${dir}/${e.name}`;
        if (e.kind === 'dir') walk(p);
        else out.push(p); // files, and anything odd (a symlink, a FIFO) so the inventory shows it
      }
    };
    walk(RECORDS_ROOT);
    return out.filter((p) => p.startsWith(prefix)).sort();
  }

  openDir(dir: string): DirHandle {
    const fd = this.openUnder(dir, { create: true, forWrite: true });
    const native = this.native;
    const full = this.options.fullSync;
    let closed = false;
    const at = (name: string) => `${dir}/${name}`;
    return {
      createExclusive: (name, content, faultKey) => {
        if (faultKey !== undefined) {
          const fault = this.faults.get(faultKey);
          if (fault && fault.remaining !== 0) {
            if (fault.remaining > 0) fault.remaining -= 1;
            const msg = fault.code === 'ENOSPC' ? 'no space left on device (simulated)' : 'permission denied (simulated)';
            throw new SimFsError(fault.code, `${this.root}/${at(name)}`, msg);
          }
        }
        try {
          native.createExclusive(fd, checkName(name), Buffer.from(content, 'utf8'), full);
        } catch (e) {
          this.fail(e, at(name));
        }
      },
      publish: (from, to) => {
        try {
          native.moveNoReplace(fd, checkName(from), fd, checkName(to), full);
        } catch (e) {
          this.fail(e, at(to));
        }
      },
      sync: () => {
        try {
          native.fsyncDir(fd, full);
        } catch (e) {
          this.fail(e, dir);
        }
      },
      close: () => {
        if (!closed) {
          closed = true;
          native.closeDir(fd);
        }
      },
    };
  }

  quarantineMove(dir: string, name: string, qName: string): void {
    const fd = this.openUnder(dir, { create: false, forWrite: true });
    try {
      const qfd = this.openUnder(`${dir}/quarantine`, { create: true, forWrite: true });
      try {
        this.native.moveNoReplace(fd, checkName(name), qfd, checkName(qName), this.options.fullSync);
      } catch (e) {
        this.fail(e, `${dir}/quarantine/${qName}`);
      } finally {
        this.native.closeDir(qfd);
      }
    } finally {
      this.native.closeDir(fd);
    }
  }

  injectFault(recordName: string, code: 'ENOSPC' | 'EACCES', times = -1): void {
    this.faults.set(recordName, { code, remaining: times });
  }

  clearFaults(): void {
    this.faults.clear();
  }

  externalWrite(): void {
    throw new SimFsError('EPERM', this.root, 'the app never changes records in a real folder');
  }

  externalDelete(): void {
    throw new SimFsError('EPERM', this.root, 'the app never deletes records in a real folder');
  }

  snapshot(): Map<string, string> {
    return new Map(this.list('').map((p) => [p, this.read(p) ?? '(not a regular file)']));
  }
}

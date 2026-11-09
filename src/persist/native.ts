// Typed loader for the safe_publish native helper (src/native/safe_publish.c).
// Loaded only by the main process and by tests; never by the interface.

import { createRequire } from 'node:module';
import path from 'node:path';

export type EntryKind = 'file' | 'dir' | 'other';

export type SwapHookStage = 'before-move' | 'before-move-back';

export interface SafePublish {
  /** Open the project root as a handle; refuses a symlink anywhere in the path. */
  openRoot(root: string): number;
  /** Open (optionally creating, and flushing each new entry) a folder below an open handle; returns a new handle. */
  openSub(baseFd: number, segments: string[], create: boolean): number;
  /** "dev:ino" of an open folder. */
  identity(fd: number): string;
  closeDir(fd: number): void;
  createExclusive(fd: number, name: string, data: Buffer, fullSync: boolean): void;
  /**
   * Atomic no-replace move (renameatx_np RENAME_EXCL) of a regular file, verified after; does not flush.
   * A swap at the source name at the instant of the move is detected, not prevented: it throws
   * ESWAPPED_MOVED_BACK or ESWAPPED_NOT_MOVED_BACK (plan revision 9). `testHook` is for tests only:
   * it is called with "before-move" and "before-move-back" so a test can stage the race.
   */
  moveNoReplace(srcFd: number, name: string, destFd: number, destName: string, testHook?: (stage: SwapHookStage) => void): void;
  fsyncDir(fd: number, fullSync: boolean): void;
  readFile(fd: number, name: string, maxBytes: number): Buffer | null;
  listDir(fd: number): { name: string; kind: EntryKind }[];
}

let cached: SafePublish | null = null;

/** Path of the compiled helper, relative to this file in src/persist or dist/persist. */
export function nativeModulePath(): string {
  return path.join(__dirname, '..', '..', 'build', 'Release', 'safe_publish.node');
}

export function loadSafePublish(): SafePublish {
  if (!cached) {
    const req = createRequire(__filename);
    cached = req(nativeModulePath()) as SafePublish;
  }
  return cached;
}

/** The error code the helper attached ("EEXIST", "ELOOP", ...). */
export function nativeCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'EUNKNOWN';
}

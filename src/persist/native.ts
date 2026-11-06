// Typed loader for the safe_publish native helper (src/native/safe_publish.c).
// Loaded only by the main process and by tests; never by the interface.

import { createRequire } from 'node:module';
import path from 'node:path';

export type EntryKind = 'file' | 'dir' | 'other';

export interface SafePublish {
  openDir(root: string, segments: string[], create: boolean): number;
  closeDir(fd: number): void;
  createExclusive(fd: number, name: string, data: Buffer, fullSync: boolean): void;
  linkNoReplace(fd: number, from: string, to: string): void;
  linkInto(srcFd: number, name: string, destFd: number, destName: string): void;
  removeTemp(fd: number, name: string): void;
  removeQuarantined(srcFd: number, name: string, quarantineFd: number, quarantineName: string): void;
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

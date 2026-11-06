// A real, fictional test folder chosen by Ahmed. Its path and RULES.md are
// re-read from disk every time the engine asks (F2: re-checked before every
// task and every write). node:fs is used here only to resolve and inspect the
// folder path, never to write.

import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { businessFromRules, type Folder } from '../core/fixtures.js';
import { sha256 } from '../core/hash.js';
import type { Business } from '../shared/types.js';
import { loadSafePublish, type SafePublish } from './native.js';
import { RealCloneFs, type RealCloneOptions } from './real-fs.js';

const MAX_RULES_BYTES = 64 * 1024;

export function realFolderId(root: string): string {
  return `real:${sha256(root).slice(0, 16)}`;
}

export class RealFolder implements Folder {
  readonly id: string;
  readonly kind = 'real' as const;
  readonly clone: RealCloneFs;
  private readonly native: SafePublish;

  constructor(
    /** The path as registered: absolute and already free of symlinks. */
    readonly root: string,
    options: RealCloneOptions,
    native?: SafePublish,
  ) {
    this.native = native ?? loadSafePublish();
    this.id = realFolderId(root);
    this.clone = new RealCloneFs(root, options, this.native);
  }

  /** The folder's current resolved path, or a marker when it is missing or has become a link. */
  get path(): string {
    try {
      if (lstatSync(this.root).isSymbolicLink()) return '(folder replaced by a link)';
      return realpathSync(this.root);
    } catch {
      return '(folder missing)';
    }
  }

  private readRules(rootFd: number): string | undefined {
    try {
      const buf = this.native.readFile(rootFd, 'RULES.md', MAX_RULES_BYTES);
      if (buf === null) return undefined;
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return undefined;
    }
  }

  private rulesText(): string | undefined {
    let fd: number;
    try {
      fd = this.native.openRoot(this.root);
    } catch {
      return undefined;
    }
    try {
      return this.readRules(fd);
    } finally {
      this.native.closeDir(fd);
    }
  }

  get rulesBusiness(): Business | null {
    return businessFromRules(this.rulesText());
  }

  /** RULES.md only. Importing context sources from a real folder is not part of persistence v1. */
  get files(): Record<string, string> {
    const t = this.rulesText();
    return t === undefined ? {} : { 'RULES.md': t };
  }

  identity(): string | null {
    let fd: number;
    try {
      fd = this.native.openRoot(this.root);
    } catch {
      return null;
    }
    try {
      return this.native.identity(fd);
    } finally {
      this.native.closeDir(fd);
    }
  }

  /**
   * Bind the registered identity and business. From then on every write
   * checks them on the very root handle it then writes through.
   */
  expect(identity: string | null, business: Business): void {
    this.clone.checkRoot = (rootFd) => {
      if (identity === null) return 'the folder has no registered identity; register the project again';
      if (this.native.identity(rootFd) !== identity) return 'the folder was replaced by a different folder since registration';
      const found = businessFromRules(this.readRules(rootFd));
      if (found === null) return 'RULES.md is missing or names no fictional business';
      if (found !== business) return 'the RULES.md business line no longer matches';
      return null;
    };
  }
}

export interface TestFolderGuards {
  /** This app's own repository, which must never be used as a test folder. */
  appRoot: string;
  home: string;
}

/**
 * Check a folder Ahmed picked before it can be registered: absolute, a real
 * folder reached without any symlink, not a real business folder, not this
 * app's repository, and with a RULES.md naming one of the fictional businesses.
 */
export function openTestFolder(chosen: string, guards: TestFolderGuards, options: RealCloneOptions, native?: SafePublish): RealFolder {
  if (!path.isAbsolute(chosen)) throw new Error('Choose a folder by its full path.');
  let resolved: string;
  try {
    resolved = realpathSync(chosen);
  } catch {
    throw new Error('That folder does not exist.');
  }
  if (resolved !== path.resolve(chosen)) throw new Error('Choose the folder itself, not a link or a path through a link.');
  if (!lstatSync(resolved).isDirectory()) throw new Error('That is not a folder.');
  const home = realpathSync(guards.home);
  const appRoot = realpathSync(guards.appRoot);
  const inside = (p: string, parent: string) => p === parent || p.startsWith(parent + path.sep);
  if (resolved === '/' || resolved === home || resolved === path.join(home, 'Desktop')) throw new Error('Choose a dedicated test folder, not a top-level folder.');
  if (inside(resolved, appRoot) || inside(appRoot, resolved)) throw new Error("Refused: that is (or contains) this app's own repository.");
  if (inside(resolved, path.join(home, 'Desktop', 'Helo'))) throw new Error('Refused: ~/Desktop/Helo is real office material, never a test folder.');
  const parts = resolved.split(path.sep);
  if (parts.some((p) => p === 'helo-walkup' || p === 'helo-hoe')) throw new Error('Refused: that is a real business repository, never a test folder.');
  const folder = new RealFolder(resolved, options, native);
  if (folder.rulesBusiness === null) {
    throw new Error('Refused: the folder needs a RULES.md whose line "Business in this repository:" names Example Business A (fictional) or Example Business B (fictional).');
  }
  return folder;
}

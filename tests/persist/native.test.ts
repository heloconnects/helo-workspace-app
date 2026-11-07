// The safe_publish native helper, on real temporary folders.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSafePublish } from '../../src/persist/native.js';
import { cleanupTemp, tempDir } from './helpers.js';

const n = loadSafePublish();
afterEach(cleanupTemp);

function code(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return 'no error';
}

/** Open a folder below a root, the way the app does: root handle first, then relative to it. */
function open(root: string, segs: string[], create = true): number {
  const r = n.openRoot(root);
  try {
    return n.openSub(r, segs, create);
  } finally {
    n.closeDir(r);
  }
}

describe('safe_publish native helper', () => {
  it('offers no way to delete anything', () => {
    expect(Object.keys(n).sort()).toEqual(['closeDir', 'createExclusive', 'fsyncDir', 'identity', 'listDir', 'moveNoReplace', 'openRoot', 'openSub', 'readFile']);
  });

  it('creates folders, writes a temporary file exclusively and publishes it with a no-replace move', () => {
    const root = tempDir('n');
    const fd = open(root, ['app-records', 't1', 'a1']);
    n.createExclusive(fd, '.tmp-w1', Buffer.from('hello'), false);
    n.moveNoReplace(fd, '.tmp-w1', fd, 'packet.md');
    n.fsyncDir(fd, true); // F_FULLFSYNC path
    expect(readFileSync(path.join(root, 'app-records/t1/a1/packet.md'), 'utf8')).toBe('hello');
    expect(existsSync(path.join(root, 'app-records/t1/a1/.tmp-w1'))).toBe(false);
    expect(n.readFile(fd, 'packet.md', 100)!.toString()).toBe('hello');
    expect(n.readFile(fd, 'missing.md', 100)).toBeNull();
    expect(n.listDir(fd)).toEqual([{ name: 'packet.md', kind: 'file' }]);
    n.closeDir(fd);
  });

  it('never replaces an existing file: exclusive create and the publishing move both fail with EEXIST, and the temporary file is kept', () => {
    const root = tempDir('n');
    const fd = open(root, ['app-records']);
    writeFileSync(path.join(root, 'app-records', 'final.md'), 'someone else');
    expect(code(() => n.createExclusive(fd, 'final.md', Buffer.from('mine'), false))).toBe('EEXIST');
    n.createExclusive(fd, '.tmp-x', Buffer.from('mine'), false);
    expect(code(() => n.moveNoReplace(fd, '.tmp-x', fd, 'final.md'))).toBe('EEXIST');
    expect(readFileSync(path.join(root, 'app-records', 'final.md'), 'utf8')).toBe('someone else');
    expect(readFileSync(path.join(root, 'app-records', '.tmp-x'), 'utf8')).toBe('mine'); // nothing deleted
    n.closeDir(fd);
  });

  it('a destination created by another process after the temporary file was made is never replaced', () => {
    const root = tempDir('n');
    const fd = open(root, ['app-records']);
    n.createExclusive(fd, '.tmp-x', Buffer.from('mine'), false);
    writeFileSync(path.join(root, 'app-records', 'record.md'), 'raced in'); // the other process
    expect(code(() => n.moveNoReplace(fd, '.tmp-x', fd, 'record.md'))).toBe('EEXIST');
    expect(readFileSync(path.join(root, 'app-records', 'record.md'), 'utf8')).toBe('raced in');
    n.closeDir(fd);
  });

  it('refuses a symlink at the root, anywhere in the root path, at any folder level, and as a file', () => {
    const real = tempDir('real');
    const elsewhere = tempDir('elsewhere');
    const link = path.join(tempDir('links'), 'root-link');
    symlinkSync(real, link);
    expect(code(() => n.openRoot(link))).toBe('ELOOP');
    const parentLink = path.join(tempDir('links'), 'parent-link');
    symlinkSync(path.dirname(real), parentLink);
    expect(['ELOOP', 'ENOTDIR']).toContain(code(() => n.openRoot(path.join(parentLink, path.basename(real)))));
    mkdirSync(path.join(real, 'app-records'));
    symlinkSync(elsewhere, path.join(real, 'app-records', 't1'));
    expect(['ELOOP', 'ENOTDIR']).toContain(code(() => open(real, ['app-records', 't1'])));
    const fd = open(real, ['app-records'], false);
    writeFileSync(path.join(elsewhere, 'secret.md'), 'outside');
    symlinkSync(path.join(elsewhere, 'secret.md'), path.join(real, 'app-records', 'x.md'));
    expect(code(() => n.readFile(fd, 'x.md', 100))).toBe('EINVAL'); // not a regular file: never read through
    expect(n.listDir(fd).find((e) => e.name === 'x.md')?.kind).toBe('other');
    expect(n.listDir(fd).find((e) => e.name === 't1')?.kind).toBe('other');
    n.closeDir(fd);
  });

  it('the root folder swapped after it was opened and checked cannot redirect the write (F2 check tied to the write handle)', () => {
    const parent = tempDir('p');
    const root = path.join(parent, 'clone');
    mkdirSync(root);
    writeFileSync(path.join(root, 'RULES.md'), 'checked');
    const r = n.openRoot(root);
    const id = n.identity(r);
    expect(n.readFile(r, 'RULES.md', 100)!.toString()).toBe('checked'); // the check, through the handle
    // Now the folder is swapped for another plain folder at the same path.
    renameSync(root, path.join(parent, 'clone-moved'));
    mkdirSync(root);
    writeFileSync(path.join(root, 'RULES.md'), 'impostor');
    const fd = n.openSub(r, ['app-records'], true);
    n.createExclusive(fd, '.tmp-w', Buffer.from('record'), false);
    n.moveNoReplace(fd, '.tmp-w', fd, 'packet.md');
    n.closeDir(fd);
    n.closeDir(r);
    expect(existsSync(path.join(root, 'app-records'))).toBe(false);
    expect(readFileSync(path.join(parent, 'clone-moved', 'app-records', 'packet.md'), 'utf8')).toBe('record');
    // A fresh open of the path sees the impostor, whose identity differs.
    const r2 = n.openRoot(root);
    expect(n.identity(r2)).not.toBe(id);
    n.closeDir(r2);
  });

  it('a folder below the root swapped after it was opened cannot redirect the write either', () => {
    const root = tempDir('n');
    const elsewhere = tempDir('elsewhere');
    const fd = open(root, ['app-records', 't1', 'a1']);
    renameSync(path.join(root, 'app-records/t1/a1'), path.join(root, 'app-records/t1/a1-moved'));
    symlinkSync(elsewhere, path.join(root, 'app-records/t1/a1'));
    n.createExclusive(fd, '.tmp-w', Buffer.from('record'), false);
    n.moveNoReplace(fd, '.tmp-w', fd, 'packet.md');
    n.closeDir(fd);
    expect(existsSync(path.join(elsewhere, 'packet.md'))).toBe(false);
    expect(readFileSync(path.join(root, 'app-records/t1/a1-moved/packet.md'), 'utf8')).toBe('record');
  });

  it('moves only a regular file: a folder, a symlink or a FIFO at the source name is refused and left where it is', () => {
    const root = tempDir('n');
    const fd = open(root, ['d']);
    mkdirSync(path.join(root, 'd', '.tmp-dir'));
    writeFileSync(path.join(root, 'd', '.tmp-dir', 'inside.md'), 'x');
    expect(code(() => n.moveNoReplace(fd, '.tmp-dir', fd, 'packet.md'))).toBe('EINVAL');
    expect(existsSync(path.join(root, 'd', '.tmp-dir', 'inside.md'))).toBe(true);
    expect(existsSync(path.join(root, 'd', 'packet.md'))).toBe(false);
    symlinkSync(tempDir('elsewhere'), path.join(root, 'd', '.tmp-link'));
    expect(code(() => n.moveNoReplace(fd, '.tmp-link', fd, 'packet.md'))).toBe('ELOOP');
    execFileSync('mkfifo', [path.join(root, 'd', '.tmp-fifo')]);
    expect(code(() => n.moveNoReplace(fd, '.tmp-fifo', fd, 'packet.md'))).toBe('EINVAL');
    expect(existsSync(path.join(root, 'd', 'packet.md'))).toBe(false);
    n.closeDir(fd);
  });

  it('moves into quarantine across two folder handles without replacing anything', () => {
    const root = tempDir('n');
    const fd = open(root, ['d']);
    const qfd = open(root, ['d', 'quarantine']);
    writeFileSync(path.join(root, 'd', 'bad.md'), 'content');
    writeFileSync(path.join(root, 'd', 'quarantine', 'taken'), 'earlier copy');
    expect(code(() => n.moveNoReplace(fd, 'bad.md', qfd, 'taken'))).toBe('EEXIST');
    expect(readFileSync(path.join(root, 'd', 'quarantine', 'taken'), 'utf8')).toBe('earlier copy');
    n.moveNoReplace(fd, 'bad.md', qfd, 'bad.md-w1');
    expect(existsSync(path.join(root, 'd', 'bad.md'))).toBe(false);
    expect(readFileSync(path.join(root, 'd', 'quarantine', 'bad.md-w1'), 'utf8')).toBe('content');
    n.closeDir(fd);
    n.closeDir(qfd);
  });

  it('rejects names that are not a single plain component', () => {
    const root = tempDir('n');
    const r = n.openRoot(root);
    for (const bad of ['', '.', '..', 'a/b', '../x', 'a\0b']) {
      expect(code(() => n.openSub(r, [bad], true)), JSON.stringify(bad)).toBe('EINVAL');
    }
    for (const bad of ['..', 'x/y', '']) expect(code(() => n.createExclusive(r, bad, Buffer.from('x'), false))).toBe('EINVAL');
    expect(code(() => n.moveNoReplace(r, 'a', r, '../b'))).toBe('EINVAL');
    expect(code(() => n.openRoot('relative/path'))).toBe('EINVAL');
    n.closeDir(r);
  });

  it('reads regular files only: a FIFO is refused at once without hanging, and size is limited', () => {
    const root = tempDir('n');
    const fd = open(root, [], false);
    execFileSync('mkfifo', [path.join(root, 'fifo.md')]); // test setup only
    const t0 = Date.now();
    expect(code(() => n.readFile(fd, 'fifo.md', 100))).toBe('EINVAL');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(n.listDir(fd).find((e) => e.name === 'fifo.md')?.kind).toBe('other');
    mkdirSync(path.join(root, 'sub'));
    expect(code(() => n.readFile(fd, 'sub', 100))).toBe('EINVAL');
    writeFileSync(path.join(root, 'big'), 'x'.repeat(200));
    expect(code(() => n.readFile(fd, 'big', 100))).toBe('EFBIG');
    n.closeDir(fd);
  });

  it('reports a permission error with its code and the name', () => {
    const root = tempDir('n');
    mkdirSync(path.join(root, 'locked'));
    const fd = open(root, ['locked'], false);
    chmodSync(path.join(root, 'locked'), 0o500);
    try {
      let err: Error & { code?: string } = new Error('none');
      try {
        n.createExclusive(fd, '.tmp-x', Buffer.from('x'), false);
      } catch (e) {
        err = e as Error & { code?: string };
      }
      expect(err.code).toBe('EACCES');
      expect(err.message).toMatch(/EACCES: create file failed for \.tmp-x/);
    } finally {
      chmodSync(path.join(root, 'locked'), 0o700);
      n.closeDir(fd);
    }
  });
});

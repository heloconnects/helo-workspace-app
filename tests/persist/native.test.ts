// The safe_publish native helper, on real temporary folders.

import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

describe('safe_publish native helper', () => {
  it('creates folders, writes a temporary file exclusively, publishes with a no-replace link and removes the temporary file', () => {
    const root = tempDir('n');
    const fd = n.openDir(root, ['app-records', 't1', 'a1'], true);
    n.createExclusive(fd, '.tmp-w1', Buffer.from('hello'), false);
    n.linkNoReplace(fd, '.tmp-w1', 'packet.md');
    n.removeTemp(fd, '.tmp-w1');
    n.fsyncDir(fd, true); // F_FULLFSYNC path
    expect(readFileSync(path.join(root, 'app-records/t1/a1/packet.md'), 'utf8')).toBe('hello');
    expect(existsSync(path.join(root, 'app-records/t1/a1/.tmp-w1'))).toBe(false);
    expect(n.readFile(fd, 'packet.md', 100)!.toString()).toBe('hello');
    expect(n.readFile(fd, 'missing.md', 100)).toBeNull();
    expect(n.listDir(fd)).toEqual([{ name: 'packet.md', kind: 'file' }]);
    n.closeDir(fd);
  });

  it('never replaces an existing file: exclusive create and the publishing link both fail with EEXIST', () => {
    const root = tempDir('n');
    const fd = n.openDir(root, ['app-records'], true);
    writeFileSync(path.join(root, 'app-records', 'final.md'), 'someone else');
    expect(code(() => n.createExclusive(fd, 'final.md', Buffer.from('mine'), false))).toBe('EEXIST');
    n.createExclusive(fd, '.tmp-x', Buffer.from('mine'), false);
    expect(code(() => n.linkNoReplace(fd, '.tmp-x', 'final.md'))).toBe('EEXIST');
    expect(readFileSync(path.join(root, 'app-records', 'final.md'), 'utf8')).toBe('someone else');
    n.closeDir(fd);
  });

  it('a destination created by another process after the temporary file was made is never replaced', () => {
    const root = tempDir('n');
    const fd = n.openDir(root, ['app-records'], true);
    n.createExclusive(fd, '.tmp-x', Buffer.from('mine'), false);
    writeFileSync(path.join(root, 'app-records', 'record.md'), 'raced in'); // the other process
    expect(code(() => n.linkNoReplace(fd, '.tmp-x', 'record.md'))).toBe('EEXIST');
    expect(readFileSync(path.join(root, 'app-records', 'record.md'), 'utf8')).toBe('raced in');
    n.closeDir(fd);
  });

  it('refuses a symlink at the root, at any folder level, and as a file', () => {
    const real = tempDir('real');
    const elsewhere = tempDir('elsewhere');
    const link = path.join(tempDir('links'), 'root-link');
    symlinkSync(real, link);
    expect(code(() => n.openDir(link, [], false))).toBe('ELOOP');
    // A symlink in any component of the root path (O_NOFOLLOW_ANY).
    const parentLink = path.join(tempDir('links'), 'parent-link');
    symlinkSync(path.dirname(real), parentLink);
    expect(['ELOOP', 'ENOTDIR']).toContain(code(() => n.openDir(path.join(parentLink, path.basename(real)), [], false)));
    // A symlinked folder inside the tree.
    mkdirSync(path.join(real, 'app-records'));
    symlinkSync(elsewhere, path.join(real, 'app-records', 't1'));
    expect(['ELOOP', 'ENOTDIR']).toContain(code(() => n.openDir(real, ['app-records', 't1'], true)));
    // A symlink where a file is read.
    const fd = n.openDir(real, ['app-records'], false);
    writeFileSync(path.join(elsewhere, 'secret.md'), 'outside');
    symlinkSync(path.join(elsewhere, 'secret.md'), path.join(real, 'app-records', 'x.md'));
    expect(code(() => n.readFile(fd, 'x.md', 100))).toBe('ELOOP');
    expect(n.listDir(fd).find((e) => e.name === 'x.md')?.kind).toBe('other');
    expect(n.listDir(fd).find((e) => e.name === 't1')?.kind).toBe('other');
    n.closeDir(fd);
  });

  it('a folder replaced by a symlink or another folder after it was opened cannot redirect the write', () => {
    const root = tempDir('n');
    const elsewhere = tempDir('elsewhere');
    const fd = n.openDir(root, ['app-records', 't1', 'a1'], true);
    // Swap the attempt folder: move it away and put a symlink to another folder in its place.
    renameSync(path.join(root, 'app-records/t1/a1'), path.join(root, 'app-records/t1/a1-moved'));
    symlinkSync(elsewhere, path.join(root, 'app-records/t1/a1'));
    n.createExclusive(fd, '.tmp-w', Buffer.from('record'), false);
    n.linkNoReplace(fd, '.tmp-w', 'packet.md');
    n.closeDir(fd);
    expect(existsSync(path.join(elsewhere, 'packet.md'))).toBe(false);
    expect(readFileSync(path.join(root, 'app-records/t1/a1-moved/packet.md'), 'utf8')).toBe('record');
    // Replaced by a different plain folder: same result.
    const fd2 = n.openDir(root, ['app-records', 't2'], true);
    renameSync(path.join(root, 'app-records/t2'), path.join(root, 'app-records/t2-moved'));
    mkdirSync(path.join(root, 'app-records/t2'));
    n.createExclusive(fd2, '.tmp-v', Buffer.from('record'), false);
    n.closeDir(fd2);
    expect(existsSync(path.join(root, 'app-records/t2/.tmp-v'))).toBe(false);
    expect(existsSync(path.join(root, 'app-records/t2-moved/.tmp-v'))).toBe(true);
  });

  it('rejects names that are not a single plain component', () => {
    const root = tempDir('n');
    for (const bad of ['', '.', '..', 'a/b', '../x', 'a\0b']) {
      expect(code(() => n.openDir(root, [bad], true)), JSON.stringify(bad)).toBe('EINVAL');
    }
    const fd = n.openDir(root, [], false);
    for (const bad of ['..', 'x/y', '']) expect(code(() => n.createExclusive(fd, bad, Buffer.from('x'), false))).toBe('EINVAL');
    expect(code(() => n.openDir('relative/path', [], false))).toBe('EINVAL');
    n.closeDir(fd);
  });

  it('removes only its own .tmp- files', () => {
    const root = tempDir('n');
    const fd = n.openDir(root, [], false);
    writeFileSync(path.join(root, 'packet.md'), 'record');
    expect(code(() => n.removeTemp(fd, 'packet.md'))).toBe('EPERM');
    expect(existsSync(path.join(root, 'packet.md'))).toBe(true);
    mkdirSync(path.join(root, '.tmp-dir'));
    expect(code(() => n.removeTemp(fd, '.tmp-dir'))).toBe('EPERM');
    n.closeDir(fd);
  });

  it('removes a quarantined file\'s old name only when quarantine holds the very same file', () => {
    const root = tempDir('n');
    const fd = n.openDir(root, ['d'], true);
    const qfd = n.openDir(root, ['d', 'quarantine'], true);
    writeFileSync(path.join(root, 'd', 'bad.md'), 'content');
    // A different file with the same content in quarantine is not enough.
    writeFileSync(path.join(root, 'd', 'quarantine', 'copy'), 'content');
    expect(code(() => n.removeQuarantined(fd, 'bad.md', qfd, 'copy'))).toBe('EPERM');
    expect(existsSync(path.join(root, 'd', 'bad.md'))).toBe(true);
    n.linkInto(fd, 'bad.md', qfd, 'bad.md-w1');
    expect(statSync(path.join(root, 'd', 'bad.md')).ino).toBe(statSync(path.join(root, 'd', 'quarantine', 'bad.md-w1')).ino);
    n.removeQuarantined(fd, 'bad.md', qfd, 'bad.md-w1');
    expect(existsSync(path.join(root, 'd', 'bad.md'))).toBe(false);
    expect(readFileSync(path.join(root, 'd', 'quarantine', 'bad.md-w1'), 'utf8')).toBe('content');
    // linkInto never replaces either.
    writeFileSync(path.join(root, 'd', 'other.md'), 'x');
    expect(code(() => n.linkInto(fd, 'other.md', qfd, 'bad.md-w1'))).toBe('EEXIST');
    n.closeDir(fd);
    n.closeDir(qfd);
  });

  it('reports a permission error with its code and the name', () => {
    const root = tempDir('n');
    mkdirSync(path.join(root, 'locked'));
    const fd = n.openDir(root, ['locked'], false);
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

  it('reads regular files only, within a size limit', () => {
    const root = tempDir('n');
    const fd = n.openDir(root, [], false);
    mkdirSync(path.join(root, 'sub'));
    expect(code(() => n.readFile(fd, 'sub', 100))).toBe('EINVAL');
    writeFileSync(path.join(root, 'big'), 'x'.repeat(200));
    expect(code(() => n.readFile(fd, 'big', 100))).toBe('EFBIG');
    // A hard link to a file elsewhere is still just a regular file in this folder.
    const outside = tempDir('o');
    writeFileSync(path.join(outside, 'f'), 'linked');
    linkSync(path.join(outside, 'f'), path.join(root, 'hard'));
    expect(n.readFile(fd, 'hard', 100)!.toString()).toBe('linked');
    n.closeDir(fd);
  });
});

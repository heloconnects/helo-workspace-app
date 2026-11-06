// Choosing a real test folder (F2 on real disk) and the real folder view.

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTestFolder } from '../../src/persist/real-folder.js';
import { RealCloneFs } from '../../src/persist/real-fs.js';
import { cleanupTemp, GUARDS, makeTestFolder, tempDir } from './helpers.js';

afterEach(cleanupTemp);
const opts = { fullSync: false };

describe('choosing a test folder', () => {
  it('accepts a plain folder with a fictional RULES.md', () => {
    const root = makeTestFolder();
    const f = openTestFolder(root, GUARDS, opts);
    expect(f.rulesBusiness).toBe('fictional-a');
    expect(f.path).toBe(root);
    expect(Object.keys(f.files)).toEqual(['RULES.md']);
  });

  it('refuses a missing RULES.md, an unknown business, a link, a relative path, and this app\'s repository', () => {
    const noRules = tempDir('norules');
    expect(() => openTestFolder(noRules, GUARDS, opts)).toThrow(/needs a RULES\.md/);
    const realBiz = makeTestFolder('Business in this repository: Walk-Up Method\n');
    expect(() => openTestFolder(realBiz, GUARDS, opts)).toThrow(/needs a RULES\.md/);
    const target = makeTestFolder();
    const link = path.join(tempDir('l'), 'link');
    symlinkSync(target, link);
    expect(() => openTestFolder(link, GUARDS, opts)).toThrow(/not a link/);
    expect(() => openTestFolder('relative/folder', GUARDS, opts)).toThrow(/full path/);
    expect(() => openTestFolder(GUARDS.appRoot, GUARDS, opts)).toThrow(/this app's own repository/);
    expect(() => openTestFolder(path.join(GUARDS.appRoot, 'docs'), GUARDS, opts)).toThrow(/this app's own repository/);
    expect(() => openTestFolder(os.homedir(), GUARDS, opts)).toThrow(/dedicated test folder/);
  });

  it('refuses real business folder names wherever they appear (checked without touching them)', () => {
    const base = tempDir('names');
    for (const name of ['helo-walkup', 'helo-hoe']) {
      const p = path.join(base, name);
      mkdirSync(p);
      writeFileSync(path.join(p, 'RULES.md'), 'Business in this repository: Example Business A (fictional)\n');
      expect(() => openTestFolder(p, GUARDS, opts)).toThrow(/real business repository/);
    }
    const fakeHome = tempDir('home');
    const officeLike = path.join(fakeHome, 'Desktop', 'Helo', 'x');
    mkdirSync(officeLike, { recursive: true });
    writeFileSync(path.join(officeLike, 'RULES.md'), 'Business in this repository: Example Business A (fictional)\n');
    expect(() => openTestFolder(officeLike, { ...GUARDS, home: fakeHome }, opts)).toThrow(/~\/Desktop\/Helo/);
  });

  it('re-reads the path and RULES.md every time: a change is seen at once', () => {
    const root = makeTestFolder();
    const f = openTestFolder(root, GUARDS, opts);
    writeFileSync(path.join(root, 'RULES.md'), 'Business in this repository: Example Business B (fictional)\n');
    expect(f.rulesBusiness).toBe('fictional-b');
    writeFileSync(path.join(root, 'RULES.md'), 'no business line\n');
    expect(f.rulesBusiness).toBeNull();
  });
});

describe('real folder file access', () => {
  it('works only inside app-records/ and lists folders without following symlinks', () => {
    const root = makeTestFolder();
    const fs = new RealCloneFs(root, opts);
    expect(() => fs.openDir('notes')).toThrow(/only works inside app-records/);
    expect(() => fs.read('notes/untouched.md')).toThrow(/only works inside app-records/);
    const h = fs.openDir('app-records/t1/a1');
    h.createExclusive('.tmp-a', 'x');
    h.link('.tmp-a', 'packet.md');
    h.removeTemp('.tmp-a');
    h.close();
    const outside = tempDir('outside');
    writeFileSync(path.join(outside, 'secret.md'), 'outside');
    symlinkSync(outside, path.join(root, 'app-records', 't1', 'linked-folder'));
    expect(fs.list('app-records/')).toEqual(['app-records/t1/a1/packet.md', 'app-records/t1/linked-folder']);
    expect(fs.read('app-records/t1/linked-folder/secret.md')).toBeUndefined();
    expect(() => fs.externalWrite()).toThrow(/never changes records/);
  });
});

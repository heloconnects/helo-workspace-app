// Process-kill tests: the run happens in a separate Node process that is
// killed with SIGKILL at each boundary (no exception, no clean-up, database
// left open). The test then opens the leftover SQLite file and folder in a
// fresh workspace and runs start-up recovery, as relaunching the app does.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { attemptDir } from '../../src/core/records.js';
import { cleanupTemp, makeTestFolder, openWs, tempDir } from './helpers.js';

const ROOT = path.resolve(__dirname, '../..');
const CHILD = path.join(__dirname, 'kill-child.cjs');

beforeAll(() => {
  // The child runs the compiled engine: build it from the current sources first.
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', path.join(ROOT, 'tsconfig.node.json')], { cwd: ROOT });
}, 120_000);
afterEach(cleanupTemp);

function child(data: string, folder: string, point: string, drafter: string, scenario: string, mode = 'run') {
  return spawnSync(process.execPath, [CHILD, data, folder, point, drafter, scenario, mode], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
}

const CASES: [string, string, string][] = [
  ['claude', 'success', 'complete'],
  ['codex', 'success', 'complete'],
  ['claude', 'review-fails', 'failed'],
];

describe.each(CASES)('SIGKILL at every boundary (%s drafting, %s)', (drafter, scenario, expectedEnd) => {
  it('relaunch gives exactly one outcome, intact records, no temporary file, and dispatches nothing', () => {
    const listing = child(tempDir('d'), makeTestFolder(), 'list', drafter, scenario);
    expect(listing.status, listing.stderr).toBe(0);
    const points: string[] = JSON.parse(listing.stdout);
    expect(points.some((p) => p.endsWith(':mid'))).toBe(true); // inside SQL transactions too
    expect(points.length).toBeGreaterThan(scenario === "success" ? 100 : 60);
    let killed = 0;
    for (const point of points) {
      const data = tempDir('d');
      const folder = makeTestFolder();
      const r = child(data, folder, point, drafter, scenario);
      if (r.signal !== 'SIGKILL') {
        // Only points reached after the run is already settled may let the child finish.
        expect(r.stdout, `${point}: ${r.stderr}`).toBe('NOT-KILLED');
        continue;
      }
      killed += 1;
      const o = openWs(data, folder);
      o.ws.recover();
      const attempts = o.ws.t.attempts;
      if (attempts.length === 0) {
        expect(point, 'only a kill before the attempt was recorded may leave no attempt').toMatch(/^txn:attempt-create:(before|mid)$/);
        o.db.close();
        continue;
      }
      expect(attempts, point).toHaveLength(1);
      const a = attempts[0]!;
      expect(a.final, point).toBe(true);
      expect(a.state, point).toBe(a.finalizing!.outcome);
      expect(['interrupted', expectedEnd], point).toContain(a.state);
      expect(o.ws.recordState(a.id), point).toEqual({ kind: 'intact' });
      const dir = path.join(folder, attemptDir(a.taskId, a.id));
      expect(readdirSync(dir).filter((n) => n.startsWith('.tmp-')), point).toEqual([]);
      expect(readFileSync(path.join(dir, 'final-status.json'), 'utf8'), point).toBe(a.finalizing!.finalStatusBytes);
      expect(o.ws.adapters.claude.received.length + o.ws.adapters.codex.received.length, point).toBe(0);
      const snap = JSON.stringify(a);
      o.db.close();
      const again = openWs(data, folder);
      again.ws.recover();
      expect(JSON.stringify(again.ws.attempt(a.id)), point).toBe(snap);
      again.db.close();
    }
    expect(killed).toBeGreaterThan(points.length - 5);
  }, 600_000);
});

describe('SIGKILL during an outside-review save (F4)', () => {
  it('relaunch leaves exactly one consistent save state and no temporary file, at every boundary', () => {
    const listing = child(tempDir('d'), makeTestFolder(), 'list', 'claude', 'success', 'outside');
    expect(listing.status, listing.stderr).toBe(0);
    const points: string[] = JSON.parse(listing.stdout);
    expect(points).toEqual(expect.arrayContaining(['outside:tmp-written', 'outside:moved']));
    for (const point of points) {
      const data = tempDir('d');
      const folder = makeTestFolder();
      const r = child(data, folder, point, 'claude', 'success', 'outside');
      expect(r.signal, `${point}: ${r.stdout}${r.stderr}`).toBe('SIGKILL');
      const o = openWs(data, folder);
      o.ws.recover();
      const saves = o.ws.t.outsideSaves;
      const task = o.ws.t.tasks[0];
      if (!task) {
        expect(point).toMatch(/^txn:task-create:/);
        o.db.close();
        continue;
      }
      const outside = path.join(folder, 'app-records', task.id, 'outside');
      const files = existsSync(outside) ? readdirSync(outside) : [];
      expect(files.filter((n) => n.startsWith('.tmp-')), point).toEqual([]);
      expect(saves.length, point).toBeLessThanOrEqual(1);
      if (saves[0]?.state === 'published') expect(files.filter((n) => n.endsWith('.md')), point).toHaveLength(1);
      else expect(files.filter((n) => n.endsWith('.md')), point).toHaveLength(0);
      if (saves[0]) expect(['published', 'not_saved'], point).toContain(saves[0].state);
      o.db.close();
    }
  }, 300_000);
});

describe('SIGKILL during start-up recovery itself', () => {
  it('a second relaunch still gives exactly one outcome, an intact record and no temporary file', () => {
    // A state that needs real recovery work: killed after 2-review.md's temporary file was written.
    const prepare = () => {
      const data = tempDir('d');
      const folder = makeTestFolder();
      const r = child(data, folder, 'publish:2-review.md:tmp-written', 'claude', 'success');
      expect(r.signal).toBe('SIGKILL');
      return { data, folder };
    };
    const probe = prepare();
    const listing = child(probe.data, probe.folder, 'list', 'claude', 'success', 'recover');
    expect(listing.status, listing.stderr).toBe(0);
    const points: string[] = JSON.parse(listing.stdout);
    expect(points.some((p) => p.startsWith('quarantine:'))).toBe(true);
    expect(points.some((p) => p.includes('final-status.json'))).toBe(true);
    for (const q of points) {
      const { data, folder } = prepare();
      const r = child(data, folder, q, 'claude', 'success', 'recover');
      expect(r.signal, `${q}: ${r.stdout}${r.stderr}`).toBe('SIGKILL');
      const o = openWs(data, folder);
      o.ws.recover();
      const a = o.ws.t.attempts[0]!;
      expect(a.state, q).toBe('interrupted');
      expect(a.final, q).toBe(true);
      expect(o.ws.recordState(a.id), q).toEqual({ kind: 'intact' });
      const dir = path.join(folder, attemptDir(a.taskId, a.id));
      expect(readdirSync(dir).filter((n) => n.startsWith('.tmp-')), q).toEqual([]);
      expect(readFileSync(path.join(dir, 'final-status.json'), 'utf8'), q).toBe(a.finalizing!.finalStatusBytes);
      o.db.close();
    }
  }, 300_000);
});

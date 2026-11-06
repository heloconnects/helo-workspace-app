// Process-kill tests: the run happens in a separate Node process that is
// killed with SIGKILL at each boundary (no exception, no clean-up, database
// left open). The test then opens the leftover SQLite file and folder in a
// fresh workspace and runs start-up recovery, as relaunching the app does.

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
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

function child(data: string, folder: string, point: string, drafter: string, scenario: string) {
  return spawnSync(process.execPath, [CHILD, data, folder, point, drafter, scenario], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
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

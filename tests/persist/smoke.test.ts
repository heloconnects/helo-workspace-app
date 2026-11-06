import { afterEach, expect, it } from 'vitest';
import { attemptDir } from '../../src/core/records.js';
import { cleanupTemp, makeTestFolder, openWs, tempDir } from './helpers.js';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

afterEach(cleanupTemp);

it('runs a task with real files and SQLite, and survives a reopen', async () => {
  const folder = makeTestFolder();
  const data = tempDir('data');
  const { ws, db, project } = openWs(data, folder);
  const t = ws.createTask({ projectId: project.id, title: 'Made-up', brief: 'Example brief.', acceptanceCriteria: ['Example criterion'], sourceIds: [], drafter: 'claude', scenarioId: 'success-issues', scenario: { draft: 'ok', review: 'ok', synthesis: 'ok' } });
  const at = ws.startAttempt({ taskId: t.id, approvedPacketHash: t.packetHash, idempotencyKey: 'k1', acknowledgePriorStopped: false });
  await ws.settled(at.id);
  expect(ws.attempt(at.id).state).toBe('complete');
  const dir = path.join(folder, attemptDir(t.id, at.id));
  console.log(readdirSync(dir).sort());
  expect(readdirSync(dir).sort()).toHaveLength(9);
  db.close();
  const again = openWs(data, folder);
  again.ws.recover();
  expect(again.ws.attempt(at.id).state).toBe('complete');
  expect(again.ws.recordState(at.id)).toEqual({ kind: 'intact' });
  expect(JSON.parse(readFileSync(path.join(dir, 'final-status.json'), 'utf8')).outcome).toBe('complete');
  again.db.close();
});

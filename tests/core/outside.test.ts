// F4: outside reviews, numbering, collisions and recovery.

import { describe, expect, it } from 'vitest';
import { SimulatedCrash } from '../../src/core/sim-store.js';
import { makeTask, makeWorkspace, runToEnd } from './helpers.js';

function setup() {
  const { ws, a } = makeWorkspace();
  const t = makeTask(ws, a.id, 'claude');
  return { ws, t, fs: ws.cloneOf(a.id), dir: `app-records/${t.id}/outside` };
}

describe('outside reviews (F4)', () => {
  it('saves numbered files with the fixed first line, never as a provider stage', async () => {
    const { ws, t, fs, dir } = setup();
    const at = await runToEnd(ws, t.id);
    const before = JSON.stringify(ws.attempt(at.id));
    const s1 = ws.saveOutsideReview({ taskId: t.id, source: 'chatgpt', text: 'Made-up review one.' });
    const s2 = ws.saveOutsideReview({ taskId: t.id, source: 'claude-app', text: 'Made-up review two.' });
    expect(s1.number).toBe(1);
    expect(s2.number).toBe(2);
    const files = fs.list(`${dir}/`);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/\/1-chatgpt-\d{4}-\d{2}-\d{2}\.md$/);
    expect(files[1]).toMatch(/\/2-claude-app-\d{4}-\d{2}-\d{2}\.md$/);
    expect(fs.read(files[0]!)!.split('\n')[0]).toBe('Pasted by Ahmed; source not verified by the app');
    // Never changes any attempt's state or files.
    expect(JSON.stringify(ws.attempt(at.id))).toBe(before);
    expect(ws.t.artifacts.filter((x) => x.attemptId === at.id)).toHaveLength(3);
  });

  it('moves to the next number when the numbered name already exists', () => {
    const { ws, t, fs, dir } = setup();
    const date = new Date().toISOString().slice(0, 10);
    fs.externalWrite(`${dir}/1-chatgpt-${date}.md`, 'someone else');
    fs.externalWrite(`${dir}/2-chatgpt-${date}.md`, 'someone else again');
    const s = ws.saveOutsideReview({ taskId: t.id, source: 'chatgpt', text: 'Made-up review.' });
    expect(s.number).toBe(3);
    expect(fs.read(`${dir}/1-chatgpt-${date}.md`)).toBe('someone else');
  });

  it('recovers a crash after the no-replace move, before the database records it', () => {
    const { ws, t, fs, dir } = setup();
    ws.hooks.arm('outside:moved');
    expect(() => ws.saveOutsideReview({ taskId: t.id, source: 'chatgpt', text: 'Made-up.' })).toThrow(SimulatedCrash);
    ws.crash('outside:moved');
    ws.recover();
    const save = ws.t.outsideSaves[0]!;
    expect(save.state).toBe('published');
    expect(fs.list(`${dir}/.tmp-`)).toEqual([]); // the move leaves no temporary file
    expect(fs.list(`${dir}/quarantine/`)).toEqual([]);
  });

  it('recovers a crash before the link as "not saved" and asks for the paste again', () => {
    const { ws, t, fs, dir } = setup();
    ws.hooks.arm('outside:tmp-written');
    expect(() => ws.saveOutsideReview({ taskId: t.id, source: 'claude-app', text: 'Made-up.' })).toThrow(SimulatedCrash);
    ws.recover();
    expect(ws.t.outsideSaves[0]!.state).toBe('not_saved');
    expect(fs.list(`${dir}/`).filter((p) => !p.includes('/quarantine/'))).toEqual([]);
  });

  it('recovers a crash after the database records published (leftover temp file of a successful save is quarantined)', () => {
    const { ws, t, fs, dir } = setup();
    ws.hooks.arm('txn:outside:published:after');
    expect(() => ws.saveOutsideReview({ taskId: t.id, source: 'chatgpt', text: 'Made-up.' })).toThrow(SimulatedCrash);
    fs.externalWrite(`${dir}/.tmp-o-stray`, 'stray');
    ws.recover();
    expect(ws.t.outsideSaves[0]!.state).toBe('published');
    expect(fs.list(`${dir}/.tmp-`)).toEqual([]);
    expect(fs.list(`${dir}/quarantine/`).some((p) => p.endsWith('.tmp-o-stray-o-stray'))).toBe(true);
  });

  it('shows a published save whose file was changed or removed as damaged, with mismatched content quarantined', () => {
    const { ws, t, fs, dir } = setup();
    const a = ws.saveOutsideReview({ taskId: t.id, source: 'chatgpt', text: 'Made-up A.' });
    const b = ws.saveOutsideReview({ taskId: t.id, source: 'chatgpt', text: 'Made-up B.' });
    fs.externalWrite(ws.outsidePath(a), 'changed');
    fs.externalDelete(ws.outsidePath(b));
    ws.recover();
    expect(ws.t.outsideSaves.find((s) => s.saveId === a.saveId)!.damaged).toMatch(/quarantine/);
    expect(ws.t.outsideSaves.find((s) => s.saveId === b.saveId)!.damaged).toMatch(/missing/);
    expect(fs.list(`${dir}/quarantine/`)).toHaveLength(1);
    // Repeatable.
    ws.recover();
    expect(fs.list(`${dir}/quarantine/`)).toHaveLength(1);
  });

  it('survives a crash during the quarantine move and repeats it safely', () => {
    const { ws, t, fs, dir } = setup();
    ws.hooks.arm('outside:tmp-written');
    expect(() => ws.saveOutsideReview({ taskId: t.id, source: 'chatgpt', text: 'Made-up.' })).toThrow(SimulatedCrash);
    ws.hooks.arm('quarantine:.tmp:moved');
    expect(() => ws.recover()).toThrow(SimulatedCrash);
    ws.recover();
    expect(fs.list(`${dir}/.tmp-`)).toEqual([]);
    expect(fs.list(`${dir}/quarantine/`)).toHaveLength(1);
    expect(ws.t.outsideSaves[0]!.state).toBe('not_saved');
  });
});

import { describe, expect, it } from 'vitest';
import { Workspace } from '../../src/core/engine.js';
import { seedWorkspace } from '../../src/core/seed.js';
import { Service } from '../../src/core/service.js';
import { FAST } from './helpers.js';

describe('seeded showcase', () => {
  it('produces every required state using the real (simulated) engine', async () => {
    const ws = new Workspace({ timing: FAST });
    await seedWorkspace(ws);
    const svc = new Service(ws);
    const displays = ws.t.tasks.map((t) => {
      const v = svc.taskView(t.id);
      return [t.title, v.attempts.map((a) => a.display).join(' | ')];
    });
    console.log(displays.map((d) => d.join(' => ')).join('\n'));
    const all = displays.map((d) => d[1]).join('\n');
    for (const s of [
      'Workflow complete — unresolved issues remain',
      'Workflow complete — no issues reported',
      'Needs attention',
      'Failed',
      'Cancelled',
      'Cancellation unconfirmed',
      'Complete — record damaged',
      'Interrupted',
    ]) expect(all).toContain(s);
  });
});

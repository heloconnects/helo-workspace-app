// @vitest-environment jsdom
// Interface tests: the real React app, driven through the same operation
// layer the Electron main process uses, with fake adapters only.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace, type EngineTiming } from '../../src/core/engine.js';
import { seedWorkspace } from '../../src/core/seed.js';
import { Service } from '../../src/core/service.js';
import { App } from '../../src/renderer/App.js';
import { API_METHODS, type HeloBridge } from '../../src/shared/api.js';
import { SIMULATION_BANNER } from '../../src/shared/types.js';

const UI_TEST_TIMING: EngineTiming = { responseMs: 5, lateResultMs: 300, stageTimeoutMs: 2000, attemptLimitMs: 10000, cancelGraceMs: 100 };

function bridgeFor(ws: Workspace): HeloBridge {
  const svc = new Service(ws);
  const api: Record<string, unknown> = {};
  for (const m of API_METHODS) api[m] = (arg?: unknown) => svc.dispatch(m, arg);
  api.onChanged = (cb: () => void) => ws.onChange(cb);
  return api as unknown as HeloBridge;
}

let ws: Workspace;

beforeEach(async () => {
  ws = new Workspace({ timing: UI_TEST_TIMING, onCrash: () => setTimeout(() => ws.restartIfCrashed(), 5) });
  await seedWorkspace(ws);
  render(<App api={bridgeFor(ws)} />);
  await screen.findAllByTestId('project-row');
});

afterEach(async () => {
  cleanup();
  await ws.idle();
});

const user = () => userEvent.setup();

function nav(name: string) {
  return within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name });
}

async function openProject(name: string) {
  await user().click(nav('Projects'));
  await user().click(await screen.findByRole('button', { name }));
  await screen.findByRole('heading', { level: 1, name });
}

async function openTask(title: string) {
  await openProject('Example Project A');
  if (!screen.queryByRole('button', { name: title })) await openProject('Example Project B');
  await user().click(await screen.findByRole('button', { name: title }));
  await screen.findByRole('heading', { level: 1, name: title });
}

function expectBanner() {
  const banner = screen.getByTestId('sim-banner');
  expect(banner.textContent).toBe(SIMULATION_BANNER);
}

describe('simulated app interface', () => {
  it('shows the simulation banner on every screen', async () => {
    expectBanner();
    await openProject('Example Project A');
    expectBanner();
    await user().click(screen.getByRole('button', { name: 'Example: complete, unresolved issues remain' }));
    await screen.findByRole('heading', { level: 1, name: 'Example: complete, unresolved issues remain' });
    expectBanner();
    await user().click(nav('Connection'));
    await screen.findByRole('heading', { level: 1, name: 'Connection' });
    expectBanner();
  });

  it('lists the two fictional projects and refuses a second project for the same business', async () => {
    const rows = screen.getAllByTestId('project-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Example Business A (fictional)');
    await user().type(screen.getByLabelText('Project name'), 'Example Project C');
    await user().click(screen.getByLabelText(/I confirm which GitHub repository/));
    await user().click(screen.getByRole('button', { name: 'Register project' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/One project per business/);
  });

  it('composer defaults to Claude drafting and Codex reviewing; switching shows the other order on the sharing preview', async () => {
    await openProject('Example Project A');
    expect(screen.getByLabelText(/Anthropic \(Claude\) drafts \(default\)/)).toHaveProperty('checked', true);
    expect(screen.getByTestId('role-summary').textContent).toBe(
      'Drafter: Anthropic (Claude) · Reviewer: OpenAI (Codex) (always the other provider) · Synthesis: Anthropic (Claude)',
    );
    await waitFor(() =>
      expect(screen.getByTestId('sharing-sentence').textContent).toBe(
        "Anthropic (Claude) receives P; OpenAI (Codex) receives P and Claude's draft; Anthropic receives P, the draft and Codex's review.",
      ),
    );
    await user().click(screen.getByLabelText(/OpenAI \(Codex\) drafts/));
    await waitFor(() =>
      expect(screen.getByTestId('sharing-sentence').textContent).toBe(
        "OpenAI (Codex) receives P; Anthropic (Claude) receives P and Codex's draft; OpenAI receives P, the draft and Claude's review.",
      ),
    );
  });

  it('creates a task, shows the sharing screen, runs it and shows three provider-labelled outputs with export-only wording', async () => {
    await openProject('Example Project A');
    await user().type(screen.getByLabelText('Title'), 'UI test made-up task');
    await user().type(screen.getByLabelText('Brief'), 'Example brief for a made-up task.');
    await user().type(screen.getByLabelText('Acceptance criteria (one per line)'), 'Example criterion');
    await user().click(screen.getByLabelText(/notes\/example-notes\.md/));
    await user().click(screen.getByRole('button', { name: 'Create task and review sharing' }));
    await screen.findByRole('heading', { level: 1, name: 'UI test made-up task' });
    expect(screen.getByRole('heading', { name: 'Sharing screen: review before the first attempt' })).toBeTruthy();
    await user().click(screen.getByRole('button', { name: 'Approve sharing and start (simulated)' }));
    const attempt = await screen.findByTestId('attempt');
    await waitFor(() => expect(within(attempt).getByTestId('status-badge').textContent).toBe('Workflow complete — unresolved issues remain'), { timeout: 4000 });
    expect(within(attempt).getByTestId('stage-draft-provider').textContent).toBe('Produced by Anthropic (Claude) — simulated adapter');
    expect(within(attempt).getByTestId('stage-review-provider').textContent).toBe('Produced by OpenAI (Codex) — simulated adapter');
    expect(within(attempt).getByTestId('stage-synthesis-provider').textContent).toBe('Produced by Anthropic (Claude) — simulated adapter');
    expect(within(attempt).getAllByText('Dispatch confirmed')).toHaveLength(3);
    expect(within(attempt).getByText(/Example draft for a made-up task/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Review results and export' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Task record — saved by the app' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Proposed changes — text only' })).toBeTruthy();
    await user().click(screen.getByRole('button', { name: 'Export artifacts' }));
    expect(await screen.findByText(/Export is simulated: no save dialog opens and no file is written/)).toBeTruthy();
    for (const word of [/^Apply/, /^Merge/, /^Approve changes/]) expect(screen.queryByRole('button', { name: word })).toBeNull();
  });

  it('shows every outcome and record-state display from the showcase tasks', async () => {
    const cases: [string, string][] = [
      ['Example: complete, no issues reported', 'Workflow complete — no issues reported'],
      ['Example: needs attention (unmet criterion)', 'Needs attention'],
      ['Example: failed (reviewer process fails)', 'Failed'],
      ['Example: cancelled by the user', 'Cancelled'],
      ['Example: cancellation unconfirmed', 'Cancellation unconfirmed'],
      ['Example: Complete — record damaged', 'Complete — record damaged'],
      ['Example: interrupted (app crash after review dispatch)', 'Interrupted'],
      ['Example: final-status.json not on disk', 'Complete — record damaged'],
    ];
    for (const [title, display] of cases) {
      await openTask(title);
      const attempt = await screen.findByTestId('attempt');
      expect(within(attempt).getByTestId('status-badge').textContent, title).toBe(display);
    }
    // Details behind some of them.
    await openTask('Example: Complete — record damaged');
    expect(screen.getAllByTestId('record-damaged')[0]!.textContent).toMatch(/2-review\.md.*file is missing/);
    await openTask('Example: final-status.json not on disk');
    expect(screen.getAllByTestId('record-damaged')[0]!.textContent).toMatch(/final-status file not on disk: ENOSPC/);
    await openTask('Example: interrupted (app crash after review dispatch)');
    expect(within(screen.getByTestId('stage-review')).getByText('Dispatch uncertain')).toBeTruthy();
    expect(screen.getByText(/An earlier attempt may still have a provider stage running/)).toBeTruthy();
    expect(within(screen.getByTestId('stage-review')).getByText('Not confirmed stopped')).toBeTruthy();
    await openTask('Example: cancellation unconfirmed');
    expect(screen.getAllByText(/Retry is blocked until this is resolved/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Approve sharing and start new attempt/ })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Late results \(quarantined, never used\)/)).toBeTruthy();
    await user().click(screen.getByRole('button', { name: /Resolve: I confirmed the owned process stopped/ }));
    await waitFor(() => expect(within(screen.getByTestId('attempt')).getByTestId('status-badge').textContent).toBe('Cancelled'));
    await openTask('Example: failed (synthesis omits a finding)');
    expect(screen.getByText(/Output rejected \(not shown as a result and not forwarded\): synthesis does not account for review finding/)).toBeTruthy();
  });

  it('shows the sharing screen for the Codex-drafts role order', async () => {
    await openTask('Example: Codex drafts, Claude reviews');
    expect(screen.getByTestId('task-roles').textContent).toBe('Drafter: OpenAI (Codex) · Reviewer: Anthropic (Claude) · Synthesis: OpenAI (Codex)');
    expect(screen.getByTestId('sharing-sentence').textContent).toBe(
      "OpenAI (Codex) receives P; Anthropic (Claude) receives P and Codex's draft; OpenAI receives P, the draft and Claude's review.",
    );
    expect(screen.getByTestId('stage-draft-provider').textContent).toBe('Produced by OpenAI (Codex) — simulated adapter');
    expect(screen.getByTestId('stage-review-provider').textContent).toBe('Produced by Anthropic (Claude) — simulated adapter');
  });

  it('shows the F5 inventory with its warning, and saves a pasted outside review', async () => {
    await openTask('Example: complete, unresolved issues remain');
    expect(screen.getByTestId('inventory-warning').textContent).toMatch(/everyone with access to the repository can read them/);
    expect(screen.getAllByTestId('inventory-row')).toHaveLength(9);
    await user().type(screen.getByLabelText('Pasted review'), 'Example outside review text, made up.');
    await user().click(screen.getByRole('button', { name: 'Save outside review' }));
    const saved = await screen.findByTestId('outside-review');
    expect(saved.textContent).toMatch(/Pasted by Ahmed; source not verified by the app/);
    expect(saved.textContent).toMatch(/1-chatgpt-\d{4}-\d{2}-\d{2}\.md/);
    await waitFor(() => expect(screen.getAllByTestId('inventory-row')).toHaveLength(10));
    expect(screen.getAllByTestId('inventory-row').some((r) => /Outside review/.test(r.textContent ?? ''))).toBe(true);
  });

  it('cancels a running attempt from the interface', async () => {
    await openProject('Example Project A');
    await user().type(screen.getByLabelText('Title'), 'UI cancel made-up task');
    await user().type(screen.getByLabelText('Brief'), 'Example brief.');
    await user().type(screen.getByLabelText('Acceptance criteria (one per line)'), 'Example criterion');
    await user().selectOptions(screen.getByLabelText('Simulation scenario'), 'slow-review');
    await user().click(screen.getByRole('button', { name: 'Create task and review sharing' }));
    await user().click(await screen.findByRole('button', { name: 'Approve sharing and start (simulated)' }));
    const attempt = await screen.findByTestId('attempt');
    await waitFor(() => expect(within(attempt).getByTestId('status-badge').textContent).toBe('Reviewing'));
    await user().click(within(attempt).getByRole('button', { name: 'Cancel attempt' }));
    await waitFor(() => expect(within(screen.getByTestId('attempt')).getByTestId('status-badge').textContent).toBe('Cancelled'));
  });

  it('simulated crash and restart marks running work interrupted, through the interface', async () => {
    await openProject('Example Project A');
    await user().type(screen.getByLabelText('Title'), 'UI crash made-up task');
    await user().type(screen.getByLabelText('Brief'), 'Example brief.');
    await user().type(screen.getByLabelText('Acceptance criteria (one per line)'), 'Example criterion');
    await user().selectOptions(screen.getByLabelText('Simulation scenario'), 'slow-review');
    await user().click(screen.getByRole('button', { name: 'Create task and review sharing' }));
    await user().click(await screen.findByRole('button', { name: 'Approve sharing and start (simulated)' }));
    await waitFor(() => expect(within(screen.getByTestId('attempt')).getByTestId('status-badge').textContent).toBe('Reviewing'));
    await user().click(screen.getByRole('button', { name: 'Simulate app crash and restart' }));
    await waitFor(() => expect(within(screen.getByTestId('attempt')).getByTestId('status-badge').textContent).toBe('Interrupted'));
    // The seeded "cancellation unconfirmed" attempt is also still active, so it is interrupted too.
    expect(screen.getByText(/recovery marked 2 attempt\(s\) interrupted/)).toBeTruthy();
  });

  it('shows the connection page as simulated and every checklist row unverified', async () => {
    await user().click(nav('Connection'));
    await screen.findByRole('heading', { level: 1, name: 'Connection' });
    expect(screen.getAllByText(/Not connected to any real service/)).toHaveLength(2);
    const table = screen.getByRole('table', { name: 'Compatibility checklist' });
    const cells = within(table).getAllByRole('cell').filter((_, i) => i % 3 !== 0);
    expect(cells).toHaveLength(18);
    for (const c of cells) expect(c.textContent).toMatch(/^UNVERIFIED/);
    expect(within(table).getAllByText('UNVERIFIED — BLOCKER')).toHaveLength(2);
  });
});

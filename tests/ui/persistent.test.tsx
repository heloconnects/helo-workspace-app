// @vitest-environment jsdom
// The interface in persistent mode, driving the real engine with a real
// temporary test folder and a real SQLite file.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Service } from '../../src/core/service.js';
import { addTestFolder, openPersistentWorkspace } from '../../src/persist/index.js';
import { App } from '../../src/renderer/App.js';
import { API_METHODS, type HeloBridge } from '../../src/shared/api.js';
import { cleanupTemp, GUARDS, makeTestFolder, tempDir } from '../persist/helpers.js';

afterEach(() => {
  cleanup();
  cleanupTemp();
});

describe('persistent mode interface', () => {
  it('chooses a test folder through the main-process picker, registers it, runs a task and writes real records', async () => {
    const folder = makeTestFolder();
    const data = tempDir('data');
    const { ws, db } = openPersistentWorkspace({
      dataDir: data,
      timing: { responseMs: 5, lateResultMs: 300, stageTimeoutMs: 2000, attemptLimitMs: 10000, cancelGraceMs: 100 },
      fullSync: false,
    });
    const svc = new Service(ws, { mode: 'persistent', dataDir: data, pickFolder: async () => folder, addFolder: (p) => addTestFolder(ws, p, GUARDS, false) });
    const api: Record<string, unknown> = {};
    for (const m of API_METHODS) api[m] = (arg?: unknown) => svc.dispatch(m, arg);
    api.onChanged = (cb: () => void) => ws.onChange(cb);
    render(<App api={api as unknown as HeloBridge} />);
    const user = userEvent.setup();

    expect((await screen.findByTestId('mode-line')).textContent).toMatch(/Persistent mode/);
    expect(screen.getByTestId('sim-banner').textContent).toBe('SIMULATION: no real AI calls');
    await user.click(screen.getByRole('button', { name: 'Choose test folder…' }));
    await waitFor(() => expect(screen.getByLabelText('Test folder')).toHaveProperty('value', expect.stringMatching(/^real:/)));
    await user.type(screen.getByLabelText('Project name'), 'My fictional test folder');
    await user.click(screen.getByLabelText(/I confirm which GitHub repository/));
    await user.click(screen.getByRole('button', { name: 'Register project' }));
    await user.click(await screen.findByRole('button', { name: 'My fictional test folder' }));
    expect(screen.getByText(/Importing files from a real test folder is not part of persistence v1/)).toBeTruthy();
    await user.type(screen.getByLabelText('Title'), 'Made-up task in a real folder');
    await user.type(screen.getByLabelText('Brief'), 'Example brief.');
    await user.type(screen.getByLabelText('Acceptance criteria (one per line)'), 'Example criterion');
    await user.click(screen.getByRole('button', { name: 'Create task and review sharing' }));
    await user.click(await screen.findByRole('button', { name: 'Approve sharing and start (simulated)' }));
    await waitFor(() => expect(within(screen.getByTestId('attempt')).getByTestId('status-badge').textContent).toBe('Workflow complete — unresolved issues remain'), { timeout: 5000 });
    // Real files on disk, listed in the inventory with full paths.
    const taskDir = path.join(folder, 'app-records', ws.t.tasks[0]!.id);
    const attemptFolder = readdirSync(taskDir)[0]!;
    expect(readdirSync(path.join(taskDir, attemptFolder))).toHaveLength(9);
    await waitFor(() => expect(screen.getAllByTestId('inventory-row')).toHaveLength(9));
    expect(screen.getByText(new RegExp(`${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/app-records/`))).toBeTruthy();
    // No record-damaging control in persistent mode.
    expect(screen.queryByRole('button', { name: 'Damage record file' })).toBeNull();
    expect(screen.getByText(/the app never changes its own records/)).toBeTruthy();
    await ws.idle();
    db.close();
  });
});

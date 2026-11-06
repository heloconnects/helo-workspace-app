// Electron main process. Fake adapters only: nothing here starts a provider
// program or opens a network connection.
//
// Two modes:
//   persistent (default): run state in a SQLite store in the app data folder;
//     task records written as files, through the safe_publish native helper,
//     into a fictional test folder Ahmed chooses.
//   showcase (--showcase): the in-memory simulation with example tasks.

import { app, BrowserWindow, dialog, ipcMain, protocol, session, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { API_METHODS, IPC_CHANGED_CHANNEL, IPC_CHANNEL_PREFIX } from '../shared/api.js';
import { SIMULATION_BANNER } from '../shared/types.js';
import { UI_TIMING, Workspace } from '../core/engine.js';
import { seedWorkspace, SEED_TIMING } from '../core/seed.js';
import { Service } from '../core/service.js';
import { addTestFolder, openPersistentWorkspace } from '../persist/index.js';
import {
  APP_ENTRY,
  APP_SCHEME,
  CSP,
  isAllowedRequest,
  isTrustedSender,
  MAX_IPC_ARG_BYTES,
  REQUIRED_LIVE_PREFERENCES,
  resolveAppFile,
  webPreferences,
} from './security.js';

const SMOKE = process.argv.includes('--smoke-test');
const SMOKE_PERSIST = process.argv.includes('--smoke-persist');
const SHOWCASE = process.argv.includes('--showcase') || SMOKE;
const MODE: 'showcase' | 'persistent' = SHOWCASE ? 'showcase' : 'persistent';
const APP_ROOT = path.join(__dirname, '..', '..');
const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

// No production remote debugging.
if (app.commandLine.hasSwitch('remote-debugging-port') || app.commandLine.hasSwitch('inspect')) {
  console.error('Refusing to start with remote debugging enabled.');
  app.exit(1);
}

// Persistent mode: only one copy of the app may use the run-state store at a time.
if (MODE === 'persistent' && !SMOKE_PERSIST && !app.requestSingleInstanceLock()) {
  console.error('Helo Workspace is already running.');
  app.exit(0);
}

app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);

let mainWindow: BrowserWindow | null = null;
let workspace: Workspace;
let service: Service;

function hardenContents(contents: WebContents): void {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-redirect', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function trustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return isTrustedSender({
    senderIsAppWindow: !!mainWindow && event.sender === mainWindow.webContents,
    frameIsMainFrame: !!mainWindow && !!frame && frame === mainWindow.webContents.mainFrame,
    frameUrl: frame?.url,
  });
}

function registerIpc(): void {
  for (const method of API_METHODS) {
    ipcMain.handle(`${IPC_CHANNEL_PREFIX}${method}`, async (event, arg: unknown) => {
      if (!trustedSender(event)) return { ok: false, error: 'Rejected: request did not come from the app window.' };
      let size = 0;
      try {
        size = Buffer.byteLength(JSON.stringify(arg ?? null), 'utf8');
      } catch {
        return { ok: false, error: 'Rejected input: not serialisable.' };
      }
      if (size > MAX_IPC_ARG_BYTES) return { ok: false, error: 'Rejected input: too large.' };
      return service.dispatch(method, arg);
    });
  }
}

function hardenSession(): void {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.on('will-download', (e) => e.preventDefault());
  s.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAllowedRequest(details.url) }));
  s.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });
  protocol.handle(APP_SCHEME, async (request) => {
    const resolved = resolveAppFile(request.url, RENDERER_ROOT);
    if (!resolved) return new Response('Not found', { status: 404 });
    try {
      const body = await readFile(resolved.file);
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': resolved.contentType, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: `Helo Workspace (${MODE}) — ${SIMULATION_BANNER}`,
    show: !SMOKE && !SMOKE_PERSIST,
    webPreferences: webPreferences(PRELOAD, !app.isPackaged && process.env.HELO_DEVTOOLS === '1'),
  });
  mainWindow.on('page-title-updated', (e) => e.preventDefault());
  let pending = false;
  workspace.onChange(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANGED_CHANNEL);
    }, 50);
  });
  await mainWindow.loadURL(APP_ENTRY);
}

async function smokeTest(): Promise<void> {
  const wc = mainWindow!.webContents;
  await new Promise((r) => setTimeout(r, 1500));
  const windowsBefore = BrowserWindow.getAllWindows().length;
  // Behavioural checks run inside the page. Every target is the app's own origin, so a
  // guard that failed would still cause no network traffic.
  const report = await wc.executeJavaScript(`(async () => {
    const r = {
      banner: document.body.innerText.includes(${JSON.stringify(SIMULATION_BANNER)}),
      hasRequire: typeof require !== 'undefined',
      hasProcess: typeof process !== 'undefined',
      heloKeys: Object.keys(window.helo || {}).sort(),
      projects: document.querySelectorAll('[data-testid="project-row"]').length,
    };
    try { r.windowOpenResult = window.open('app://helo/index.html') === null ? 'denied' : 'opened'; } catch (e) { r.windowOpenResult = 'threw'; }
    try { eval('1'); r.evalBlocked = false; } catch (e) { r.evalBlocked = true; }
    try { await fetch('app://helo/index.html'); r.fetchBlocked = false; } catch (e) { r.fetchBlocked = true; }
    try { const p = await Notification.requestPermission(); r.notificationPermission = p; } catch (e) { r.notificationPermission = 'threw'; }
    const unknown = await window.helo.getTask({ taskId: 42 });
    r.badInputRejected = unknown && unknown.ok === false;
    setTimeout(() => { location.href = 'app://helo/elsewhere.html'; }, 0);
    return r;
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  const prefs = (wc as unknown as { getLastWebPreferences?: () => Record<string, unknown> }).getLastWebPreferences?.() ?? {};
  const out = {
    ...report,
    locationAfterNavigationAttempt: wc.getURL(),
    windowsBefore,
    windowsAfter: BrowserWindow.getAllWindows().length,
    contextIsolation: prefs.contextIsolation,
    sandbox: prefs.sandbox,
    nodeIntegration: prefs.nodeIntegration,
    webSecurity: prefs.webSecurity,
    electron: process.versions.electron,
  };
  console.log('SMOKE ' + JSON.stringify(out));
  const prefsOk = (Object.keys(REQUIRED_LIVE_PREFERENCES) as (keyof typeof REQUIRED_LIVE_PREFERENCES)[]).every(
    (k) => out[k] === REQUIRED_LIVE_PREFERENCES[k],
  );
  const failures = [
    !out.banner && 'banner missing',
    out.hasRequire && 'require visible in page',
    out.hasProcess && 'process visible in page',
    out.projects < 2 && 'projects not shown',
    !prefsOk && 'security preferences differ',
    out.windowOpenResult !== 'denied' && 'window.open not denied',
    out.windowsAfter !== out.windowsBefore && 'a new window was created',
    !out.evalBlocked && 'eval not blocked by CSP',
    !out.fetchBlocked && 'fetch not blocked by CSP',
    out.notificationPermission !== 'denied' && `permission request not denied (${out.notificationPermission})`,
    !out.badInputRejected && 'bad input accepted',
    out.locationAfterNavigationAttempt !== APP_ENTRY && 'navigation not prevented',
  ].filter(Boolean);
  console.log(failures.length ? 'SMOKE FAILED: ' + failures.join('; ') : 'SMOKE PASSED');
  app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(async () => {
  const onCrash = () => setTimeout(() => workspace.restartIfCrashed(), 300);
  if (MODE === 'showcase') {
    // A simulated crash restarts the (simulated) app straight away: recovery runs over the durable records.
    workspace = new Workspace({ timing: UI_TIMING, onCrash });
    service = new Service(workspace, { mode: 'showcase' });
    await seedWorkspace(workspace);
  } else {
    // The persistent smoke test uses its own temporary data folder; the app otherwise uses its own data folder.
    const dataDir = SMOKE_PERSIST && process.env.HELO_DATA_DIR ? process.env.HELO_DATA_DIR : app.getPath('userData');
    workspace = openPersistentWorkspace({ dataDir, timing: UI_TIMING, fullSync: true, onCrash }).ws;
    // Every start: recovery (F3). Anything still running when the app last stopped becomes interrupted.
    workspace.recover();
    const guards = { appRoot: APP_ROOT, home: os.homedir() };
    service = new Service(workspace, {
      mode: 'persistent',
      dataDir,
      pickFolder: async () => {
        const r = await dialog.showOpenDialog(mainWindow!, {
          title: 'Choose a fictional test folder (never a real repository)',
          properties: ['openDirectory', 'createDirectory'],
        });
        return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
      },
      addFolder: (chosen) => addTestFolder(workspace, chosen, guards, true),
    });
  }
  hardenSession();
  registerIpc();
  await createWindow();
  if (SMOKE) await smokeTest();
  if (SMOKE_PERSIST) await smokePersist();
});

/**
 * Persistent smoke test, run by scripts/smoke-persist.mjs in two launches.
 * Phase "run": register the temporary test folder, complete one attempt, start a second
 * and quit while it is still reviewing. Phase "verify": after the relaunch (and its
 * recovery), report what survived.
 */
async function smokePersist(): Promise<void> {
  const phase = process.env.HELO_SMOKE_PHASE;
  const folder = process.env.HELO_TEST_FOLDER ?? '';
  const ws = workspace;
  const report: Record<string, unknown> = { phase, electron: process.versions.electron };
  if (phase === 'run') {
    ws.setTiming({ ...SEED_TIMING, lateResultMs: 60_000, stageTimeoutMs: 60_000 });
    const folderId = addTestFolder(ws, folder, { appRoot: APP_ROOT, home: os.homedir() }, true);
    const p = ws.registerProject({ folderId, business: 'fictional-a', name: 'Smoke test folder', repoConfirmed: true });
    const mk = (title: string, scenarioId: string, review: 'ok' | 'late-result-after-cancel') =>
      ws.createTask({
        projectId: p.id,
        title,
        brief: 'Example brief for a made-up smoke-test task.',
        acceptanceCriteria: ['Example criterion'],
        sourceIds: [],
        drafter: 'claude',
        scenarioId,
        scenario: { draft: 'ok', review, synthesis: 'ok' },
      });
    const done = mk('Smoke: completes', 'success-issues', 'ok');
    const a = ws.startAttempt({ taskId: done.id, approvedPacketHash: done.packetHash, idempotencyKey: 'smoke-a', acknowledgePriorStopped: false });
    await ws.settled(a.id);
    const running = mk('Smoke: quit while reviewing', 'slow-review', 'late-result-after-cancel');
    const b = ws.startAttempt({ taskId: running.id, approvedPacketHash: running.packetHash, idempotencyKey: 'smoke-b', acknowledgePriorStopped: false });
    while (!(ws.attempt(b.id).state === 'reviewing' && ws.dispatchStatus(b.id, 'review') === 'confirmed')) await new Promise((r) => setTimeout(r, 5));
    Object.assign(report, {
      attemptA: a.id,
      stateA: ws.attempt(a.id).state,
      attemptB: b.id,
      stateB: ws.attempt(b.id).state,
      filesA: ws.cloneOf(p.id).list(`app-records/${done.id}/${a.id}/`).map((x) => x.split('/').pop()),
    });
    console.log('SMOKE-PERSIST ' + JSON.stringify(report));
    app.exit(0); // quit while attempt B is still running
    return;
  }
  // verify
  await new Promise((r) => setTimeout(r, 1000));
  const page = await mainWindow!.webContents.executeJavaScript(`({
    banner: document.body.innerText.includes(${JSON.stringify(SIMULATION_BANNER)}),
    persistentNote: document.body.innerText.includes('Persistent mode'),
    projectRows: document.querySelectorAll('[data-testid="project-row"]').length,
  })`);
  const attempts = ws.t.attempts.map((x) => ({
    id: x.id,
    state: x.state,
    final: x.final,
    record: ws.recordState(x.id).kind,
    unresolved: ws.unresolvedStages(x.id),
  }));
  Object.assign(report, { page, projects: ws.t.projects.length, tasks: ws.t.tasks.length, attempts });
  console.log('SMOKE-PERSIST ' + JSON.stringify(report));
  app.exit(0);
}

app.on('web-contents-created', (_e, contents) => hardenContents(contents));
app.on('window-all-closed', () => app.quit());

// Electron main process for the simulated v1. Fake adapters only: nothing
// here starts a provider program, opens a network connection or reads files
// outside the built app.

import { app, BrowserWindow, ipcMain, protocol, session, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { API_METHODS, IPC_CHANGED_CHANNEL, IPC_CHANNEL_PREFIX } from '../shared/api.js';
import { SIMULATION_BANNER } from '../shared/types.js';
import { UI_TIMING, Workspace } from '../core/engine.js';
import { seedWorkspace } from '../core/seed.js';
import { Service } from '../core/service.js';
import { APP_ENTRY, APP_SCHEME, CSP, isAllowedRequest, isAppUrl, MAX_IPC_ARG_BYTES, resolveAppFile, webPreferences } from './security.js';

const SMOKE = process.argv.includes('--smoke-test');
const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

// No production remote debugging.
if (app.commandLine.hasSwitch('remote-debugging-port') || app.commandLine.hasSwitch('inspect')) {
  console.error('Refusing to start with remote debugging enabled.');
  app.exit(1);
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
  return !!mainWindow && !!frame && event.sender === mainWindow.webContents && frame === mainWindow.webContents.mainFrame && isAppUrl(frame.url);
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
    title: `Helo Workspace — ${SIMULATION_BANNER}`,
    show: !SMOKE,
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
  const report = await wc.executeJavaScript(`(() => ({
    banner: document.body.innerText.includes(${JSON.stringify(SIMULATION_BANNER)}),
    hasRequire: typeof require !== 'undefined',
    hasProcess: typeof process !== 'undefined',
    heloKeys: Object.keys(window.helo || {}).sort(),
    projects: document.querySelectorAll('[data-testid="project-row"]').length,
    location: location.href,
  }))()`);
  const prefs = (wc as unknown as { getLastWebPreferences?: () => Record<string, unknown> }).getLastWebPreferences?.() ?? {};
  const out = {
    ...report,
    contextIsolation: prefs.contextIsolation,
    sandbox: prefs.sandbox,
    nodeIntegration: prefs.nodeIntegration,
    webSecurity: prefs.webSecurity,
    electron: process.versions.electron,
  };
  console.log('SMOKE ' + JSON.stringify(out));
  const ok = out.banner && !out.hasRequire && !out.hasProcess && out.projects >= 2 && out.location === APP_ENTRY;
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(async () => {
  workspace = new Workspace({
    timing: UI_TIMING,
    // A simulated crash restarts the (simulated) app straight away: recovery runs over the durable records.
    onCrash: () => setTimeout(() => workspace.restartIfCrashed(), 300),
  });
  service = new Service(workspace);
  await seedWorkspace(workspace);
  hardenSession();
  registerIpc();
  await createWindow();
  if (SMOKE) await smokeTest();
});

app.on('web-contents-created', (_e, contents) => hardenContents(contents));
app.on('window-all-closed', () => app.quit());

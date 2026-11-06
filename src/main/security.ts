// Electron security settings, kept free of Electron imports so they can be
// unit-tested. See the plan's "Proposed implementation".

import path from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'helo';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY = `${APP_ORIGIN}/index.html`;

/** Restrictive CSP: local scripts and styles only, no inline or eval, no network, no frames, no forms. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function webPreferences(preloadPath: string, allowDevTools: boolean) {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    experimentalFeatures: false,
    enableBlinkFeatures: '',
    spellcheck: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    devTools: allowDevTools,
  } as const;
}

/** Only the app's own packaged pages may load or call the typed operations. */
export function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST;
  } catch {
    return false;
  }
}

/** Requests the session may make: the app's own files only. Everything else (http, https, file, ws, ...) is cancelled. */
export function isAllowedRequest(url: string): boolean {
  return isAppUrl(url);
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * Map an app:// URL to a file inside the built renderer folder. Returns null
 * for anything outside it (traversal, encoded separators, other hosts).
 */
export function resolveAppFile(url: string, rendererRoot: string): { file: string; contentType: string } | null {
  if (!isAppUrl(url)) return null;
  const u = new URL(url);
  let rel: string;
  try {
    rel = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0') || rel.includes('\\')) return null;
  const root = path.resolve(rendererRoot);
  const file = path.resolve(root, '.' + rel);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()];
  if (!contentType) return null;
  return { file, contentType };
}

/**
 * IPC sender check: only the app window's own main frame, showing the app's
 * own page, may call an operation. Subframes, other windows and other
 * origins are refused.
 */
export function isTrustedSender(input: {
  senderIsAppWindow: boolean;
  frameIsMainFrame: boolean;
  frameUrl: string | null | undefined;
}): boolean {
  return input.senderIsAppWindow && input.frameIsMainFrame && typeof input.frameUrl === 'string' && isAppUrl(input.frameUrl);
}

/** The security preferences the smoke test requires the live window to report. */
export const REQUIRED_LIVE_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
} as const;

/** Largest serialized argument accepted from the renderer for one operation. */
export const MAX_IPC_ARG_BYTES = 256 * 1024;

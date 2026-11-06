// Static checks on the source: no provider programs, processes, network,
// git or real-disk access; the preload exposes only the allow-listed
// operations; the Electron settings are the plan's.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_METHODS } from '../../src/shared/api.js';
import { APP_ENTRY, CSP, isAllowedRequest, isAppUrl, isTrustedSender, resolveAppFile, webPreferences } from '../../src/main/security.js';

const ROOT = path.resolve(__dirname, '../..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const SRC = files(path.join(ROOT, 'src')).filter((f) => /\.(ts|tsx)$/.test(f));
const read = (f: string) => readFileSync(f, 'utf8');

describe('source boundaries', () => {
  it('never starts a process, opens a network connection, or uses git', () => {
    const forbidden = [
      /\bchild_process\b/,
      /\bnode:child_process\b/,
      /\bspawn\s*\(/,
      /\bexecFile\s*\(/,
      /(^|[^.\w])exec\s*\(/, // exec(...) as a function, not RegExp.prototype.exec
      /\bfork\s*\(/,
      /from ['"](node:)?(http|https|net|tls|dgram|dns|http2)['"]/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bnet\.request\b/,
      /\bshell\.openExternal\b/,
      /\bisomorphic-git\b|\bsimple-git\b|\bnodegit\b/,
      /['"]git['"]/,
      /['"](codex|claude)['"]\s*,\s*\[/, // argument-array invocation of a provider program
    ];
    // One narrow exception: the smoke test's in-page probe, which calls fetch on the app's own
    // origin to prove the CSP blocks it. Exactly one such line may exist, in main.ts only.
    const SMOKE_PROBE = "try { await fetch('app://helo/index.html'); r.fetchBlocked = false; } catch (e) { r.fetchBlocked = true; }";
    const mainText = read(path.join(ROOT, 'src/main/main.ts'));
    expect(mainText.split(SMOKE_PROBE)).toHaveLength(2);
    for (const f of SRC) {
      const text = read(f).split(SMOKE_PROBE).join('');
      for (const re of forbidden) expect(text, `${path.relative(ROOT, f)} matches ${re}`).not.toMatch(re);
    }
  });

  it('reads files only in the main process, and only the built renderer', () => {
    for (const f of SRC) {
      const text = read(f);
      const usesFs = /from ['"](node:)?fs(\/promises)?['"]/.test(text);
      if (usesFs) expect(path.relative(ROOT, f)).toBe(path.join('src', 'main', 'main.ts'));
    }
    const main = read(path.join(ROOT, 'src/main/main.ts'));
    expect(main).toMatch(/readFile\(resolved\.file\)/);
    expect(main).not.toMatch(/writeFile|appendFile|mkdir|rm\(|unlink/);
  });

  it('never references the real business folders or repositories', () => {
    for (const f of SRC) {
      const text = read(f);
      expect(text).not.toMatch(/helo-walkup|helo-hoe|Desktop\/Helo\//);
    }
  });

  it('never renders generated content as HTML', () => {
    for (const f of SRC.filter((x) => x.endsWith('.tsx'))) {
      expect(read(f)).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|eval\(|new Function/);
    }
  });

  it('has no Apply, Merge or Approve changes controls', () => {
    for (const f of SRC.filter((x) => x.endsWith('.tsx'))) {
      expect(read(f)).not.toMatch(/>\s*(Apply|Merge|Approve changes)\b/);
    }
  });
});

describe('preload', () => {
  const preload = read(path.join(ROOT, 'src/preload/preload.ts'));

  it('exposes exactly the allow-listed operations, plus onChanged', () => {
    const list = /const PRELOAD_METHODS = \[([\s\S]*?)\] as const;/.exec(preload)![1]!;
    const names = [...list.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(names).toEqual([...API_METHODS]);
    expect(preload).toMatch(/exposeInMainWorld\('helo', Object\.freeze\(bridge\)\)/);
  });

  it('exposes no generic IPC, filesystem, process or event object', () => {
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/);
    expect(preload).not.toMatch(/\bsend\s*:|\binvoke\s*:|\bon\s*:/);
    expect(preload).not.toMatch(/require\(['"](?!electron['"])/);
    expect(preload).toMatch(/const listener = \(\) => callback\(\);/);
  });
});

describe('Electron security settings', () => {
  it('uses contextIsolation, sandbox, no node integration and web security', () => {
    const p = webPreferences('/x/preload.js', false);
    expect(p).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
    });
  });

  it('has a restrictive CSP with no remote scripts or unsafe evaluation', () => {
    expect(CSP).toContain("default-src 'none'");
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).toContain("connect-src 'none'");
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
    const html = read(path.join(ROOT, 'src/renderer/index.html'));
    expect(html).toMatch(/Content-Security-Policy/);
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
  });

  it('serves only files inside the built renderer folder', () => {
    const root = '/app/dist/renderer';
    expect(resolveAppFile(APP_ENTRY, root)?.file).toBe('/app/dist/renderer/index.html');
    expect(resolveAppFile('app://helo/assets/index-x.js', root)?.contentType).toMatch(/javascript/);
    // The URL parser already folds "../" at the root, so this stays inside the renderer folder (and is a 404 there).
    expect(resolveAppFile('app://helo/../../main/main.js', root)?.file).toBe('/app/dist/renderer/main/main.js');
    expect(resolveAppFile('app://helo/%2e%2e/%2e%2e/etc/passwd', root)).toBeNull();
    expect(resolveAppFile('app://helo/..%2fmain.js', root)).toBeNull();
    expect(resolveAppFile('app://other/index.html', root)).toBeNull();
    expect(resolveAppFile('file:///etc/passwd', root)).toBeNull();
    expect(resolveAppFile('app://helo/secret.json', root)).toBeNull();
  });

  it('allows requests only to the app origin', () => {
    expect(isAppUrl('app://helo/index.html')).toBe(true);
    for (const u of ['https://example.com/', 'http://localhost:5173/', 'file:///etc/hosts', 'ws://x', 'app://evil/index.html', 'not a url']) {
      expect(isAllowedRequest(u)).toBe(false);
    }
  });

  it('accepts IPC only from the app window\'s main frame on the app origin', () => {
    const ok = { senderIsAppWindow: true, frameIsMainFrame: true, frameUrl: 'app://helo/index.html' };
    expect(isTrustedSender(ok)).toBe(true);
    expect(isTrustedSender({ ...ok, senderIsAppWindow: false })).toBe(false); // another window
    expect(isTrustedSender({ ...ok, frameIsMainFrame: false })).toBe(false); // a subframe
    for (const frameUrl of ['https://example.com/', 'file:///tmp/x.html', 'app://evil/index.html', 'about:blank', '', null, undefined]) {
      expect(isTrustedSender({ ...ok, frameUrl })).toBe(false);
    }
  });

  it('main process denies navigation, new windows, webviews, downloads and permissions, and validates the sender', () => {
    const main = read(path.join(ROOT, 'src/main/main.ts'));
    for (const re of [
      /'will-navigate', \(e\) => e\.preventDefault\(\)/,
      /'will-redirect', \(e\) => e\.preventDefault\(\)/,
      /'will-attach-webview', \(e\) => e\.preventDefault\(\)/,
      /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/,
      /'will-download', \(e\) => e\.preventDefault\(\)/,
      /setPermissionRequestHandler\(\(_wc, _perm, callback\) => callback\(false\)\)/,
      /setPermissionCheckHandler\(\(\) => false\)/,
      /app\.enableSandbox\(\)/,
      /trustedSender\(event\)/,
      /MAX_IPC_ARG_BYTES/,
      /remote-debugging-port/,
    ]) {
      expect(main).toMatch(re);
    }
  });
});

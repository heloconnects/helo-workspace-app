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

  it('never writes with node:fs; reads only the built renderer (main) and resolves the test folder path (real-folder)', () => {
    const allowed: Record<string, string[]> = {
      [path.join('src', 'main', 'main.ts')]: ['readFile'],
      [path.join('src', 'persist', 'real-folder.ts')]: ['lstatSync', 'realpathSync'],
    };
    for (const f of SRC) {
      const rel = path.relative(ROOT, f);
      const text = read(f);
      const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/g)];
      const anyFs = /from ['"](node:)?fs(\/promises)?['"]|require\(['"](node:)?fs/.test(text);
      if (!allowed[rel]) {
        expect(anyFs, `${rel} must not use node:fs`).toBe(false);
        continue;
      }
      const names = imports.flatMap((m) => m[1]!.split(',').map((x) => x.trim()).filter(Boolean));
      expect(names.sort(), rel).toEqual([...allowed[rel]!].sort());
      expect(text, rel).not.toMatch(/\b(writeFile|appendFile|mkdir|rmSync|unlink|rename|copyFile|symlink|truncate|chmod|createWriteStream)\w*\(/);
    }
  });

  it('never references the real business folders or repositories, except to refuse them', () => {
    const guard = path.join('src', 'persist', 'real-folder.ts');
    for (const f of SRC) {
      const rel = path.relative(ROOT, f);
      for (const line of read(f).split('\n')) {
        if (!/helo-walkup|helo-hoe|Desktop\/Helo\/|'Desktop', 'Helo'/.test(line)) continue;
        expect(rel, line).toBe(guard);
        expect(line, line).toMatch(/Refused|p === 'helo-walkup'|path\.join\(home, 'Desktop', 'Helo'\)/);
      }
    }
  });

  it('the native helper offers only the F3 operations (no rename, overwrite, truncate, process or network calls)', () => {
    // Code only: comments removed, so wording in comments cannot hide or fake a match.
    const c = read(path.join(ROOT, 'src/native/safe_publish.c'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const re of [/\brename(at)?\s*\(/, /O_TRUNC/, /\bunlink\s*\(/, /\bremove\s*\(/, /\brmdir\s*\(/, /\bsystem\s*\(/, /\bexec[lv]p?e?\s*\(/, /\bfork\s*\(/, /\bsocket\s*\(/, /\bconnect\s*\(/, /\bsymlink(at)?\s*\(/, /\bchmod\s*\(/]) {
      expect(c, String(re)).not.toMatch(re);
    }
    // unlinkat: cleanup of the helper's own new file (2), removeTemp (1), removeQuarantined (1).
    expect(c.match(/\bunlinkat\s*\(/g)).toHaveLength(4);
    expect(c).toMatch(/O_CREAT \| O_EXCL \| O_NOFOLLOW/);
    expect(c).toMatch(/O_NOFOLLOW_ANY/);
    expect(c).toMatch(/strncmp\(name, "\.tmp-", 5\) != 0/);
    expect(c).toMatch(/a\.st_dev != b\.st_dev \|\| a\.st_ino != b\.st_ino/);
    const exported = [...c.matchAll(/\{"(\w+)", NULL,/g)].map((m) => m[1]);
    expect(exported).toEqual(['openDir', 'closeDir', 'createExclusive', 'linkNoReplace', 'linkInto', 'removeTemp', 'removeQuarantined', 'fsyncDir', 'readFile', 'listDir']);
  });

  it('only the main process and the persistence layer load the native helper; the interface never does', () => {
    for (const f of SRC) {
      const rel = path.relative(ROOT, f);
      const text = read(f);
      if (/safe_publish\.node|loadSafePublish|persist\/native/.test(text)) {
        expect(rel.startsWith(path.join('src', 'persist')) || rel === path.join('src', 'main', 'main.ts'), rel).toBe(true);
      }
      if (rel.startsWith(path.join('src', 'renderer'))) expect(text, rel).not.toMatch(/persist\//);
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

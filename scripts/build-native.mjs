// Builds src/native/safe_publish.c with the node-gyp that ships inside npm,
// against the Node headers already installed next to this Node (no download).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const nodeDir = path.resolve(path.dirname(process.execPath), '..');
const header = path.join(nodeDir, 'include', 'node', 'node_api.h');
const gyp = path.join(nodeDir, 'lib', 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
for (const p of [header, gyp]) {
  if (!existsSync(p)) {
    console.error(`build-native: missing ${p}. Stopping rather than downloading anything.`);
    process.exit(1);
  }
}
console.log(`build-native: using node-gyp at ${gyp}`);
console.log(`build-native: using local headers at ${nodeDir} (--nodedir, no download)`);
execFileSync(process.execPath, [gyp, 'rebuild', `--nodedir=${nodeDir}`], { stdio: 'inherit' });

// Preload for the sandboxed renderer. It exposes window.helo: one named,
// typed function per allowed operation, plus a "state changed" subscription.
// No generic IPC, filesystem, process or network access is exposed.
//
// This file is a self-contained script (no imports): a sandboxed preload can
// only require 'electron'. tests/static/preload.test.ts checks that this list
// equals API_METHODS in src/shared/api.ts.

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const PRELOAD_METHODS = [
  'listSimFolders',
  'listScenarios',
  'listProjects',
  'registerProject',
  'renameProject',
  'archiveProject',
  'deleteProject',
  'confirmFolderIdentity',
  'confirmFolderChecked',
  'listTasks',
  'previewSharing',
  'createTask',
  'getTask',
  'deleteTask',
  'startAttempt',
  'cancelAttempt',
  'resolveCancellation',
  'saveOutsideReview',
  'getInventory',
  'exportArtifacts',
  'getConnection',
  'getEvents',
  'getMode',
  'chooseTestFolder',
  'simulateCrashAndRestart',
  'simulateDamage',
] as const;

const bridge: Record<string, unknown> = {};
for (const method of PRELOAD_METHODS) {
  bridge[method] = (arg?: unknown) => ipcRenderer.invoke(`helo:${method}`, arg);
}
bridge.onChanged = (callback: () => void) => {
  // The IPC event object is never passed to the page.
  const listener = () => callback();
  ipcRenderer.on('helo:changed', listener);
  return () => {
    ipcRenderer.removeListener('helo:changed', listener);
  };
};

contextBridge.exposeInMainWorld('helo', Object.freeze(bridge));

# Build brief: Helo Workspace app, persistence v1

Drafted by Claude Code on 2026-11-06, at Ahmed's request, after simulated v1 was finished, reviewed by Codex twice and pushed (`build/simulated-v1`, commit `4c13917`). **Approved by Ahmed in chat on 2026-11-06 ("Approved, start").**

**Decision recorded:** on 2026-11-06 Ahmed chose **option A** (a small native helper) for real file writing. The brief was then approved as a whole.

## Why this step

The plan (`docs/Implementation-Plan-DRAFT.md`, revision 7) puts persistence before any live provider work:
- The carried items say C1 must be settled **before the persistence approval**.
- Simulated v1 kept everything in memory. The F3 file-writing rules (no symlink following, no-replace publication, flushing) and the SQLite transactions have only been simulated.

So the next gate is: **real persistence, still with fake adapters only.**

## Goal

The same app, with three changes:
- task records are really written as files by the F3 procedure;
- run state is kept in a real SQLite store that survives quitting and reopening the app;
- C1 is settled.

The banner stays: "SIMULATION: no real AI calls".

## Proposed scope

1. **Settle C1.** The exact `final-status.json` bytes are kept in the finalizing record, and republishing never rebuilds the file list from disk. Simulated v1 already does this in memory; this step makes it durable. The plan's line "Already-final attempts are left alone" is also aligned with recovery republishing a missing `final-status.json` (see section 4 of the build report).
2. **SQLite store.** Use Node's built-in `node:sqlite` (it exists in the Node 24 on this Mac), so **no new package** is installed. That it also works inside Electron 44's bundled Node needs checking first. The store lives in the app's own application-data folder, never in a clone. It holds the tables from the plan's "Data model and separation" and a migration table.
3. **Real F3 file writing, into throwaway test folders only.**
   - Tests create temporary folders and delete them afterwards.
   - The app writes only to one **fictional test folder** that you create and choose, shaped like a clone (with a fictional `RULES.md`).
   - Nothing under `~/Desktop/Helo`, `helo-walkup`, `helo-hoe` or any real repository is touched.
4. **The real crash and recovery tests**, rerun against real files and SQLite: crash at every boundary, symlinked folders refused, a folder swapped between check and write, collisions, and disk-full and permission errors.

## File-writing method: option A chosen by Ahmed

F3 requires writing through directory handles opened without following symlinks (`O_DIRECTORY | O_NOFOLLOW`, then `openat`, `linkat` and `unlinkat`). **Node.js does not offer `openat` or `linkat`**, so plain Node can't meet that rule exactly. The options:

- **A. A small native helper** (a Node add-on, or a tiny compiled program) that does exactly those system calls. It meets F3 as written. It means compiling native code and probably installing build tooling, and it needs its own review.
- **B. Plain Node, with checks around each step.** Resolve real paths, refuse symlinks, re-check folder identity (device and inode) just before and just after each write, and publish with `fs.link` (which also fails if the name exists). This is simpler, but it leaves a small race window that F3 was written to close. It needs the plan amended and re-reviewed.
- **C. Postpone real file writing.** Do only C1 and SQLite in this step.

Ahmed chose **A**.

### How option A would be built

- **A small C add-on, `src/native/safe-publish.c`**, written against Node-API (`node_api.h`). Node-API is stable across Node versions and across Electron's bundled Node, so the same build should load in both; that is checked first, not assumed.
- **Only F3's system calls**:
  - open the clone root and each folder down to the attempt folder with `O_DIRECTORY | O_NOFOLLOW`, checking each is a real folder;
  - create the temporary file exclusively (`O_CREAT | O_EXCL | O_NOFOLLOW`) with `openat`, write it and `fsync` it;
  - publish it with `linkat`, which fails if the name exists, then `unlinkat` the temporary file and `fsync` the folder;
  - do quarantine moves the same way.
- **No other abilities.** The add-on has no rename, no overwrite, no delete beyond the app's own temporary files, and no paths taken from the interface: every path is built by the app from F3's fixed patterns.
- **Only the main process loads it.** The interface never can.
- **Tooling already on this Mac, checked read-only on 2026-11-06.** Nothing new is expected to be installed or downloaded:
  - Apple command-line tools (clang 17.0.0);
  - Node's headers (`~/.nvm/versions/node/v24.21.0/include/node/node_api.h`);
  - npm's bundled node-gyp 12.4.0, run with `--nodedir` pointing at those headers so it doesn't download them;
  - Python 3.13.5.
- **If a download or package does turn out to be needed** (for example node-gyp insisting on fetching headers, or Electron needing a rebuild), the session stops and asks first, per rule 1.
- **Tests run the real add-on on real temporary folders:**
  - a symlinked clone root, `app-records`, task folder or attempt folder is refused;
  - a folder swapped for a symlink or another folder between the check and the write doesn't redirect the write;
  - a destination name created by another process after the temporary file was made is never replaced;
  - disk-full and permission errors are shown with the path;
  - a crash at every boundary, with recovery.
- **The add-on goes in the Codex review**, along with this list of exactly which system calls it makes.

## Out of scope (each still needs Ahmed's separate approval)

- Any real call to Codex, Claude, OpenAI or Anthropic. The adapters stay fake.
- Reading or writing any real business repository or folder.
- Git operations by the app; packaging, signing, auto-update, telemetry and distribution.

## Rules for the session

1. Install or download nothing without showing exactly what and from where first, and getting a yes. With option A as described, nothing is expected.
2. Network: only an approved install.
3. Git: work on a new branch, `build/persistence-v1`, starting from `build/simulated-v1`. Don't push or merge; Ahmed does.
4. When done, write `docs/Build-Report-Persistence-v1.md` covering: what was built, how to run it, the tests that ran with their real output, what was not done, and how C1 was settled.
5. Stop there. The independent Codex review comes next.

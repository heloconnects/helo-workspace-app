# Build report: Helo Workspace app, persistence v1

Claude Code session, 2026-11-06 to 2026-11-07, in `~/Desktop/Helo-Shared/helo-workspace-app/`, on branch `build/persistence-v1` (started from `build/simulated-v1` at `4c13917`). Written for the brief `docs/Build-Brief-Persistence-v1.md`, which Ahmed approved in chat on 2026-11-06 ("Approved, start") after choosing option A. That brief builds on the plan `docs/Implementation-Plan-DRAFT.md`, revision 7.

**The app still makes no real AI calls.** The adapters are still the fake ones from simulated v1. Nothing starts a provider program, opens a network connection or runs git. The banner on every screen still says "SIMULATION: no real AI calls".

What is new is that run state and task records are now **real**:
- run state is kept in a SQLite store in the app's own data folder;
- task records are written as files into a **fictional test folder Ahmed chooses**, by a small native helper that follows the plan's F3 rules.

Nothing outside a chosen test folder's `app-records/` folder is ever written, and real business folders are refused.

## 1. What was built

### The native helper (option A): `src/native/safe_publish.c`

This is about 430 lines of C written against Node-API. It is the only code in the app that writes into a project folder, and it offers exactly ten operations:

| Operation | What it does |
|---|---|
| `openDir(root, segments, create)` | Opens the folder as a handle, one path component at a time, without following symlinks. The root uses `O_NOFOLLOW_ANY`, which refuses a symlink anywhere in the root path; each lower folder uses `O_DIRECTORY \| O_NOFOLLOW`. Each one is checked to be a real folder. Missing folders are created only when asked. |
| `createExclusive(fd, name, data, fullSync)` | Creates a new file relative to the handle (`O_CREAT \| O_EXCL \| O_NOFOLLOW`), writes it and flushes it (`F_FULLFSYNC` on macOS). |
| `linkNoReplace(fd, from, to)` | Publishes with `linkat`, which fails with EEXIST if the name exists. Nothing is ever replaced. |
| `linkInto(srcFd, name, destFd, destName)` | The same no-replace link across two handles, for quarantine moves. |
| `removeTemp(fd, name)` | Removes only regular files named `.tmp-…` (the app's own). |
| `removeQuarantined(srcFd, name, qFd, qName)` | Removes an old name only if quarantine already holds **the very same file** (same device and inode). |
| `fsyncDir`, `readFile`, `listDir`, `closeDir` | Flush a folder; read a regular file only, within a size limit, never through a symlink; list a folder without following links; close a handle. |

Names must be a single plain component: `""`, `.`, `..` and anything containing `/` or NUL are refused. The helper has no rename, overwrite, truncate, chmod, symlink, process or network call; a static test checks the C code, with comments removed, for each of these.

It is built by `npm run build:native` (`scripts/build-native.mjs`). That uses the node-gyp that comes inside npm, with `--nodedir` pointing at the Node headers already on this Mac, so **nothing is downloaded**; the build log was checked for this. npm's own automatic add-on build on `npm install` is turned off (`"gypfile": false`), because it would download headers. The same compiled file loads in Node 24.21.0 and inside Electron 44.9.3 (Node 24.22.0, Node-API 10), which was checked first.

### The rest of the persistence layer: `src/persist/`

- **`real-fs.ts` (`RealCloneFs`)**: the real folder seen through the same storage interface the engine already used for the in-memory folder.
  - Every operation goes through the helper, and it only works inside `app-records/`.
  - It never imports `node:fs`.
  - One folder handle is held for each whole publication: create the temporary file, link it, remove the temporary file, flush, close. So a folder swapped after it was opened cannot redirect a write, and a test proves it.
- **`real-folder.ts` (`RealFolder`, `openTestFolder`)**: a chosen test folder.
  - Its path and `RULES.md` are re-read from disk every time, so the F2 "re-check before every task and every write" holds on real disk too.
  - A folder is refused when it:
    - isn't absolute, or is reached through a symlink;
    - is `/`, the home folder or `~/Desktop`;
    - is or contains this app's repository;
    - is inside `~/Desktop/Helo`;
    - is named `helo-walkup` or `helo-hoe`;
    - lacks a `RULES.md` whose business line names one of the two fictional businesses.
  - This file uses only `realpathSync` and `lstatSync` from `node:fs`, to inspect the path.
- **`sqlite-db.ts` (`SqliteDb`)**: the run-state store, using Node's built-in `node:sqlite`, so **no new package was installed**.
  - It has one table per engine table (`projects`, `tasks`, `attempts`, `record_files`, `dispatch_journal`, `artifacts`, `rejections`, `late_results`, `outside_saves`) and a `schema_migrations` table.
  - It runs with `journal_mode = WAL`, `synchronous = FULL` and `fullfsync = ON`.
  - Each engine transaction runs on a copy. Only the changed rows are written, in one `BEGIN IMMEDIATE … COMMIT`, and the in-memory copy moves forward only after the commit. A crash at any point leaves all of a transaction or none of it.
  - A store written by a newer schema is refused.
- **`index.ts`**: assembles a persistent workspace (the same engine, with the SQLite store and real folders) and adds a chosen test folder.

### Engine changes (`src/core/`)

- The engine now uses one storage interface, with two versions: the in-memory folder (`SimFs`) and the real folder (`RealCloneFs`). It publishes through a folder handle, and moves files into quarantine with the same-file rule. All the simulated-v1 tests run unchanged against the in-memory version.
- **Stricter quarantine than the plan's wording.** The plan says a repeated quarantine move removes the old name when the quarantine copy "has the same hash". The helper is stricter: the copy must be the same file. A crash between link and removal still leaves the same file, so recovery repeats cleanly, and a test covers that. A file that merely has the same content goes to the next free quarantine name instead, so nothing is lost.
- Projects can now live in real folders. Projects stored in SQLite get their real folder back when the app reopens.

### The app (`src/main/main.ts`, interface)

- **Two modes.**
  - **Persistent** is the default (`npm start`). The SQLite store is in the app's data folder (`~/Library/Application Support/helo-workspace-app/helo-run-state.sqlite`). Recovery runs on every start, so anything that was running when the app last stopped becomes "interrupted". Only one copy of the app may use the store at a time.
  - **Showcase** (`npm run showcase`) is simulated v1 unchanged: everything is in memory, with the 12 example tasks.
- **Choosing a test folder.** In persistent mode, the register form has a **Choose test folder…** button. It opens the system folder picker in the main process, so the interface never sends a path.
- **Mode line.** Each screen shows the mode and where the store is.
- **No "Damage record file" control in persistent mode,** because the app never changes its own records. You can change or delete a file yourself (for example in Finder) and the record shows as damaged.

## 2. How to run it

```bash
cd ~/Desktop/Helo-Shared/helo-workspace-app
```

**Persistent mode.** First make a fictional test folder, for example `~/Desktop/Helo-Shared/helo-test-folder`, containing a `RULES.md` with this line:

```text
Business in this repository: Example Business A (fictional)
```

Then:

```bash
npm start
```

In the window:
1. Projects → **Choose test folder…** → pick that folder.
2. Name the project, tick the confirmation and register it.
3. Create a task and run it.
4. The records appear in `<test folder>/app-records/`.

Quit the app while an attempt is running and reopen it to see real recovery. Edit a record file by hand to see "Complete — record damaged".

**Showcase mode** (simulated v1, in memory):

```bash
npm run showcase
```

**Tests and checks:**

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run smoke
```

```bash
npm run smoke:persist
```

`npm run smoke` checks the showcase window's security, as in simulated v1. `npm run smoke:persist` launches the real app twice on a temporary folder (see section 3).

## 3. Tests that ran, with their real output

All five checks were run at the end of the session. The full raw output is in `docs/test-output-persistence/`.

| Check | Command | Result |
|---|---|---|
| Type check | `npm run typecheck` | exit 0 (`typecheck.txt`) |
| Build (native helper, main, interface) | `npm run build` | exit 0; no download in the native build (`build.txt`) |
| Unit, real-disk and interface tests | `npx vitest run --reporter=verbose` | **16 files, 190 tests, all passed**, exit 0 (`vitest.txt`) |
| Electron smoke test, showcase | `electron . --smoke-test` | `SMOKE PASSED`, exit 0 (`electron-smoke-showcase.txt`) |
| Electron smoke test, persistent (two launches) | `node scripts/smoke-persist.mjs` | `SMOKE-PERSIST PASSED`, exit 0 (`electron-smoke-persist.txt`) |

### What the new tests cover (all on real temporary folders, created and deleted by the tests)

**Native helper** (`tests/persist/native.test.ts`, 10):
- create, link and publish;
- EEXIST from both the exclusive create and the publishing link, so nothing is replaced;
- a destination created by another process after the temporary file is never replaced;
- symlinks are refused at the root, anywhere in the root path, at a folder level and as a file;
- **a folder replaced by a symlink, or by another folder, after it was opened doesn't redirect the write**;
- invalid names are refused;
- only `.tmp-` files can be removed;
- quarantine removal requires the same file;
- a real permission error comes back with its code and the name;
- only regular files are read, within a size limit.

**SQLite store** (`tests/persist/sqlite.test.ts`, 5): schema and migration record; WAL; a transaction that throws changes nothing; a crash before or after a transaction leaves none or all of it; only changed rows are written; deletions; a newer schema is refused.

**Choosing folders** (`tests/persist/folders.test.ts`, 5):
- every refusal rule listed in section 1;
- `RULES.md` is re-read on every check;
- access is limited to `app-records/`;
- a symlinked folder is listed but never followed.

**Engine on real disk with true relaunches** (`tests/persist/restart.test.ts`, 11; most in both role orders):
- **A full run writes all nine records and leaves everything outside `app-records/` byte for byte unchanged**, including `RULES.md`, other files and a `.git/` folder. It survives a relaunch, and recovery changes nothing.
- **Quitting while a stage runs:** after the relaunch, the attempt is interrupted and a retry needs acknowledgement.
- **A crash at every one of the 107 boundaries of a run, in both role orders (214 runs).** After each crash the whole workspace is thrown away and a new one opened from the same SQLite file and folder. Each run must end with:
  - exactly one outcome, final, with an intact record;
  - a decided outcome unchanged;
  - nothing dispatched by recovery;
  - no `.tmp-` file left;
  - `final-status.json` byte-identical to the stored bytes;
  - nothing outside `app-records/` touched.
  - A second relaunch must change nothing.
- **C1:** after `final-status.json` is deleted and an extra file is added to the attempt folder, the relaunch writes back exactly the stored bytes, and their file list doesn't include the extra file.
- A record edited by hand shows "Complete — record damaged", and the next start moves it into quarantine without changing the outcome.
- **A `RULES.md` change during a run** blocks every later write into the folder (the folder is unchanged byte for byte). Recovery writes nothing while the folder is blocked, and finishes the record once it matches again.
- **A symlink planted where the task folder goes:** the write is refused with the full path, and nothing is written to the link's target.
- Outside reviews are saved as real files and survive a relaunch. Removing the task and the project in the app leaves the folder byte for byte unchanged (F6).

**Other new tests:**
- **Persistent interface** (`tests/ui/persistent.test.tsx`, 1): it chooses a folder through the main-process picker, registers it, runs a task and finds the nine real files and the real inventory paths. It also confirms the damage control is hidden in this mode.
- **Static checks** (`tests/static/boundaries.test.ts`, now 15):
  - no `node:fs` writes anywhere, and `node:fs` used only in two files, each limited to named read-only functions;
  - the C helper's forbidden calls, its `unlinkat` uses, and its list of exported operations;
  - only the main process and the persistence layer load the helper;
  - real business folder names appear only in the code that refuses them.
- **Engine and simulation** (`tests/core`, 132): all 131 simulated-v1 tests still pass against the in-memory folder (three were updated for the folder-handle interface and the stricter quarantine rule), plus one new test for repeating a quarantine move after a crash between link and removal.

**Electron smoke tests:**
- The **showcase** smoke test is unchanged from simulated v1 and still passes. It checks the security preferences, and that `window.open`, `eval`, `fetch`, permissions, navigation and bad input are all refused.
- The **persistent** smoke test launches the real app twice, on a temporary test folder and data folder:
  - **Launch 1** registers the folder, completes an attempt (nine record files) and quits while a second attempt is reviewing.
  - **Launch 2** runs start-up recovery and finds the project and both tasks, attempt A complete and intact, and attempt B interrupted and intact, with its review stage marked "not confirmed stopped".
  - The window showed the banner and persistent mode. The test folder held only `RULES.md` and `app-records/`.

### Test output (verbatim, `npx vitest run --reporter=verbose`)

```
 RUN  v5.0.5 /Users/ahmedelhelaly/Desktop/Helo-Shared/helo-workspace-app

 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > completes three stages, each produced by the right provider, with unresolved issues kept 75ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > reports "no issues reported" when the review has no findings 12ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > gives needs attention for an unmet acceptance criterion, with all nine record files 11ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (claude drafting) > cancellation unconfirmed with a confirmed dispatch → restart → interrupted still requires acknowledgement before a retry 60ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (claude drafting) > a crash after the dispatch was confirmed but before any result also requires acknowledgement 55ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is fail, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is fail, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when synthesis is fail, and never forwards rejected output 17ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is refuse, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is refuse, and never forwards rejected output 10ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when synthesis is malformed, and never forwards rejected output 9ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is empty, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is duplicate-final, and never forwards rejected output 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is missing-final, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is wrong-hash, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is tool-event, and never forwards rejected output 12ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is truncated, and never forwards rejected output 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when synthesis is wrong-provenance, and never forwards rejected output 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > rejects a synthesis that omits a review finding 5ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (claude drafting) > does not ask when every dispatched stage ended (result, confirmed stop, or explicit resolution) 42ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (codex drafting) > cancellation unconfirmed with a confirmed dispatch → restart → interrupted still requires acknowledgement before a retry 37ms
 ✓ tests/persist/restart.test.ts > on real disk (claude drafting) > completes, writes all nine records, touches nothing outside app-records/, and survives a relaunch 163ms
 ✓ tests/persist/restart.test.ts > on real disk (claude drafting) > quitting while a stage runs: after the relaunch the attempt is interrupted, and a retry needs acknowledgement 65ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (codex drafting) > a crash after the dispatch was confirmed but before any result also requires acknowledgement 55ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (codex drafting) > does not ask when every dispatched stage ended (result, confirmed stop, or explicit resolution) 38ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > quarantines a corrupted published record of a finished attempt; the outcome is unchanged and the record shows quarantined 10ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > republishes a missing final-status.json of an already-final attempt with the same bytes and outcome 8ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > a changed final-status.json of a final attempt is quarantined and replaced with the recorded bytes 8ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > a published record corrupted while the attempt was running is quarantined and stays required (damaged, not intact) 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > sends exactly the R4 payloads, and each -sent.json hash matches the bytes actually sent 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > does not dispatch a stage whose -sent.json cannot be published 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails with "collision" and replaces nothing when a record name already exists 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > shows disk-full and permission failures with the path 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > keeps the outcome when final-status.json cannot be written, and republishes it on restart 13ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > ignores a duplicate submission (same idempotency key) 12ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > refuses a start whose approval does not match the frozen packet 2ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > cancels during the review: the owned process confirms exit and the outcome is cancelled 22ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > refuses "complete" with matching IDs when the published files cannot support it 1ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines JSON null and settles interrupted without throwing 13ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines a list and settles interrupted without throwing 8ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines a null file entry and settles interrupted without throwing 9ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines a file entry without a hash and settles interrupted without throwing 8ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines files not a list and settles interrupted without throwing 11ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines not JSON and settles interrupted without throwing 7ms
 ✓ tests/core/review-findings.test.ts > finding 4 (Medium): project identity is rechecked before every write > a RULES.md business change during a run blocks every later write; the attempt still gets exactly one outcome 30ms
 ✓ tests/core/review-findings.test.ts > finding 4 (Medium): project identity is rechecked before every write > a folder path change also blocks writes 1ms
 ✓ tests/core/review-findings.test.ts > re-review regression (Medium): a blocked project is still reconciled before its outcome is settled > a record published just before the crash stays required when recovery runs while blocked (claude drafting) 4ms
 ✓ tests/core/review-findings.test.ts > re-review regression (Medium): a blocked project is still reconciled before its outcome is settled > a record published just before the crash stays required when recovery runs while blocked (codex drafting) 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > turns a stage timeout into failed through cancellation semantics 47ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > shows cancellation unconfirmed when the process ignores cancellation, blocks retry, quarantines the late result, and resolves explicitly 41ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > a late result after a confirmed cancel cannot change the terminal state 27ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > a new attempt re-runs all three stages from the frozen packet and keeps the earlier attempt 15ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > completes three stages, each produced by the right provider, with unresolved issues kept 7ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > reports "no issues reported" when the review has no findings 9ms
 ✓ tests/core/review-findings.test.ts > re-review regression (Medium): a blocked project is still reconciled before its outcome is settled > a mismatched intended record is never counted as published while blocked, and is quarantined after the unblock 8ms
 ✓ tests/core/review-findings.test.ts > re-review regression (Medium): a blocked project is still reconciled before its outcome is settled > an unadoptable final-status.json left while blocked is quarantined after the unblock, and the recorded bytes are published 9ms
 ✓ tests/persist/restart.test.ts > on real disk (codex drafting) > completes, writes all nine records, touches nothing outside app-records/, and survives a relaunch 83ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > gives needs attention for an unmet acceptance criterion, with all nine record files 9ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is fail, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is fail, and never forwards rejected output 5ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when synthesis is fail, and never forwards rejected output 7ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is refuse, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is refuse, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when synthesis is malformed, and never forwards rejected output 9ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is empty, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is duplicate-final, and never forwards rejected output 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is missing-final, and never forwards rejected output 5ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is wrong-hash, and never forwards rejected output 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is tool-event, and never forwards rejected output 5ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is truncated, and never forwards rejected output 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when synthesis is wrong-provenance, and never forwards rejected output 7ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > rejects a synthesis that omits a review finding 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > sends exactly the R4 payloads, and each -sent.json hash matches the bytes actually sent 7ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > does not dispatch a stage whose -sent.json cannot be published 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails with "collision" and replaces nothing when a record name already exists 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > shows disk-full and permission failures with the path 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > keeps the outcome when final-status.json cannot be written, and republishes it on restart 8ms
stdout | tests/core/seed.test.ts > seeded showcase > produces every required state using the real (simulated) engine
Example: made-up task, not started yet => 
Example: complete, unresolved issues remain => Workflow complete — unresolved issues remain
Example: complete, no issues reported => Workflow complete — no issues reported
Example: needs attention (unmet criterion) => Needs attention
Example: failed (reviewer process fails) => Failed
Example: failed (synthesis omits a finding) => Failed
Example: interrupted (app crash after review dispatch) => Interrupted
Example: cancelled by the user => Cancelled
Example: cancellation unconfirmed => Cancellation unconfirmed
Example: Complete — record damaged => Complete — record damaged
Example: final-status.json not on disk => Complete — record damaged
Example: Codex drafts, Claude reviews => Workflow complete — unresolved issues remain

 ✓ tests/core/seed.test.ts > seeded showcase > produces every required state using the real (simulated) engine 449ms
 ✓ tests/persist/restart.test.ts > on real disk (codex drafting) > quitting while a stage runs: after the relaunch the attempt is interrupted, and a retry needs acknowledgement 126ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > ignores a duplicate submission (same idempotency key) 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > refuses a start whose approval does not match the frozen packet 0ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > cancels during the review: the owned process confirms exit and the outcome is cancelled 5ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > turns a stage timeout into failed through cancellation semantics 44ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > shows cancellation unconfirmed when the process ignores cancellation, blocks retry, quarantines the late result, and resolves explicitly 31ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > a late result after a confirmed cancel cannot change the terminal state 32ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > a new attempt re-runs all three stages from the frozen packet and keeps the earlier attempt 12ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > complete and needs attention require all nine 3ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > failed, cancelled and interrupted require final-status.json plus exactly the frozen list 1ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > rejects inconsistent lists (a gap, or complete without every stage) 1ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > each real outcome publishes exactly its required files (claude drafting) 67ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > creates folders, writes a temporary file exclusively, publishes with a no-replace link and removes the temporary file 39ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > never replaces an existing file: exclusive create and the publishing link both fail with EEXIST 3ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > a destination created by another process after the temporary file was made is never replaced 4ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > refuses a symlink at the root, at any folder level, and as a file 8ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > a folder replaced by a symlink or another folder after it was opened cannot redirect the write 7ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > rejects names that are not a single plain component 2ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > removes only its own .tmp- files 2ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > removes a quarantined file's old name only when quarantine holds the very same file 4ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > reports a permission error with its code and the name 2ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > reads regular files only, within a size limit 4ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > each real outcome publishes exactly its required files (codex drafting) 72ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > a cancelled attempt requires what was published before cancellation 5ms
 ✓ tests/core/records.test.ts > F5 inventory > lists record files, outside reviews, temporary leftovers and quarantine content exactly, with full paths 22ms
 ✓ tests/core/projects.test.ts > F2 projects > refuses a second project for the same folder or the same business, a RULES.md mismatch, and a missing RULES.md 7ms
 ✓ tests/core/projects.test.ts > F2 projects > blocks a project whose RULES.md business line changed, until it is registered again 3ms
 ✓ tests/core/projects.test.ts > F2 projects > archived projects cannot start tasks 1ms
 ✓ tests/core/projects.test.ts > F2 projects > a task can use sources from its own project folder only 1ms
 ✓ tests/core/projects.test.ts > F2 projects > keeps project records in their own clone: project A writes nothing into project B 48ms
 ✓ tests/core/projects.test.ts > F6 deleting > removes only the app records and leaves the clone byte-for-byte unchanged 11ms
 ✓ tests/core/projects.test.ts > F6 deleting > blocks deletion while an attempt is running 2ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > rejects unknown operations and malformed or oversized input 1ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > derives ownership from stored records: a project ID from the renderer cannot reach another project 1ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > refuses a drafter equal to the reviewer by construction: the reviewer is always the other provider 1ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > names the actual providers in order on the sharing screen, for both role orders (R4) 0ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > saves numbered files with the fixed first line, never as a provider stage 67ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > moves to the next number when the numbered name already exists 1ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > recovers a crash after the hard link but before the temporary file is removed 32ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > recovers a crash before the link as "not saved" and asks for the paste again 5ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > recovers a crash after the database records published (leftover temp file of a successful save is quarantined) 3ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > shows a published save whose file was changed or removed as damaged, with mismatched content quarantined 8ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > survives a crash during the quarantine move and repeats it safely 6ms
stdout | tests/persist/smoke.test.ts > runs a task with real files and SQLite, and survives a reopen
[
  '1-draft-sent.json',
  '1-draft.md',
  '2-review-sent.json',
  '2-review.md',
  '3-synthesis-sent.json',
  '3-synthesis.md',
  'final-status.json',
  'packet.md',
  'sharing-plan.json'
]

 ✓ tests/persist/smoke.test.ts > runs a task with real files and SQLite, and survives a reopen 132ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > creates the schema with a migration record and survives reopening 15ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > a transaction that throws changes nothing, in memory or on disk 11ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > a crash before the transaction leaves none of it; a crash after leaves all of it 8ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > writes only changed rows, keeps order, and deletes removed rows 10ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > refuses a store written by a newer schema 11ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > has the happy path queued → drafting → reviewing → synthesizing → validating → complete 2ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > includes needs attention as an outcome of validating (C2) 1ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > has failed, cancelling, cancelled and interrupted as explicit alternatives from every running stage 0ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > never leaves a terminal state (late or duplicate events cannot change it) 2ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > cannot skip stages 0ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > treats cancellation unconfirmed as active (blocks retry and deletion) 0ms
 ✓ tests/static/boundaries.test.ts > source boundaries > never starts a process, opens a network connection, or uses git 32ms
 ✓ tests/static/boundaries.test.ts > source boundaries > never writes with node:fs; reads only the built renderer (main) and resolves the test folder path (real-folder) 4ms
 ✓ tests/static/boundaries.test.ts > source boundaries > never references the real business folders or repositories, except to refuse them 3ms
 ✓ tests/static/boundaries.test.ts > source boundaries > the native helper offers only the F3 operations (no rename, overwrite, truncate, process or network calls) 3ms
 ✓ tests/static/boundaries.test.ts > source boundaries > only the main process and the persistence layer load the native helper; the interface never does 3ms
 ✓ tests/static/boundaries.test.ts > source boundaries > never renders generated content as HTML 1ms
 ✓ tests/static/boundaries.test.ts > source boundaries > has no Apply, Merge or Approve changes controls 1ms
 ✓ tests/static/boundaries.test.ts > preload > exposes exactly the allow-listed operations, plus onChanged 0ms
 ✓ tests/static/boundaries.test.ts > preload > exposes no generic IPC, filesystem, process or event object 0ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > uses contextIsolation, sandbox, no node integration and web security 1ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > has a restrictive CSP with no remote scripts or unsafe evaluation 1ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > serves only files inside the built renderer folder 1ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > allows requests only to the app origin 0ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > accepts IPC only from the app window's main frame on the app origin 0ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > main process denies navigation, new windows, webviews, downloads and permissions, and validates the sender 0ms
 ✓ tests/persist/folders.test.ts > choosing a test folder > accepts a plain folder with a fictional RULES.md 8ms
 ✓ tests/persist/folders.test.ts > choosing a test folder > refuses a missing RULES.md, an unknown business, a link, a relative path, and this app's repository 8ms
 ✓ tests/persist/folders.test.ts > choosing a test folder > refuses real business folder names wherever they appear (checked without touching them) 5ms
 ✓ tests/persist/folders.test.ts > choosing a test folder > re-reads the path and RULES.md every time: a change is seen at once 3ms
 ✓ tests/persist/folders.test.ts > real folder file access > works only inside app-records/ and lists folders without following symlinks 8ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > success > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 1937ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > review fails > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 1112ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > a crash after final-status.json says complete but before the database records it keeps "complete" 78ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > shows dispatch as uncertain when the app stopped after dispatch started but before it was confirmed (C3) 28ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the simulation banner on every screen 758ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > shows "prepared; not dispatched" when the app stopped after -sent.json but before dispatch started (C3) 13ms
 ✓ tests/ui/persistent.test.tsx > persistent mode interface > chooses a test folder through the main-process picker, registers it, runs a task and writes real records 1029ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > survives repeated crashes during recovery itself 267ms
 ✓ tests/ui/app.test.tsx > simulated app interface > lists the two fictional projects and refuses a second project for the same business 441ms
 ✓ tests/ui/app.test.tsx > simulated app interface > composer defaults to Claude drafting and Codex reviewing; switching shows the other order on the sharing preview 355ms
 ✓ tests/ui/app.test.tsx > simulated app interface > creates a task, shows the sharing screen, runs it and shows three provider-labelled outputs with export-only wording 854ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > success > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 1812ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > review fails > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 1064ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > a crash after final-status.json says complete but before the database records it keeps "complete" 79ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows every outcome and record-state display from the showcase tasks 1600ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > shows dispatch as uncertain when the app stopped after dispatch started but before it was confirmed (C3) 25ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > shows "prepared; not dispatched" when the app stopped after -sent.json but before dispatch started (C3) 14ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > survives repeated crashes during recovery itself 253ms
 ✓ tests/core/recovery.test.ts > recovery details > quarantines a mismatched record file and a leftover temporary file, and lists them as not valid records 14ms
 ✓ tests/core/recovery.test.ts > recovery details > handles quarantine name collisions with -2, -3 and is repeatable 1ms
 ✓ tests/core/recovery.test.ts > recovery details > repeats a quarantine move after a crash between the link and the removal 1ms
 ✓ tests/core/recovery.test.ts > recovery details > rule (b): adopts a consistent published final-status.json when the database has no outcome 8ms
 ✓ tests/core/recovery.test.ts > recovery details > rule (b) refuses an inconsistent final-status.json, quarantines it and falls to (c) interrupted 9ms
 ✓ tests/core/recovery.test.ts > recovery details > damage after completion never changes the outcome: "Complete — record damaged", before and after restart 8ms
 ✓ tests/core/recovery.test.ts > recovery details > marks queued and running attempts interrupted at once, never resuming them 77ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the sharing screen for the Codex-drafts role order 408ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the F5 inventory with its warning, and saves a pasted outside review 490ms
 ✓ tests/persist/restart.test.ts > crash at every boundary, then a real relaunch (claude drafting) > gives exactly one outcome, never changes a decided outcome, never re-runs a stage, and leaves no temporary file 6862ms
 ✓ tests/ui/app.test.tsx > simulated app interface > cancels a running attempt from the interface 694ms
 ✓ tests/ui/app.test.tsx > simulated app interface > simulated crash and restart marks running work interrupted, through the interface 664ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the connection page as simulated and every checklist row unverified 311ms
 ✓ tests/persist/restart.test.ts > crash at every boundary, then a real relaunch (codex drafting) > gives exactly one outcome, never changes a decided outcome, never re-runs a stage, and leaves no temporary file 6324ms
 ✓ tests/persist/restart.test.ts > C1 on real disk > republishes the exact final-status.json bytes kept with the outcome, never rebuilding the file list from disk 66ms
 ✓ tests/persist/restart.test.ts > outside changes to a real folder > a record changed outside the app shows "Complete — record damaged", and the next start quarantines it without changing the outcome 61ms
 ✓ tests/persist/restart.test.ts > outside changes to a real folder > a RULES.md change during a run blocks every later write into the real folder; after restoring it, the next start finishes the record 90ms
 ✓ tests/persist/restart.test.ts > outside changes to a real folder > a symlink planted where the task folder goes: the write is refused with the path, and nothing is written elsewhere 21ms
 ✓ tests/persist/restart.test.ts > outside changes to a real folder > outside reviews are saved as real files, survive a relaunch, and removing the task leaves the folder byte for byte unchanged 108ms

 Test Files  16 passed (16)
      Tests  190 passed (190)
   Start at  00:24:03
   Duration  14.48s (tests 82%, environment 12%, import 4%, transform 2%)

exit: 0
```

### Electron smoke test output, persistent (verbatim)

```
SMOKE-PERSIST {"phase":"run","electron":"44.9.3","attemptA":"a-008fe12b14123ff1","stateA":"complete","attemptB":"a-bb630d5872f1f7d7","stateB":"reviewing","filesA":["1-draft-sent.json","1-draft.md","2-review-sent.json","2-review.md","3-synthesis-sent.json","3-synthesis.md","final-status.json","packet.md","sharing-plan.json"]}
  ok: launch 1: attempt A completed
  ok: launch 1: attempt A has nine record files
  ok: launch 1: quit while attempt B was reviewing
SMOKE-PERSIST {"phase":"verify","electron":"44.9.3","page":{"banner":true,"persistentNote":true,"projectRows":1},"projects":1,"tasks":2,"attempts":[{"id":"a-008fe12b14123ff1","state":"complete","final":true,"record":"intact","unresolved":[]},{"id":"a-bb630d5872f1f7d7","state":"interrupted","final":true,"record":"intact","unresolved":["review"]}]}
  ok: launch 2: project and both tasks survived the relaunch
  ok: launch 2: attempt A still complete, record intact
  ok: launch 2: attempt B interrupted by start-up recovery, record intact
  ok: launch 2: attempt B review stage marked not confirmed stopped
  ok: launch 2: window shows the banner, persistent mode and the project
  ok: SQLite store is in the data folder
  ok: test folder holds only RULES.md and app-records/
  ok: RULES.md unchanged
SMOKE-PERSIST PASSED
exit: 0
```

### Electron smoke test output, showcase (verbatim)

```
SMOKE {"banner":true,"hasRequire":false,"hasProcess":false,"heloKeys":["archiveProject","cancelAttempt","chooseTestFolder","createTask","deleteProject","deleteTask","exportArtifacts","getConnection","getEvents","getInventory","getMode","getTask","listProjects","listScenarios","listSimFolders","listTasks","onChanged","previewSharing","registerProject","renameProject","resolveCancellation","saveOutsideReview","simulateCrashAndRestart","simulateDamage","startAttempt"],"projects":2,"windowOpenResult":"denied","evalBlocked":true,"fetchBlocked":true,"notificationPermission":"denied","badInputRejected":true,"locationAfterNavigationAttempt":"app://helo/index.html","windowsBefore":1,"windowsAfter":1,"contextIsolation":true,"sandbox":true,"nodeIntegration":false,"webSecurity":true,"electron":"44.9.3"}
SMOKE PASSED
exit: 0
```

## 4. What was not done

**Out of scope per the brief, not done:**
- No real calls to Codex, Claude, OpenAI or Anthropic; the adapters stay fake.
- No real business repository or folder read or written.
- No git operations by the app; no packaging, signing, auto-update, telemetry or distribution.

**Not done in this step:**
- **Importing context files from a real test folder.** A task in a real folder uses `RULES.md` only. Importing selected files safely (the plan's rules on symlinks, devices, size, encoding and secrets) is its own piece of work.
- **The plan's tables `context_sources`, `task_context_snapshots`, `provider_runs` and `transmission_manifests`** don't exist under those names. Snapshots live inside the task row, and the dispatch journal and artifacts tables cover runs and manifests.

**Not verified:**
- **A real full disk** can't be produced on demand, so disk-full is still simulated by injecting the error. Real permission errors are tested.
- **Durability against power loss** isn't something a test can prove. The code requests `F_FULLFSYNC` for record files and folders, and SQLite runs with `synchronous = FULL` and `fullfsync = ON`. Tests turn off the full flush for speed but keep ordinary `fsync`; the app keeps it on.
- **Electron security guidance** was again not re-checked online, and Electron fuses and the packaged build are still untested, since packaging is out of scope.

**Known limits:**
- **Real folders on other kinds of disks:** the helper was tested on the Mac's own disk (APFS). Network drives and other file systems weren't tested.
- **Cleared app data:** if you delete the app's data folder, the store starts empty. The records already written in a test folder stay, but the app no longer knows about them. Re-adopting them is not implemented.

## 5. How C1 was settled

C1 asks for two things.

**1. Republishing never rebuilds the file list from disk.** When an outcome is decided, the finalizing record stores the exact bytes and hash of `final-status.json`, including its file list taken from the database, never from disk. Since persistence v1 that record lives in SQLite (the `attempts` table), so it survives relaunches. Every republish, whether recovery rule (a) on a not-yet-final attempt or repairing a missing file on a final one, writes those stored bytes. A test deletes `final-status.json`, adds an extra file to the attempt folder, relaunches, and checks the rewritten file is byte-identical, with no extra file in its list.

**2. Align the plan's validation line with recovery.** Proposed wording for the plan. Claude hasn't edited the plan; Omar may want to adopt this:

> Already-final attempts keep their outcome and are otherwise left alone, except that recovery republishes a missing `final-status.json` from the stored finalizing bytes, and moves a mismatched copy to quarantine first. Their record state is always recomputed.

This is what the code does. Simulated v1 introduced it after Codex finding 2, and it is now durable.

---

The code is on branch `build/persistence-v1`, in local commits. Nothing is pushed or merged. The independent Codex review comes next, and Ahmed runs it. Codex should review the native helper and its list of system calls in particular.

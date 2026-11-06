# Build report: Helo Workspace app, persistence v1

Claude Code session, 2026-11-06 to 2026-11-07, in `~/Desktop/Helo-Shared/helo-workspace-app/`, on branch `build/persistence-v1` (started from `build/simulated-v1` at `4c13917`). Written for the brief `docs/Build-Brief-Persistence-v1.md`, which Ahmed approved in chat on 2026-11-06 ("Approved, start") after choosing option A. That brief builds on the plan `docs/Implementation-Plan-DRAFT.md`, revision 7.

**The app still makes no real AI calls.** The adapters are still the fake ones from simulated v1. Nothing starts a provider program, opens a network connection or runs git. The banner on every screen still says "SIMULATION: no real AI calls".

**Revised after the independent Codex review of `dbb2fa4`** (run by Ahmed, 2026-11-07). Codex found three High and three Medium findings. All are fixed, with regression tests; see section 6. Two fixes needed Ahmed's decision, and he approved both in chat:
- F3 publication now uses a no-replace move instead of a hard link plus removal, so the app never deletes anything;
- the C1 wording goes to Omar as an amendment (`docs/Plan-Amendment-Persistence-v1.md`).

This report describes the code after those fixes.

What is new is that run state and task records are now **real**:
- run state is kept in a SQLite store in the app's own data folder;
- task records are written as files into a **fictional test folder Ahmed chooses**, by a small native helper that follows the plan's F3 rules.

Nothing outside a chosen test folder's `app-records/` folder is ever written, and real business folders are refused.

## 1. What was built

### The native helper (option A): `src/native/safe_publish.c`

This is about 450 lines of C written against Node-API. It is the only code in the app that writes into a project folder, and it offers exactly nine operations. **None of them deletes anything.**

| Operation | What it does |
|---|---|
| `openRoot(path)` | Opens the project root as a handle, refusing a symlink anywhere in the path (`O_NOFOLLOW_ANY`), and checks it's a folder. |
| `identity(fd)` | Returns the open folder's device and inode. The app records this at registration and checks it before every write. |
| `openSub(rootFd, segments, create)` | Opens a folder relative to the root handle, one component at a time, without following symlinks (`O_DIRECTORY \| O_NOFOLLOW`). Missing folders are created only when asked, and each new entry is flushed in its parent. |
| `createExclusive(fd, name, data, fullSync)` | Creates a new file relative to the handle (`O_CREAT \| O_EXCL \| O_NOFOLLOW`), writes it and flushes it (`F_FULLFSYNC` on macOS). If writing fails, the file is left in place, never deleted; it is moved to quarantine. |
| `moveNoReplace(srcFd, name, destFd, destName, fullSync)` | **The only way anything moves:** an atomic `renameatx_np` with `RENAME_EXCL`, which fails with EEXIST if the destination exists. It then flushes both folders. It is used to publish records and to move files into quarantine. |
| `readFile(fd, name, max)` | Reads a regular file only, checking the type before opening. It opens with `O_NONBLOCK`, so a FIFO or device put in place of a record can't hang it. It never reads through a symlink and has a size limit. |
| `fsyncDir`, `listDir`, `closeDir` | Flush a folder; list it without following links; close a handle. |

Names must be a single plain component: `""`, `.`, `..` and anything containing `/` or NUL are refused. The helper has no unlink, plain rename, link, truncate, chmod, symlink, process or network call. A static test checks the C code, with comments removed, for each of these, and that `renameatx_np` appears exactly once, with the no-replace flag.

It is built by `npm run build:native` (`scripts/build-native.mjs`). That uses the node-gyp that comes inside npm, with `--nodedir` pointing at the Node headers already on this Mac, so **nothing is downloaded**; the build log was checked for this. npm's own automatic add-on build on `npm install` is turned off (`"gypfile": false`), because it would download headers. The same compiled file loads in Node 24.21.0 and inside Electron 44.9.3 (Node 24.22.0, Node-API 10), which was checked first.

### The rest of the persistence layer: `src/persist/`

- **`real-fs.ts` (`RealCloneFs`)**: the real folder seen through the same storage interface the engine already used for the in-memory folder.
  - Every operation goes through the helper, and it only works inside `app-records/`.
  - It never imports `node:fs`.
  - **Every write first opens the root handle and checks it:** its identity must match the one recorded at registration, and the `RULES.md` read through that same handle must still name the registered business. Only then is the target folder opened relative to that handle. So the folder that was checked is the folder written to, and a root folder swapped after the check can't redirect a write. Before registration, every write is refused.
  - One folder handle is held for each whole publication: create the temporary file, move it into place with no replace, close.
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
- **Publication and quarantine use the no-replace move** (approved F3 change). Publishing is: create the temporary file exclusively, flush it, move it to its final name without replacing. A quarantine move is a single atomic move, so a crash leaves the file either still in place or already in quarantine, and recovery just repeats.
- **A failed publication never deletes anything.** The app's own temporary file goes to quarantine. A `.tmp-` name that existed before (someone else's) is left alone.
- **Recovery is per attempt.** One damaged attempt folder (an unreadable or odd entry) is noted in the log, and recovery goes on for the others. Start-up recovery can't stop the window from opening.
- Projects can now live in real folders. The folder's identity is stored with the project. Projects stored in SQLite get their real folder, with its identity check, back when the app reopens.

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
| Unit, real-disk, process-kill and interface tests | `npx vitest run --reporter=verbose` | **17 files, 200 tests, all passed**, exit 0 (`vitest.txt`) |
| Electron smoke test, showcase | `electron . --smoke-test` | `SMOKE PASSED`, exit 0 (`electron-smoke-showcase.txt`) |
| Electron smoke test, persistent (two launches) | `node scripts/smoke-persist.mjs` | `SMOKE-PERSIST PASSED`, exit 0 (`electron-smoke-persist.txt`) |

### What the new tests cover (all on real temporary folders, created and deleted by the tests)

**Process-kill tests** (`tests/persist/kill.test.ts`, 3): **357 real process kills**.
- A separate Node process runs the compiled engine on a real test folder and SQLite file, and kills itself with SIGKILL at a boundary. No exception, no clean-up, and the database is left open.
- This is repeated at every boundary of a full run:
  - a successful run in each role order, 135 boundaries each;
  - a run whose review fails, 87 boundaries.

  Those totals include 37 (and 24) points **inside an open SQL transaction, after some rows have already changed**.
- After each kill, a fresh workspace opens the leftover files and runs start-up recovery. Each run must end with:
  - exactly one attempt with exactly one outcome, final;
  - an intact record and no `.tmp-` file left;
  - `final-status.json` byte-identical to the stored bytes;
  - nothing dispatched by recovery.
  - A second relaunch must change nothing.

**Engine on real disk** (`tests/persist/restart.test.ts`, 16; most in both role orders). Here a "relaunch" means a new workspace opened from the same SQLite file and folder, in the same process.
- A full run writes all nine records and leaves everything outside `app-records/` byte for byte unchanged, including `RULES.md`, other files and a `.git/` folder. It survives a relaunch.
- Quitting while a stage runs leads to interrupted, and a retry then needs acknowledgement.
- **A crash at every boundary** (270 runs, including the in-transaction ones), with the same checks as the kill tests.
- **C1:** a deleted `final-status.json` is written back byte-identical, without an extra file that was added to the folder.
- A record edited by hand shows "Complete — record damaged", and the next start moves it into quarantine.
- A `RULES.md` change during a run blocks every later write.
- A symlink planted where the task folder goes is refused, with the path.
- Outside reviews are saved as real files, and removing the task or project leaves the folder unchanged.
- Regression tests for the Codex findings:
  - **the root folder swapped mid-run for an impostor with a matching `RULES.md`:** nothing is written into it, and the record is finished once the original is back;
  - **a FIFO and a 17 MB file in place of records:** start-up recovery doesn't hang and still recovers the other attempt, and the record shows damaged;
  - **a failed publication** leaves no temporary file;
  - **F4 on real disk:** a crash at each outside-review boundary;
  - **repeated crashes during start-up recovery itself, on real disk.**

**Native helper** (`tests/persist/native.test.ts`, 11):
- it offers no delete operation at all;
- publishing by no-replace move;
- EEXIST from both the exclusive create and the move, with nothing replaced and the temporary file kept;
- a destination created by another process is never replaced;
- symlinks are refused at the root, anywhere in the root path, at a folder level and as a file;
- **the root folder swapped after it was opened and checked:** the write still lands in the checked folder, and a fresh open sees a different identity;
- a lower folder swapped after it was opened;
- quarantine moves across two handles never replace anything;
- invalid names are refused;
- **a FIFO is refused at once without hanging**, and size is limited;
- a real permission error comes back with its code and the name.

**Other new tests:**
- **SQLite store** (`tests/persist/sqlite.test.ts`, 6):
  - schema and migration record, and WAL;
  - a transaction that throws changes nothing;
  - **a crash after some rows were already changed inside the SQL transaction rolls all of it back**, in memory and on disk;
  - a crash before or after a transaction leaves none or all of it;
  - only changed rows are written; deletions; a newer schema is refused.
- **Choosing folders** (`tests/persist/folders.test.ts`, 5): every refusal rule; `RULES.md` re-read on every check; writes refused until the folder is registered; access limited to `app-records/`; a symlinked folder listed but never followed.
- **Persistent interface** (`tests/ui/persistent.test.tsx`, 1): choose a folder through the main-process picker, register it, run a task, and find the nine real files and the inventory paths.
- **Static checks** (`tests/static/boundaries.test.ts`, 15):
  - no `node:fs` writes anywhere, and `node:fs` used only in two files with named read-only functions;
  - the C helper's forbidden calls, its single no-replace move, and its list of exported operations;
  - only the main process and the persistence layer load the helper;
  - real business folder names appear only in the code that refuses them.
- **Engine and simulation** (`tests/core`, 132): the simulated-v1 tests still pass against the in-memory folder. Tests that named the old link-and-remove steps were updated to the no-replace move.

**Electron smoke tests:**
- The **showcase** smoke test is unchanged from simulated v1 and still passes.
- The **persistent** smoke test launches the real app twice:
  - **Launch 1** completes an attempt and quits while a second attempt is reviewing.
  - **Launch 2** runs start-up recovery and finds attempt A complete and intact, and attempt B interrupted and intact, with its review stage marked "not confirmed stopped".

### Test output (verbatim, `npx vitest run --reporter=verbose`)

```
 RUN  v5.0.5 /Users/ahmedelhelaly/Desktop/Helo-Shared/helo-workspace-app

 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > completes three stages, each produced by the right provider, with unresolved issues kept 60ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > reports "no issues reported" when the review has no findings 9ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > gives needs attention for an unmet acceptance criterion, with all nine record files 10ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is fail, and never forwards rejected output 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is fail, and never forwards rejected output 24ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when synthesis is fail, and never forwards rejected output 13ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is refuse, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is refuse, and never forwards rejected output 10ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when synthesis is malformed, and never forwards rejected output 10ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is empty, and never forwards rejected output 5ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is duplicate-final, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is missing-final, and never forwards rejected output 5ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is wrong-hash, and never forwards rejected output 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is tool-event, and never forwards rejected output 10ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is truncated, and never forwards rejected output 2ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when synthesis is wrong-provenance, and never forwards rejected output 11ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > rejects a synthesis that omits a review finding 14ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > creates the schema with a migration record and survives reopening 17ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > a transaction that throws changes nothing, in memory or on disk 14ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > a crash before the transaction leaves none of it; a crash after leaves all of it 11ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > a crash after some rows were already changed inside the SQL transaction rolls all of it back 13ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > writes only changed rows, keeps order, and deletes removed rows 9ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > refuses a store written by a newer schema 11ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > sends exactly the R4 payloads, and each -sent.json hash matches the bytes actually sent 10ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > does not dispatch a stage whose -sent.json cannot be published 2ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails with "collision" and replaces nothing when a record name already exists 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > shows disk-full and permission failures with the path 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > keeps the outcome when final-status.json cannot be written, and republishes it on restart 20ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > ignores a duplicate submission (same idempotency key) 10ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > refuses a start whose approval does not match the frozen packet 2ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > cancels during the review: the owned process confirms exit and the outcome is cancelled 42ms
 ✓ tests/persist/restart.test.ts > on real disk (claude drafting) > completes, writes all nine records, touches nothing outside app-records/, and survives a relaunch 191ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > turns a stage timeout into failed through cancellation semantics 60ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > shows cancellation unconfirmed when the process ignores cancellation, blocks retry, quarantines the late result, and resolves explicitly 36ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > a late result after a confirmed cancel cannot change the terminal state 33ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > a new attempt re-runs all three stages from the frozen packet and keeps the earlier attempt 23ms
 ✓ tests/persist/restart.test.ts > on real disk (claude drafting) > quitting while a stage runs: after the relaunch the attempt is interrupted, and a retry needs acknowledgement 212ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > completes three stages, each produced by the right provider, with unresolved issues kept 9ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > reports "no issues reported" when the review has no findings 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > gives needs attention for an unmet acceptance criterion, with all nine record files 9ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is fail, and never forwards rejected output 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is fail, and never forwards rejected output 5ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when synthesis is fail, and never forwards rejected output 19ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is refuse, and never forwards rejected output 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is refuse, and never forwards rejected output 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when synthesis is malformed, and never forwards rejected output 7ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is empty, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is duplicate-final, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is missing-final, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is wrong-hash, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is tool-event, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is truncated, and never forwards rejected output 7ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when synthesis is wrong-provenance, and never forwards rejected output 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > rejects a synthesis that omits a review finding 5ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > sends exactly the R4 payloads, and each -sent.json hash matches the bytes actually sent 11ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > does not dispatch a stage whose -sent.json cannot be published 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails with "collision" and replaces nothing when a record name already exists 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > shows disk-full and permission failures with the path 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > keeps the outcome when final-status.json cannot be written, and republishes it on restart 9ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > ignores a duplicate submission (same idempotency key) 9ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > refuses a start whose approval does not match the frozen packet 1ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > cancels during the review: the owned process confirms exit and the outcome is cancelled 6ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > offers no way to delete anything 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > turns a stage timeout into failed through cancellation semantics 43ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > shows cancellation unconfirmed when the process ignores cancellation, blocks retry, quarantines the late result, and resolves explicitly 30ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > a late result after a confirmed cancel cannot change the terminal state 29ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > a new attempt re-runs all three stages from the frozen packet and keeps the earlier attempt 15ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > creates folders, writes a temporary file exclusively and publishes it with a no-replace move 100ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > never replaces an existing file: exclusive create and the publishing move both fail with EEXIST, and the temporary file is kept 5ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > a destination created by another process after the temporary file was made is never replaced 21ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > refuses a symlink at the root, anywhere in the root path, at any folder level, and as a file 6ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > the root folder swapped after it was opened and checked cannot redirect the write (F2 check tied to the write handle) 43ms
 ✓ tests/persist/restart.test.ts > on real disk (codex drafting) > completes, writes all nine records, touches nothing outside app-records/, and survives a relaunch 264ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > a folder below the root swapped after it was opened cannot redirect the write either 100ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > moves into quarantine across two folder handles without replacing anything 41ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > rejects names that are not a single plain component 1ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > reads regular files only: a FIFO is refused at once without hanging, and size is limited 48ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > reports a permission error with its code and the name 57ms
 ✓ tests/persist/restart.test.ts > on real disk (codex drafting) > quitting while a stage runs: after the relaunch the attempt is interrupted, and a retry needs acknowledgement 224ms
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

 ✓ tests/core/seed.test.ts > seeded showcase > produces every required state using the real (simulated) engine 340ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (claude drafting) > cancellation unconfirmed with a confirmed dispatch → restart → interrupted still requires acknowledgement before a retry 74ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (claude drafting) > a crash after the dispatch was confirmed but before any result also requires acknowledgement 55ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (claude drafting) > does not ask when every dispatched stage ended (result, confirmed stop, or explicit resolution) 36ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (codex drafting) > cancellation unconfirmed with a confirmed dispatch → restart → interrupted still requires acknowledgement before a retry 31ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (codex drafting) > a crash after the dispatch was confirmed but before any result also requires acknowledgement 55ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (codex drafting) > does not ask when every dispatched stage ended (result, confirmed stop, or explicit resolution) 39ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > quarantines a corrupted published record of a finished attempt; the outcome is unchanged and the record shows quarantined 11ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > republishes a missing final-status.json of an already-final attempt with the same bytes and outcome 10ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > a changed final-status.json of a final attempt is quarantined and replaced with the recorded bytes 6ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > a published record corrupted while the attempt was running is quarantined and stays required (damaged, not intact) 4ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > refuses "complete" with matching IDs when the published files cannot support it 1ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines JSON null and settles interrupted without throwing 13ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines a list and settles interrupted without throwing 14ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines a null file entry and settles interrupted without throwing 10ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines a file entry without a hash and settles interrupted without throwing 12ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines files not a list and settles interrupted without throwing 8ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines not JSON and settles interrupted without throwing 9ms
 ✓ tests/core/review-findings.test.ts > finding 4 (Medium): project identity is rechecked before every write > a RULES.md business change during a run blocks every later write; the attempt still gets exactly one outcome 31ms
 ✓ tests/core/review-findings.test.ts > finding 4 (Medium): project identity is rechecked before every write > a folder path change also blocks writes 1ms
 ✓ tests/core/review-findings.test.ts > re-review regression (Medium): a blocked project is still reconciled before its outcome is settled > a record published just before the crash stays required when recovery runs while blocked (claude drafting) 4ms
 ✓ tests/core/review-findings.test.ts > re-review regression (Medium): a blocked project is still reconciled before its outcome is settled > a record published just before the crash stays required when recovery runs while blocked (codex drafting) 4ms
 ✓ tests/core/review-findings.test.ts > re-review regression (Medium): a blocked project is still reconciled before its outcome is settled > a mismatched intended record is never counted as published while blocked, and is quarantined after the unblock 6ms
 ✓ tests/core/review-findings.test.ts > re-review regression (Medium): a blocked project is still reconciled before its outcome is settled > an unadoptable final-status.json left while blocked is quarantined after the unblock, and the recorded bytes are published 8ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > success > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 1881ms
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

 ✓ tests/persist/smoke.test.ts > runs a task with real files and SQLite, and survives a reopen 429ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > complete and needs attention require all nine 2ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > failed, cancelled and interrupted require final-status.json plus exactly the frozen list 0ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > rejects inconsistent lists (a gap, or complete without every stage) 1ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > each real outcome publishes exactly its required files (claude drafting) 53ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > each real outcome publishes exactly its required files (codex drafting) 35ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > a cancelled attempt requires what was published before cancellation 4ms
 ✓ tests/core/records.test.ts > F5 inventory > lists record files, outside reviews, temporary leftovers and quarantine content exactly, with full paths 19ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > saves numbered files with the fixed first line, never as a provider stage 25ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > moves to the next number when the numbered name already exists 2ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > recovers a crash after the no-replace move, before the database records it 3ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > recovers a crash before the link as "not saved" and asks for the paste again 2ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > recovers a crash after the database records published (leftover temp file of a successful save is quarantined) 2ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > shows a published save whose file was changed or removed as damaged, with mismatched content quarantined 2ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > survives a crash during the quarantine move and repeats it safely 1ms
 ✓ tests/persist/folders.test.ts > choosing a test folder > accepts a plain folder with a fictional RULES.md 9ms
 ✓ tests/persist/folders.test.ts > choosing a test folder > refuses a missing RULES.md, an unknown business, a link, a relative path, and this app's repository 9ms
 ✓ tests/persist/folders.test.ts > choosing a test folder > refuses real business folder names wherever they appear (checked without touching them) 6ms
 ✓ tests/persist/folders.test.ts > choosing a test folder > re-reads the path and RULES.md every time: a change is seen at once 4ms
 ✓ tests/persist/folders.test.ts > real folder file access > works only inside app-records/ and lists folders without following symlinks 114ms
 ✓ tests/static/boundaries.test.ts > source boundaries > never starts a process, opens a network connection, or uses git 23ms
 ✓ tests/static/boundaries.test.ts > source boundaries > never writes with node:fs; reads only the built renderer (main) and resolves the test folder path (real-folder) 6ms
 ✓ tests/static/boundaries.test.ts > source boundaries > never references the real business folders or repositories, except to refuse them 3ms
 ✓ tests/static/boundaries.test.ts > source boundaries > the native helper offers only the F3 operations (no delete, plain rename, overwrite, truncate, process or network calls) 6ms
 ✓ tests/static/boundaries.test.ts > source boundaries > only the main process and the persistence layer load the native helper; the interface never does 5ms
 ✓ tests/static/boundaries.test.ts > source boundaries > never renders generated content as HTML 1ms
 ✓ tests/static/boundaries.test.ts > source boundaries > has no Apply, Merge or Approve changes controls 3ms
 ✓ tests/static/boundaries.test.ts > preload > exposes exactly the allow-listed operations, plus onChanged 1ms
 ✓ tests/static/boundaries.test.ts > preload > exposes no generic IPC, filesystem, process or event object 0ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > uses contextIsolation, sandbox, no node integration and web security 1ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > has a restrictive CSP with no remote scripts or unsafe evaluation 2ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > serves only files inside the built renderer folder 0ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > allows requests only to the app origin 2ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > accepts IPC only from the app window's main frame on the app origin 0ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > main process denies navigation, new windows, webviews, downloads and permissions, and validates the sender 0ms
 ✓ tests/core/projects.test.ts > F2 projects > refuses a second project for the same folder or the same business, a RULES.md mismatch, and a missing RULES.md 7ms
 ✓ tests/core/projects.test.ts > F2 projects > blocks a project whose RULES.md business line changed, until it is registered again 7ms
 ✓ tests/core/projects.test.ts > F2 projects > archived projects cannot start tasks 1ms
 ✓ tests/core/projects.test.ts > F2 projects > a task can use sources from its own project folder only 1ms
 ✓ tests/core/projects.test.ts > F2 projects > keeps project records in their own clone: project A writes nothing into project B 28ms
 ✓ tests/core/projects.test.ts > F6 deleting > removes only the app records and leaves the clone byte-for-byte unchanged 8ms
 ✓ tests/core/projects.test.ts > F6 deleting > blocks deletion while an attempt is running 1ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > rejects unknown operations and malformed or oversized input 1ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > derives ownership from stored records: a project ID from the renderer cannot reach another project 1ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > refuses a drafter equal to the reviewer by construction: the reviewer is always the other provider 1ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > names the actual providers in order on the sharing screen, for both role orders (R4) 0ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > has the happy path queued → drafting → reviewing → synthesizing → validating → complete 2ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > includes needs attention as an outcome of validating (C2) 1ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > has failed, cancelling, cancelled and interrupted as explicit alternatives from every running stage 0ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > never leaves a terminal state (late or duplicate events cannot change it) 3ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > cannot skip stages 0ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > treats cancellation unconfirmed as active (blocks retry and deletion) 0ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > review fails > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 1068ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > a crash after final-status.json says complete but before the database records it keeps "complete" 55ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > shows dispatch as uncertain when the app stopped after dispatch started but before it was confirmed (C3) 30ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > shows "prepared; not dispatched" when the app stopped after -sent.json but before dispatch started (C3) 15ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the simulation banner on every screen 893ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > survives repeated crashes during recovery itself 244ms
 ✓ tests/ui/app.test.tsx > simulated app interface > lists the two fictional projects and refuses a second project for the same business 443ms
 ✓ tests/ui/persistent.test.tsx > persistent mode interface > chooses a test folder through the main-process picker, registers it, runs a task and writes real records 1461ms
 ✓ tests/ui/app.test.tsx > simulated app interface > composer defaults to Claude drafting and Codex reviewing; switching shows the other order on the sharing preview 377ms
 ✓ tests/ui/app.test.tsx > simulated app interface > creates a task, shows the sharing screen, runs it and shows three provider-labelled outputs with export-only wording 885ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > success > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 1796ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > review fails > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 1045ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > a crash after final-status.json says complete but before the database records it keeps "complete" 57ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > shows dispatch as uncertain when the app stopped after dispatch started but before it was confirmed (C3) 24ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > shows "prepared; not dispatched" when the app stopped after -sent.json but before dispatch started (C3) 14ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows every outcome and record-state display from the showcase tasks 1597ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > survives repeated crashes during recovery itself 235ms
 ✓ tests/core/recovery.test.ts > recovery details > quarantines a mismatched record file and a leftover temporary file, and lists them as not valid records 15ms
 ✓ tests/core/recovery.test.ts > recovery details > handles quarantine name collisions with -2, -3, and never replaces an earlier quarantine copy 0ms
 ✓ tests/core/recovery.test.ts > recovery details > repeats a quarantine move after a crash: the move is atomic, so a repeat finds nothing left to move 0ms
 ✓ tests/core/recovery.test.ts > recovery details > rule (b): adopts a consistent published final-status.json when the database has no outcome 9ms
 ✓ tests/core/recovery.test.ts > recovery details > rule (b) refuses an inconsistent final-status.json, quarantines it and falls to (c) interrupted 8ms
 ✓ tests/core/recovery.test.ts > recovery details > damage after completion never changes the outcome: "Complete — record damaged", before and after restart 8ms
 ✓ tests/core/recovery.test.ts > recovery details > marks queued and running attempts interrupted at once, never resuming them 80ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the sharing screen for the Codex-drafts role order 424ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the F5 inventory with its warning, and saves a pasted outside review 530ms
 ✓ tests/ui/app.test.tsx > simulated app interface > cancels a running attempt from the interface 710ms
 ✓ tests/ui/app.test.tsx > simulated app interface > simulated crash and restart marks running work interrupted, through the interface 692ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the connection page as simulated and every checklist row unverified 327ms
 ✓ tests/persist/restart.test.ts > crash at every boundary, then a real relaunch (claude drafting) > gives exactly one outcome, never changes a decided outcome, never re-runs a stage, and leaves no temporary file 21545ms
 ✓ tests/persist/restart.test.ts > crash at every boundary, then a real relaunch (codex drafting) > gives exactly one outcome, never changes a decided outcome, never re-runs a stage, and leaves no temporary file 20893ms
 ✓ tests/persist/restart.test.ts > C1 on real disk > republishes the exact final-status.json bytes kept with the outcome, never rebuilding the file list from disk 208ms
 ✓ tests/persist/restart.test.ts > outside changes to a real folder > a record changed outside the app shows "Complete — record damaged", and the next start quarantines it without changing the outcome 197ms
 ✓ tests/persist/restart.test.ts > outside changes to a real folder > a RULES.md change during a run blocks every later write into the real folder; after restoring it, the next start finishes the record 170ms
 ✓ tests/persist/restart.test.ts > outside changes to a real folder > a symlink planted where the task folder goes: the write is refused with the path, and nothing is written elsewhere 17ms
 ✓ tests/persist/restart.test.ts > outside changes to a real folder > outside reviews are saved as real files, survive a relaunch, and removing the task leaves the folder byte for byte unchanged 247ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > finding 2: the root folder swapped for an impostor with a matching RULES.md mid-run gets nothing written to it 184ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > finding 3: a FIFO and an oversized file in place of records do not hang or stop start-up recovery for other attempts 286ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > finding 1: a failed publication never deletes anything: its own temporary file goes to quarantine, and a pre-existing .tmp- name is left alone 167ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > F4 on real disk: a crash at each outside-review boundary, then a relaunch, leaves a consistent save and no temporary file 437ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > repeated crashes during start-up recovery itself, on real disk 3407ms
 ✓ tests/persist/kill.test.ts > SIGKILL at every boundary (claude drafting, success) > relaunch gives exactly one outcome, intact records, no temporary file, and dispatches nothing 39805ms
 ✓ tests/persist/kill.test.ts > SIGKILL at every boundary (codex drafting, success) > relaunch gives exactly one outcome, intact records, no temporary file, and dispatches nothing 31330ms
 ✓ tests/persist/kill.test.ts > SIGKILL at every boundary (claude drafting, review-fails) > relaunch gives exactly one outcome, intact records, no temporary file, and dispatches nothing 18180ms

 Test Files  17 passed (17)
      Tests  200 passed (200)
   Start at  00:52:03
   Duration  90.19s (tests 96%, environment 2%, import 1%)

exit: 0
```

### Electron smoke test output, persistent (verbatim)

```
SMOKE-PERSIST {"phase":"run","electron":"44.9.3","attemptA":"a-1fb71ff885be9a5c","stateA":"complete","attemptB":"a-c0c7a359b9866ed6","stateB":"reviewing","filesA":["1-draft-sent.json","1-draft.md","2-review-sent.json","2-review.md","3-synthesis-sent.json","3-synthesis.md","final-status.json","packet.md","sharing-plan.json"]}
  ok: launch 1: attempt A completed
  ok: launch 1: attempt A has nine record files
  ok: launch 1: quit while attempt B was reviewing
SMOKE-PERSIST {"phase":"verify","electron":"44.9.3","page":{"banner":true,"persistentNote":true,"projectRows":1},"projects":1,"tasks":2,"attempts":[{"id":"a-1fb71ff885be9a5c","state":"complete","final":true,"record":"intact","unresolved":[]},{"id":"a-c0c7a359b9866ed6","state":"interrupted","final":true,"record":"intact","unresolved":["review"]}]}
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
- **Two programs writing into the same test folder at once.** The app never deletes anything, and every check runs on its own handles, but no test runs a hostile second program racing it. Such a program could still change or remove files itself; the app only guarantees it won't destroy or replace anything on its behalf.
- **A real full disk** can't be produced on demand, so disk-full is still simulated by injecting the error. Real permission errors are tested.
- **Durability against power loss** isn't something a test can prove. The code requests `F_FULLFSYNC` for record files and folders, and SQLite runs with `synchronous = FULL` and `fullfsync = ON`. Tests turn off the full flush for speed but keep ordinary `fsync`; the app keeps it on.
- **Electron security guidance** was again not re-checked online, and Electron fuses and the packaged build are still untested, since packaging is out of scope.

**Known limits:**
- **Real folders on other kinds of disks:** the helper was tested on the Mac's own disk (APFS). Network drives and other file systems weren't tested.
- **Cleared app data:** if you delete the app's data folder, the store starts empty. The records already written in a test folder stay, but the app no longer knows about them. Re-adopting them is not implemented.

## 5. How C1 was settled

C1 asks for two things.

**1. Republishing never rebuilds the file list from disk.** This is done in code, and is durable. When an outcome is decided, the finalizing record stores the exact bytes and hash of `final-status.json`, including its file list taken from the database, never from disk. That record lives in SQLite (the `attempts` table), so it survives relaunches and process kills. Every republish writes those stored bytes, whether recovery rule (a) on a not-yet-final attempt or repairing a missing file on a final one. The disk test and all 357 process-kill runs check that `final-status.json` is byte-identical to the stored bytes.

**2. Align the plan's validation line with recovery.** This is drafted, waiting for Omar. As Ahmed decided, Claude didn't edit the plan. The exact replacement wording is in `docs/Plan-Amendment-Persistence-v1.md`, section 3, together with the approved F3 change (section 1) and the F2 handle-check wording (section 2). C1 is fully settled once that wording is adopted.

## 6. Independent Codex review of `dbb2fa4`: findings and fixes

Ahmed ran the Codex review read-only on 2026-11-07. Claude checked each finding against the code before changing anything; all six were valid.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | Clean-up could delete a replacement file: identity was checked, then a separate by-name `unlinkat` ran, so another program could swap the file in between. Error clean-up deleted without any check, and a pre-existing `.tmp-` name could be removed. | **Approved F3 change:** publication and quarantine use the atomic no-replace move (`renameatx_np` with `RENAME_EXCL`). The helper has no delete call at all. A failed publication moves the app's own temporary file to quarantine; a pre-existing `.tmp-` name is left alone. |
| 2 | High | The F2 check (path and `RULES.md`) used different handles from the write, so the root could be swapped for another plain folder in between. | The folder's identity is recorded at registration. Every write opens the root handle once, checks its identity and the `RULES.md` read through it, then opens the target folder relative to that same handle. A regression test swaps the root for an impostor with a matching `RULES.md` mid-run; nothing is written into it. |
| 3 | High | A FIFO in place of a record could hang `readFile`, and an oversized record made recovery abort, so one damaged file could stop start-up recovery and the window. | `readFile` checks the type first and opens with `O_NONBLOCK`. An oversized or odd entry is treated as not a valid record (the record shows damaged). Recovery runs per attempt, and start-up recovery can't stop the window from opening. A regression test covers a FIFO and a 17 MB file at start-up. |
| 4 | Medium | New folders weren't flushed in their parents, and quarantine didn't flush the folder entry that makes it reachable. | Each folder the helper creates is flushed in its parent at once, and every move flushes both folders. |
| 5 | Medium | "Real relaunch at every boundary" overstated the tests: they threw an exception in one process. SQLite rollback after partial writes was untested, and real-disk coverage lacked the failure scenario, F4 and repeated recovery crashes. | Added 357 SIGKILL process kills at every boundary, in three cases, including points inside open SQL transactions; a SQLite rollback-after-partial-writes test; and real-disk tests for F4 and for repeated crashes during recovery. The report now says which tests relaunch in-process and which kill a real process. |
| 6 | Medium | C1 wasn't fully settled while the plan still said already-final attempts are "left alone". | As Ahmed decided, the exact wording is in `docs/Plan-Amendment-Persistence-v1.md` for Omar; see section 5. |

Codex also confirmed:
- no real provider calls, app git operations, network functionality or new packages;
- the native build uses local headers only;
- the SQLite transaction design is sound.

The fixes from this round haven't been reviewed by Codex again.

---

The code is on branch `build/persistence-v1`, in local commits. Nothing is pushed or merged. A second Codex pass over the review fixes, run by Ahmed, would confirm them.

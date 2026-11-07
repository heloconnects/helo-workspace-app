# Build report: Helo Workspace app, persistence v1

Claude Code session, 2026-11-06 to 2026-11-07, in `~/Desktop/Helo-Shared/helo-workspace-app/`, on branch `build/persistence-v1` (started from `build/simulated-v1` at `4c13917`). Written for the brief `docs/Build-Brief-Persistence-v1.md`, which Ahmed approved in chat on 2026-11-06 ("Approved, start") after choosing option A. That brief builds on the plan `docs/Implementation-Plan-DRAFT.md`, revision 7.

**The app still makes no real AI calls.** The adapters are still the fake ones from simulated v1. Nothing starts a provider program, opens a network connection or runs git. The banner on every screen still says "SIMULATION: no real AI calls".

**Revised after two rounds of independent Codex review** (run by Ahmed, 2026-11-07).
- The first round, of `dbb2fa4`, found three High and three Medium findings.
- The second round, of `994b0f6`, confirmed three of those resolved, marked two partly resolved, and found one new High and four new Medium problems.

Everything raised in both rounds is fixed in code, with regression tests, except C1's plan wording, which waits for Omar; see section 6. Two fixes needed Ahmed's decision, and he approved both in chat:
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
| `moveNoReplace(srcFd, name, destFd, destName)` | **The only way anything moves:** an atomic `renameatx_np` with `RENAME_EXCL`, which fails with EEXIST if the destination exists. It moves **only a regular file**: the source is opened and checked first, and that handle is held across the move. Afterwards the moved entry must be that very file (same device and inode). If something else was swapped in at the last moment, it is moved straight back and "ESWAPPED" is reported. It doesn't flush; the app flushes both folders as a separate step, so "moved but not flushed" can be told apart from "not moved". It is used to publish records and to move files into quarantine. |
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
| Unit, real-disk, process-kill and interface tests | `npx vitest run --reporter=verbose` | **17 files, 208 tests, all passed**, exit 0 (`vitest.txt`) |
| Electron smoke test, showcase | `electron . --smoke-test` | `SMOKE PASSED`, exit 0 (`electron-smoke-showcase.txt`) |
| Electron smoke test, persistent (two launches) | `node scripts/smoke-persist.mjs` | `SMOKE-PERSIST PASSED`, exit 0 (`electron-smoke-persist.txt`) |

### What the new tests cover (all on real temporary folders, created and deleted by the tests)

**Process-kill tests** (`tests/persist/kill.test.ts`, 5): **408 real process kills**.
- A separate Node process runs the compiled engine on a real test folder and SQLite file, and kills itself with SIGKILL at a boundary. No exception, no clean-up, and the database is left open.
- This is repeated at every boundary of a full run:
  - a successful run in each role order, 144 boundaries each, including the point between a move and its flush;
  - a run whose review fails, 93 boundaries;
  - saving an outside review, 8 boundaries;
  - start-up recovery itself, 19 boundaries: after a first kill, a second kill during recovery, and then a clean relaunch.

  Those totals include 37 (and 24) points **inside an open SQL transaction, after some rows have already changed**.
- After each kill, a fresh workspace opens the leftover files and runs start-up recovery. Each run must end with:
  - exactly one attempt with exactly one outcome, final;
  - an intact record and no `.tmp-` file left;
  - `final-status.json` byte-identical to the stored bytes;
  - nothing dispatched by recovery.
  - A second relaunch must change nothing.

**Engine on real disk** (`tests/persist/restart.test.ts`, 21; most in both role orders). Here a "relaunch" means a new workspace opened from the same SQLite file and folder, in the same process.
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

**Native helper** (`tests/persist/native.test.ts`, 12; one new test checks that a folder, symlink or FIFO at the source of a move is refused and left in place):
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

 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > completes three stages, each produced by the right provider, with unresolved issues kept 152ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > reports "no issues reported" when the review has no findings 39ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > gives needs attention for an unmet acceptance criterion, with all nine record files 17ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (claude drafting) > cancellation unconfirmed with a confirmed dispatch → restart → interrupted still requires acknowledgement before a retry 266ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (claude drafting) > a crash after the dispatch was confirmed but before any result also requires acknowledgement 60ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is fail, and never forwards rejected output 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is fail, and never forwards rejected output 24ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when synthesis is fail, and never forwards rejected output 36ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is refuse, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is refuse, and never forwards rejected output 11ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (claude drafting) > does not ask when every dispatched stage ended (result, confirmed stop, or explicit resolution) 54ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (codex drafting) > cancellation unconfirmed with a confirmed dispatch → restart → interrupted still requires acknowledgement before a retry 46ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when synthesis is malformed, and never forwards rejected output 20ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is empty, and never forwards rejected output 10ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is duplicate-final, and never forwards rejected output 21ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is missing-final, and never forwards rejected output 28ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is wrong-hash, and never forwards rejected output 9ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is tool-event, and never forwards rejected output 36ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (codex drafting) > a crash after the dispatch was confirmed but before any result also requires acknowledgement 74ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is truncated, and never forwards rejected output 10ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when synthesis is wrong-provenance, and never forwards rejected output 16ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > rejects a synthesis that omits a review finding 21ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (codex drafting) > does not ask when every dispatched stage ended (result, confirmed stop, or explicit resolution) 153ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > sends exactly the R4 payloads, and each -sent.json hash matches the bytes actually sent 107ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > does not dispatch a stage whose -sent.json cannot be published 25ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails with "collision" and replaces nothing when a record name already exists 9ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > shows disk-full and permission failures with the path 10ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > keeps the outcome when final-status.json cannot be written, and republishes it on restart 27ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > quarantines a corrupted published record of a finished attempt; the outcome is unchanged and the record shows quarantined 37ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > republishes a missing final-status.json of an already-final attempt with the same bytes and outcome 17ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > a changed final-status.json of a final attempt is quarantined and replaced with the recorded bytes 15ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > a published record corrupted while the attempt was running is quarantined and stays required (damaged, not intact) 8ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > refuses "complete" with matching IDs when the published files cannot support it 3ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines JSON null and settles interrupted without throwing 13ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > ignores a duplicate submission (same idempotency key) 17ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > refuses a start whose approval does not match the frozen packet 2ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > cancels during the review: the owned process confirms exit and the outcome is cancelled 16ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > turns a stage timeout into failed through cancellation semantics 64ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines a list and settles interrupted without throwing 15ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines a null file entry and settles interrupted without throwing 15ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines a file entry without a hash and settles interrupted without throwing 17ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines files not a list and settles interrupted without throwing 282ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > shows cancellation unconfirmed when the process ignores cancellation, blocks retry, quarantines the late result, and resolves explicitly 178ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > a late result after a confirmed cancel cannot change the terminal state 64ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > a new attempt re-runs all three stages from the frozen packet and keeps the earlier attempt 36ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines not JSON and settles interrupted without throwing 12ms
 ✓ tests/core/review-findings.test.ts > finding 4 (Medium): project identity is rechecked before every write > a RULES.md business change during a run blocks every later write; the attempt still gets exactly one outcome 35ms
 ✓ tests/core/review-findings.test.ts > finding 4 (Medium): project identity is rechecked before every write > a folder path change also blocks writes 2ms
 ✓ tests/core/review-findings.test.ts > re-review regression (Medium): a blocked project is still reconciled before its outcome is settled > a record published just before the crash stays required when recovery runs while blocked (claude drafting) 7ms
 ✓ tests/core/review-findings.test.ts > re-review regression (Medium): a blocked project is still reconciled before its outcome is settled > a record published just before the crash stays required when recovery runs while blocked (codex drafting) 7ms
 ✓ tests/core/review-findings.test.ts > re-review regression (Medium): a blocked project is still reconciled before its outcome is settled > a mismatched intended record is never counted as published while blocked, and is quarantined after the unblock 12ms
 ✓ tests/core/review-findings.test.ts > re-review regression (Medium): a blocked project is still reconciled before its outcome is settled > an unadoptable final-status.json left while blocked is quarantined after the unblock, and the recorded bytes are published 16ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > completes three stages, each produced by the right provider, with unresolved issues kept 27ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > reports "no issues reported" when the review has no findings 21ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > gives needs attention for an unmet acceptance criterion, with all nine record files 111ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is fail, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is fail, and never forwards rejected output 11ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when synthesis is fail, and never forwards rejected output 18ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is refuse, and never forwards rejected output 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is refuse, and never forwards rejected output 16ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when synthesis is malformed, and never forwards rejected output 33ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is empty, and never forwards rejected output 12ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is duplicate-final, and never forwards rejected output 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is missing-final, and never forwards rejected output 33ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is wrong-hash, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is tool-event, and never forwards rejected output 122ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is truncated, and never forwards rejected output 12ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when synthesis is wrong-provenance, and never forwards rejected output 18ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > rejects a synthesis that omits a review finding 17ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > sends exactly the R4 payloads, and each -sent.json hash matches the bytes actually sent 13ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > does not dispatch a stage whose -sent.json cannot be published 7ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails with "collision" and replaces nothing when a record name already exists 7ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > shows disk-full and permission failures with the path 5ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > keeps the outcome when final-status.json cannot be written, and republishes it on restart 15ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > ignores a duplicate submission (same idempotency key) 13ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > refuses a start whose approval does not match the frozen packet 1ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > cancels during the review: the owned process confirms exit and the outcome is cancelled 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > turns a stage timeout into failed through cancellation semantics 141ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > shows cancellation unconfirmed when the process ignores cancellation, blocks retry, quarantines the late result, and resolves explicitly 34ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > a late result after a confirmed cancel cannot change the terminal state 31ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > a new attempt re-runs all three stages from the frozen packet and keeps the earlier attempt 22ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > success > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 3183ms
 ✓ tests/persist/restart.test.ts > on real disk (claude drafting) > completes, writes all nine records, touches nothing outside app-records/, and survives a relaunch 3261ms
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

 ✓ tests/persist/smoke.test.ts > runs a task with real files and SQLite, and survives a reopen 695ms
 ✓ tests/persist/restart.test.ts > on real disk (claude drafting) > quitting while a stage runs: after the relaunch the attempt is interrupted, and a retry needs acknowledgement 213ms
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

 ✓ tests/core/seed.test.ts > seeded showcase > produces every required state using the real (simulated) engine 1520ms
 ✓ tests/persist/restart.test.ts > on real disk (codex drafting) > completes, writes all nine records, touches nothing outside app-records/, and survives a relaunch 426ms
 ✓ tests/persist/restart.test.ts > on real disk (codex drafting) > quitting while a stage runs: after the relaunch the attempt is interrupted, and a retry needs acknowledgement 291ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > review fails > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 1399ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > a crash after final-status.json says complete but before the database records it keeps "complete" 171ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > shows dispatch as uncertain when the app stopped after dispatch started but before it was confirmed (C3) 49ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > shows "prepared; not dispatched" when the app stopped after -sent.json but before dispatch started (C3) 18ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > creates the schema with a migration record and survives reopening 99ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > survives repeated crashes during recovery itself 541ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > a transaction that throws changes nothing, in memory or on disk 51ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > offers no way to delete anything 6ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > creates folders, writes a temporary file exclusively and publishes it with a no-replace move 104ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > never replaces an existing file: exclusive create and the publishing move both fail with EEXIST, and the temporary file is kept 50ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > a crash before the transaction leaves none of it; a crash after leaves all of it 103ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > a crash after some rows were already changed inside the SQL transaction rolls all of it back 30ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > writes only changed rows, keeps order, and deletes removed rows 400ms
 ✓ tests/persist/sqlite.test.ts > SQLite store > refuses a store written by a newer schema 32ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > a destination created by another process after the temporary file was made is never replaced 172ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > refuses a symlink at the root, anywhere in the root path, at any folder level, and as a file 102ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > the root folder swapped after it was opened and checked cannot redirect the write (F2 check tied to the write handle) 85ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > a folder below the root swapped after it was opened cannot redirect the write either 92ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > moves only a regular file: a folder, a symlink or a FIFO at the source name is refused and left where it is 165ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > moves into quarantine across two folder handles without replacing anything 50ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > rejects names that are not a single plain component 6ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > reads regular files only: a FIFO is refused at once without hanging, and size is limited 85ms
 ✓ tests/persist/native.test.ts > safe_publish native helper > reports a permission error with its code and the name 7ms
 ✓ tests/persist/folders.test.ts > choosing a test folder > accepts a plain folder with a fictional RULES.md 208ms
 ✓ tests/persist/folders.test.ts > choosing a test folder > refuses a missing RULES.md, an unknown business, a link, a relative path, and this app's repository 115ms
 ✓ tests/persist/folders.test.ts > choosing a test folder > refuses real business folder names wherever they appear (checked without touching them) 13ms
 ✓ tests/persist/folders.test.ts > choosing a test folder > re-reads the path and RULES.md every time: a change is seen at once 7ms
 ✓ tests/persist/folders.test.ts > real folder file access > works only inside app-records/ and lists folders without following symlinks 219ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > complete and needs attention require all nine 56ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > failed, cancelled and interrupted require final-status.json plus exactly the frozen list 3ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > rejects inconsistent lists (a gap, or complete without every stage) 4ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > each real outcome publishes exactly its required files (claude drafting) 466ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > success > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 3569ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > each real outcome publishes exactly its required files (codex drafting) 215ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > a cancelled attempt requires what was published before cancellation 19ms
 ✓ tests/core/records.test.ts > F5 inventory > lists record files, outside reviews, temporary leftovers and quarantine content exactly, with full paths 69ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > saves numbered files with the fixed first line, never as a provider stage 100ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > moves to the next number when the numbered name already exists 2ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > recovers a crash after the no-replace move, before the database records it 61ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > recovers a crash before the link as "not saved" and asks for the paste again 52ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > recovers a crash after the database records published (leftover temp file of a successful save is quarantined) 11ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > shows a published save whose file was changed or removed as damaged, with mismatched content quarantined 6ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > survives a crash during the quarantine move and repeats it safely 23ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > review fails > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 1639ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > a crash after final-status.json says complete but before the database records it keeps "complete" 237ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > shows dispatch as uncertain when the app stopped after dispatch started but before it was confirmed (C3) 34ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > shows "prepared; not dispatched" when the app stopped after -sent.json but before dispatch started (C3) 62ms
 ✓ tests/core/projects.test.ts > F2 projects > refuses a second project for the same folder or the same business, a RULES.md mismatch, and a missing RULES.md 104ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > survives repeated crashes during recovery itself 399ms
 ✓ tests/core/projects.test.ts > F2 projects > blocks a project whose RULES.md business line changed, until it is registered again 20ms
 ✓ tests/core/projects.test.ts > F2 projects > archived projects cannot start tasks 4ms
 ✓ tests/core/projects.test.ts > F2 projects > a task can use sources from its own project folder only 1ms
 ✓ tests/core/projects.test.ts > F2 projects > keeps project records in their own clone: project A writes nothing into project B 120ms
 ✓ tests/core/recovery.test.ts > recovery details > quarantines a mismatched record file and a leftover temporary file, and lists them as not valid records 17ms
 ✓ tests/core/recovery.test.ts > recovery details > handles quarantine name collisions with -2, -3, and never replaces an earlier quarantine copy 1ms
 ✓ tests/core/recovery.test.ts > recovery details > repeats a quarantine move after a crash: the move is atomic, so a repeat finds nothing left to move 1ms
 ✓ tests/core/recovery.test.ts > recovery details > rule (b): adopts a consistent published final-status.json when the database has no outcome 13ms
 ✓ tests/core/recovery.test.ts > recovery details > rule (b) refuses an inconsistent final-status.json, quarantines it and falls to (c) interrupted 98ms
 ✓ tests/core/projects.test.ts > F6 deleting > removes only the app records and leaves the clone byte-for-byte unchanged 43ms
 ✓ tests/core/projects.test.ts > F6 deleting > blocks deletion while an attempt is running 23ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > rejects unknown operations and malformed or oversized input 15ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > derives ownership from stored records: a project ID from the renderer cannot reach another project 2ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > refuses a drafter equal to the reviewer by construction: the reviewer is always the other provider 8ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > names the actual providers in order on the sharing screen, for both role orders (R4) 3ms
 ✓ tests/core/recovery.test.ts > recovery details > damage after completion never changes the outcome: "Complete — record damaged", before and after restart 38ms
 ✓ tests/core/recovery.test.ts > recovery details > marks queued and running attempts interrupted at once, never resuming them 85ms
 ✓ tests/static/boundaries.test.ts > source boundaries > never starts a process, opens a network connection, or uses git 204ms
 ✓ tests/static/boundaries.test.ts > source boundaries > never writes with node:fs; reads only the built renderer (main) and resolves the test folder path (real-folder) 120ms
 ✓ tests/static/boundaries.test.ts > source boundaries > never references the real business folders or repositories, except to refuse them 142ms
 ✓ tests/static/boundaries.test.ts > source boundaries > the native helper offers only the F3 operations (no delete, plain rename, overwrite, truncate, process or network calls) 20ms
 ✓ tests/static/boundaries.test.ts > source boundaries > only the main process and the persistence layer load the native helper; the interface never does 14ms
 ✓ tests/static/boundaries.test.ts > source boundaries > never renders generated content as HTML 3ms
 ✓ tests/static/boundaries.test.ts > source boundaries > has no Apply, Merge or Approve changes controls 76ms
 ✓ tests/static/boundaries.test.ts > preload > exposes exactly the allow-listed operations, plus onChanged 1ms
 ✓ tests/static/boundaries.test.ts > preload > exposes no generic IPC, filesystem, process or event object 2ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > uses contextIsolation, sandbox, no node integration and web security 43ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > has a restrictive CSP with no remote scripts or unsafe evaluation 4ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > serves only files inside the built renderer folder 4ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > allows requests only to the app origin 1ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > accepts IPC only from the app window's main frame on the app origin 1ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > main process denies navigation, new windows, webviews, downloads and permissions, and validates the sender 4ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > has the happy path queued → drafting → reviewing → synthesizing → validating → complete 15ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > includes needs attention as an outcome of validating (C2) 9ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > has failed, cancelling, cancelled and interrupted as explicit alternatives from every running stage 6ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > never leaves a terminal state (late or duplicate events cannot change it) 57ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > cannot skip stages 1ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > treats cancellation unconfirmed as active (blocks retry and deletion) 2ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the simulation banner on every screen 5999ms
 ✓ tests/ui/app.test.tsx > simulated app interface > lists the two fictional projects and refuses a second project for the same business 1134ms
 ✓ tests/ui/persistent.test.tsx > persistent mode interface > chooses a test folder through the main-process picker, registers it, runs a task and writes real records 8228ms
 ✓ tests/ui/app.test.tsx > simulated app interface > composer defaults to Claude drafting and Codex reviewing; switching shows the other order on the sharing preview 1000ms
 ✓ tests/ui/app.test.tsx > simulated app interface > creates a task, shows the sharing screen, runs it and shows three provider-labelled outputs with export-only wording 3332ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows every outcome and record-state display from the showcase tasks 5527ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the sharing screen for the Codex-drafts role order 1797ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the F5 inventory with its warning, and saves a pasted outside review 1194ms
 ✓ tests/ui/app.test.tsx > simulated app interface > cancels a running attempt from the interface 2028ms
 ✓ tests/ui/app.test.tsx > simulated app interface > simulated crash and restart marks running work interrupted, through the interface 2032ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the connection page as simulated and every checklist row unverified 1284ms
 ✓ tests/persist/restart.test.ts > crash at every boundary, then a real relaunch (claude drafting) > gives exactly one outcome, never changes a decided outcome, never re-runs a stage, and leaves no temporary file 43749ms
 ✓ tests/persist/restart.test.ts > crash at every boundary, then a real relaunch (codex drafting) > gives exactly one outcome, never changes a decided outcome, never re-runs a stage, and leaves no temporary file 28317ms
 ✓ tests/persist/restart.test.ts > C1 on real disk > republishes the exact final-status.json bytes kept with the outcome, never rebuilding the file list from disk 333ms
 ✓ tests/persist/restart.test.ts > outside changes to a real folder > a record changed outside the app shows "Complete — record damaged", and the next start quarantines it without changing the outcome 179ms
 ✓ tests/persist/restart.test.ts > outside changes to a real folder > a RULES.md change during a run blocks every later write into the real folder; after restoring it, the next start finishes the record 206ms
 ✓ tests/persist/restart.test.ts > outside changes to a real folder > a symlink planted where the task folder goes: the write is refused with the path, and nothing is written elsewhere 25ms
 ✓ tests/persist/restart.test.ts > outside changes to a real folder > outside reviews are saved as real files, survive a relaunch, and removing the task leaves the folder byte for byte unchanged 153ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > finding 2: the root folder swapped for an impostor with a matching RULES.md mid-run gets nothing written to it 194ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > finding 3: a FIFO and an oversized file in place of records do not hang or stop start-up recovery for other attempts 354ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > finding 1: a failed move never deletes anything: the app's own temporary file is moved to quarantine 124ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > finding 1: a pre-existing .tmp- name the app did not create is never touched 81ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > new finding 2: a move that succeeds but whose flush fails is still counted as published 179ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > new finding 2: recovery adopts a record recorded "not published" whose file is in place with the planned content 123ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > new finding 3: an attempt whose folder cannot be read is not settled on a partial picture; it waits, blocks retry, and settles once readable 236ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > new finding 4: a store from the first persistence v1 build migrates without losing history, and the folder is confirmed once 228ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > F4 on real disk: a crash at each outside-review boundary, then a relaunch, leaves a consistent save and no temporary file 555ms
 ✓ tests/persist/restart.test.ts > Codex review of persistence v1: regression tests > repeated crashes during start-up recovery itself, on real disk 5526ms
 ✓ tests/persist/kill.test.ts > SIGKILL at every boundary (claude drafting, success) > relaunch gives exactly one outcome, intact records, no temporary file, and dispatches nothing 86671ms
 ✓ tests/persist/kill.test.ts > SIGKILL at every boundary (codex drafting, success) > relaunch gives exactly one outcome, intact records, no temporary file, and dispatches nothing 40719ms
 ✓ tests/persist/kill.test.ts > SIGKILL at every boundary (claude drafting, review-fails) > relaunch gives exactly one outcome, intact records, no temporary file, and dispatches nothing 26036ms
 ✓ tests/persist/kill.test.ts > SIGKILL during an outside-review save (F4) > relaunch leaves exactly one consistent save state and no temporary file, at every boundary 1912ms
 ✓ tests/persist/kill.test.ts > SIGKILL during start-up recovery itself > a second relaunch still gives exactly one outcome, an intact record and no temporary file 8887ms

 Test Files  17 passed (17)
      Tests  208 passed (208)
   Start at  02:24:56
   Duration  167.12s (tests 93%, environment 4%, import 2%, transform 1%)

exit: 0
```

### Electron smoke test output, persistent (verbatim)

```
[8336:1107/022805.365251:ERROR:base/process/process_mac.cc:98] task_policy_set TASK_SUPPRESSION_POLICY: (os/kern) invalid argument (4)
SMOKE-PERSIST {"phase":"run","electron":"44.9.3","attemptA":"a-e385f02db9144437","stateA":"complete","attemptB":"a-1952355c2b9411be","stateB":"reviewing","filesA":["1-draft-sent.json","1-draft.md","2-review-sent.json","2-review.md","3-synthesis-sent.json","3-synthesis.md","final-status.json","packet.md","sharing-plan.json"]}
  ok: launch 1: attempt A completed
  ok: launch 1: attempt A has nine record files
  ok: launch 1: quit while attempt B was reviewing
SMOKE-PERSIST {"phase":"verify","electron":"44.9.3","page":{"banner":true,"persistentNote":true,"projectRows":1},"projects":1,"tasks":2,"attempts":[{"id":"a-e385f02db9144437","state":"complete","final":true,"record":"intact","unresolved":[]},{"id":"a-1952355c2b9411be","state":"interrupted","final":true,"record":"intact","unresolved":["review"]}]}
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
SMOKE {"banner":true,"hasRequire":false,"hasProcess":false,"heloKeys":["archiveProject","cancelAttempt","chooseTestFolder","confirmFolderIdentity","createTask","deleteProject","deleteTask","exportArtifacts","getConnection","getEvents","getInventory","getMode","getTask","listProjects","listScenarios","listSimFolders","listTasks","onChanged","previewSharing","registerProject","renameProject","resolveCancellation","saveOutsideReview","simulateCrashAndRestart","simulateDamage","startAttempt"],"projects":2,"windowOpenResult":"denied","evalBlocked":true,"fetchBlocked":true,"notificationPermission":"denied","badInputRejected":true,"locationAfterNavigationAttempt":"app://helo/index.html","windowsBefore":1,"windowsAfter":1,"contextIsolation":true,"sandbox":true,"nodeIntegration":false,"webSecurity":true,"electron":"44.9.3"}
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

**1. Republishing never rebuilds the file list from disk.** This is done in code, and is durable. When an outcome is decided, the finalizing record stores the exact bytes and hash of `final-status.json`, including its file list taken from the database, never from disk. That record lives in SQLite (the `attempts` table), so it survives relaunches and process kills. Every republish writes those stored bytes, whether recovery rule (a) on a not-yet-final attempt or repairing a missing file on a final one. The disk test and every process-kill run check that `final-status.json` is byte-identical to the stored bytes.

**2. Align the plan's validation line with recovery.** This is drafted, waiting for Omar. As Ahmed decided, Claude didn't edit the plan. The exact replacement wording is in `docs/Plan-Amendment-Persistence-v1.md`, section 3, together with the approved F3 change (section 1) and the F2 handle-check wording (section 2). C1 is fully settled once that wording is adopted.

## 6. Independent Codex review of `dbb2fa4`: findings and fixes

### First round (review of `dbb2fa4`)

Ahmed ran the Codex review read-only on 2026-11-07. Claude checked each finding against the code before changing anything; all six were valid.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | Clean-up could delete a replacement file: identity was checked, then a separate by-name `unlinkat` ran, so another program could swap the file in between. Error clean-up deleted without any check, and a pre-existing `.tmp-` name could be removed. | **Approved F3 change:** publication and quarantine use the atomic no-replace move (`renameatx_np` with `RENAME_EXCL`). The helper has no delete call at all. A failed publication moves the app's own temporary file to quarantine; a pre-existing `.tmp-` name is left alone. |
| 2 | High | The F2 check (path and `RULES.md`) used different handles from the write, so the root could be swapped for another plain folder in between. | The folder's identity is recorded at registration. Every write opens the root handle once, checks its identity and the `RULES.md` read through it, then opens the target folder relative to that same handle. A regression test swaps the root for an impostor with a matching `RULES.md` mid-run; nothing is written into it. |
| 3 | High | A FIFO in place of a record could hang `readFile`, and an oversized record made recovery abort, so one damaged file could stop start-up recovery and the window. | `readFile` checks the type first and opens with `O_NONBLOCK`. An oversized or odd entry is treated as not a valid record (the record shows damaged). Recovery runs per attempt, and start-up recovery can't stop the window from opening. A regression test covers a FIFO and a 17 MB file at start-up. |
| 4 | Medium | New folders weren't flushed in their parents, and quarantine didn't flush the folder entry that makes it reachable. | Each folder the helper creates is flushed in its parent at once, and every move flushes both folders. |
| 5 | Medium | "Real relaunch at every boundary" overstated the tests: they threw an exception in one process. SQLite rollback after partial writes was untested, and real-disk coverage lacked the failure scenario, F4 and repeated recovery crashes. | Added SIGKILL process kills at every boundary, in three cases (now 408 kills in five cases; see the second round), including points inside open SQL transactions; a SQLite rollback-after-partial-writes test; and real-disk tests for F4 and for repeated crashes during recovery. The report now says which tests relaunch in-process and which kill a real process. |
| 6 | Medium | C1 wasn't fully settled while the plan still said already-final attempts are "left alone". | As Ahmed decided, the exact wording is in `docs/Plan-Amendment-Persistence-v1.md` for Omar; see section 5. |

Codex also confirmed:
- no real provider calls, app git operations, network functionality or new packages;
- the native build uses local headers only;
- the SQLite transaction design is sound.

### Second round (review of `994b0f6`)

| Item | Codex's status | What was done |
|---|---|---|
| Findings 1, 2 and 4 | RESOLVED | No change needed. |
| Finding 3 | PARTLY RESOLVED | See new findings 2 and 3 below. |
| Finding 5 | PARTLY RESOLVED | See new finding 5 below. |
| Finding 6 | PARTLY RESOLVED (handoff to Omar, not yet adopted) | Unchanged by design: C1 is settled once Omar adopts the wording in `docs/Plan-Amendment-Persistence-v1.md`. |
| New 1, High | The move could relocate a folder swapped in at the source name. | The move now accepts only a regular file, checked through a handle that is held across the move. The moved entry is verified to be that same file; anything swapped in is moved straight back. A test covers a folder, a symlink and a FIFO at the source. A genuinely concurrent swap at the exact moment of the move can't be staged reliably in a test; the move-back path is covered by code review only. |
| New 2, Medium | A move that succeeded but whose flush failed was recorded as "not published". | Moving and flushing are now separate steps. A flush failure after a successful move counts the record as published and notes the problem. Recovery also adopts a record marked "not published" whose file is in place with the planned content, before any outcome is decided. Both are tested. |
| New 3, Medium | Recovery could freeze an outcome after an incomplete check, or leave an attempt stuck. | Each attempt is reconciled and settled on its own. If its files can't be fully checked, it isn't settled at all: it is marked "recovery pending" (shown in the task view, retry blocked) and tried again on every start. A test makes one attempt's folder unreadable: the other attempt is recovered, this one waits, and once the folder is readable again it settles with the correct file list. Listing a folder no longer walks unrelated attempt folders, so one unreadable folder can't affect another attempt. |
| New 4, Medium | Projects saved by the first persistence build had no folder identity and lost write access, with no safe way back. | The store schema is now version 2. Version-1 stores are migrated with the identity marked unconfirmed, and history is kept. A **Confirm folder** button on the Projects page records the identity once, after the same checks (same path, `RULES.md` naming the same business). Tested on a store converted back to version 1. |
| New 5, Medium | Tests and claims. | Added SIGKILL tests for the move-to-flush window, outside-review saves and recovery itself (51 more kills). The weak test is replaced by two real ones: a failed move moves the app's own temporary file to quarantine, and a pre-existing `.tmp-` name that the app didn't create is left untouched. This report no longer says everything is settled while C1 waits for Omar. |

These second-round fixes haven't been reviewed by Codex yet.

---

The code is on branch `build/persistence-v1`, in local commits. Nothing is pushed or merged. A third Codex pass, over the second-round fixes and run by Ahmed, would confirm them.

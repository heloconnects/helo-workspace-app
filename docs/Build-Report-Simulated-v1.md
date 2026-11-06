# Build report: Helo Workspace app, simulated v1

Claude Code session, 2026-11-06, in `~/Desktop/Helo-Shared/helo-workspace-app/`, on branch `build/simulated-v1`. Written for the brief `docs/Build-Brief-Simulated-v1.md` and the plan `docs/Implementation-Plan-DRAFT.md`, revision 7.

**This app makes no real AI calls.** It has fake adapters only. Nothing in it talks to Codex, Claude, OpenAI or Anthropic, starts a provider program, reads or writes a real repository or project folder, or runs git. The only file it reads from disk is its own built interface (`dist/renderer`), and Electron itself of course runs as processes. A banner on every screen says "SIMULATION: no real AI calls".

**Revised after the independent Codex code review** (run by Ahmed, 2026-11-06). Codex found one High, three Medium and one Low finding. All five are fixed, with regression tests; see section 6. This report describes the code after those fixes.

## 1. What was built

A desktop app (Electron 44.9.3, React 19.3.1, TypeScript 7.0.2) that you can open and click through. All data is in memory and fictional.

### Screens

The app starts with two fictional projects, and 12 example tasks that cover every state. Each example was produced by running the real (simulated) engine, not drawn by hand.

| Brief item | Where it is |
|---|---|
| Project list | **Projects**: create (register a simulated folder), rename, archive, remove from the app. Registration refuses a second project for the same folder or business, a RULES.md mismatch, a missing RULES.md, and a missing repository confirmation (F2). |
| Project page with task composer | Click a project. It shows the task list with the latest state, and a composer with title, brief, acceptance criteria, context files from this project's folder only, the role order, and a simulation scenario. A live sharing preview names the providers in order. |
| Task view | Click a task. It shows the brief and context manifest (source IDs, paths, hashes) and the frozen roles. Each attempt shows **Draft**, **Review** and **Synthesis**, each labelled "Produced by Anthropic (Claude) — simulated adapter" or "… OpenAI (Codex) …". Each stage shows its dispatch status, payload hash, requested and reported model, and either its validated output or why it was rejected. |
| Connection page | **Connection**: both providers are shown as "simulated adapter, not connected to any real service". Every compatibility-checklist row is UNVERIFIED, and "Tools and context" is UNVERIFIED — BLOCKER. |
| Results and export wording | Shown on completed tasks: "Review results and export", "Task record — saved by the app", "Proposed changes — text only" and "Export artifacts" (a simulated export preview that writes no file). There are no Apply, Merge or Approve controls. |
| Outcome and record-state displays | Each attempt shows its outcome and its record state (intact, or damaged with every problem listed). Displays include "Workflow complete — unresolved issues remain", "Workflow complete — no issues reported", "Needs attention", "Failed", "Cancelled", "Interrupted" and **"Complete — record damaged"**. |
| Sharing screen, both role orders | Each task has a sharing screen before its first attempt. The example task "Codex drafts, Claude reviews" shows the reverse order. The composer preview switches when you change the drafter. |
| F5 inventory | "Before you commit: inventory of app-records/" lists every file with its full path, its kind (record, outside review, temporary leftover, quarantine), what it holds and its flags. It also shows each attempt's record state and the F5 warning. |
| Outside-review paste box | "Add outside review": choose ChatGPT or Claude app, paste, save. Each save becomes a numbered file that starts with "Pasted by Ahmed; source not verified by the app". It is never counted as a provider stage. |
| Failed, interrupted, cancelled, needs-attention, cancellation-unconfirmed | There is an example task for each. New tasks can produce each one through the scenario picker. **Simulation controls** on the task view can simulate an app crash and restart, and can delete or change a record file. |

Default role order: **Claude drafts, Codex reviews, Claude writes the synthesis.** You can change it per task. The reviewer is always the other provider, so "drafter equals reviewer" cannot be entered.

### Code layout

- `src/core/`: plain TypeScript with no Electron. Contents:
  - the state machine (`state-machine.ts`);
  - packet P, the R4 payloads and the sharing plan (`packet.ts`);
  - output validation, "Valid completion" (`validation.ts`);
  - fake adapters (`fake-adapters.ts`);
  - in-memory stand-ins for SQLite and the clone folder, with crash hooks (`sim-store.ts`);
  - record files, C2, record state and the F5 inventory (`records.ts`);
  - the engine: runs, F3 publication and finishing, cancellation, F3/F4 recovery and outside reviews (`engine.ts`);
  - the typed operation layer with input checks (`service.ts`);
  - fictional fixtures and the example tasks (`fixtures.ts`, `seed.ts`).
- `src/main/`: the Electron main process (`main.ts`) and its security settings as testable functions (`security.ts`).
- `src/preload/preload.ts`: a self-contained preload script that exposes `window.helo`. It offers one named function per allowed operation, plus a change subscription.
- `src/renderer/`: the React interface.
- `src/shared/`: types and the API allow-list.

### Electron security settings (from the plan's "Proposed implementation")

**Window and renderer:**
- `contextIsolation: true`, `sandbox: true` (plus `app.enableSandbox()`), `nodeIntegration: false` (also off in workers and subframes), `webSecurity: true`, `allowRunningInsecureContent: false`, `webviewTag: false`.
- DevTools are off unless the build is unpackaged and `HELO_DEVTOOLS=1` is set.
- The app refuses to start with `--remote-debugging-port` or `--inspect`.
- The page is served from a custom `app://helo/` protocol, and only from files inside `dist/renderer`. Path traversal is rejected.
- A restrictive Content-Security-Policy is set both as a response header and as a meta tag: `default-src 'none'; script-src 'self'; connect-src 'none'`, with no inline scripts and no eval.
- Generated content is shown as inert text only; HTML is never rendered.

**Blocked:**
- navigation, redirects, new windows, webviews and downloads;
- all permission requests and permission checks;
- every request that isn't to `app://helo/`.

**Talking to the main process:**
- The preload exposes named operations only. There is no generic IPC, filesystem or process access, and the IPC event object is never passed to the page.
- The main process checks every request:
  - it must come from the app window's own main frame on `app://helo/`;
  - it must use an allow-listed operation name;
  - its argument must be at most 256 KB;
  - every field is schema-checked with a length limit.
- Project ownership is always taken from stored records.

## 2. How to run it

Requires the local toolchain already present: Node v24.21.0 and npm 11.19.0 through nvm. All packages are installed locally in `node_modules/`, pinned exactly in `package.json` and `package-lock.json`.

```bash
cd ~/Desktop/Helo-Shared/helo-workspace-app
```

```bash
npm start
```

`npm start` builds the main process and preload (`tsc`) and the interface (`vite build`), then opens the window. Other commands:

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run smoke
```

`npm run smoke` builds and launches Electron without showing a window. Inside the live window it checks the banner and both projects, that the page has no `require` or `process`, and that the window reports the required security preferences. It then tries `window.open`, `eval`, `fetch`, a permission request, a malformed operation and a navigation, and requires each to be refused. It prints `SMOKE {…}` and `SMOKE PASSED` (or what failed) and exits.

Things to try in the window:
1. Open **Example Project A** and click each "Example: …" task.
2. Create a task with the composer, review its sharing screen, then press **Approve sharing and start (simulated)**.
3. Pick the scenario "Reviewer is slow (time to press Cancel)" or "Reviewer hangs and ignores cancellation" and press **Cancel attempt**.
4. Press **Simulate app crash and restart** while an attempt is running.

The simulation shortens the plan's proposed timings:

| Timing | Plan | Simulation (`UI_TIMING` in `src/core/engine.ts`) |
|---|---|---|
| Stage timeout | 180 s | 6 s |
| Attempt limit | 600 s | 30 s |
| Cancellation grace window | 5 s | 1.5 s |

## 3. Tests that ran, with their real output

All four checks were run at the end of the session. The full raw output is in `docs/test-output/`.

| Check | Command | Result |
|---|---|---|
| Type check (main/preload/core, interface, tests) | `npm run typecheck` | exit 0, no errors (`docs/test-output/typecheck.txt`) |
| Unit and interface tests | `npx vitest run --reporter=verbose` | **10 files, 150 tests, all passed**, exit 0 (`docs/test-output/vitest.txt`) |
| Production build | `npm run build` | exit 0 (`docs/test-output/build.txt`) |
| Electron launch smoke test | `electron . --smoke-test` | `SMOKE PASSED`, exit 0 (`docs/test-output/electron-smoke.txt`) |

### What the tests cover

**Lifecycle**, in both role orders (`tests/core/lifecycle.test.ts`, 58 tests):
- a successful three-stage run, with each output made by the right provider;
- "no issues reported", and needs attention;
- 13 malformed or failing outputs, each failing cleanly with nothing forwarded and no later stage prepared: process failure at each stage, refusal, malformed JSON, empty content, duplicate final message, missing final message, wrong input hash, a tool event, truncation, wrong provenance;
- a synthesis that omits a review finding;
- the exact R4 payloads, with each `-sent.json` hash checked against the bytes the fake adapter actually received;
- a stage whose `-sent.json` fails to publish is not dispatched;
- a name collision means nothing is replaced;
- disk-full and permission errors are shown with the path;
- a `final-status.json` failure keeps the outcome and is republished on restart;
- a double-click is ignored through the idempotency key;
- an approval that doesn't match the frozen packet is refused;
- cancellation, timeout, cancellation unconfirmed (retry and deletion blocked, late result quarantined, explicit resolution), and a late result that cannot change a terminal state;
- a full manual retry that keeps the earlier attempt.

**Recovery** (`tests/core/recovery.test.ts`, 18 tests):
- **A simulated crash at every boundary of a run, then recovery.**
  - A successful run passes 107 boundaries and a run whose review fails passes 69. That makes 352 crash-and-recover runs across both role orders.
  - Each run must end with exactly one outcome, marked final, with an intact record.
  - An outcome that was already decided must never change.
  - Recovery must not dispatch any stage, must leave no temporary file outside quarantine, and must change nothing when run a second time.
- A crash after `final-status.json` says complete, but before the database records it, keeps "complete".
- Dispatch shows as uncertain or as prepared-and-not-dispatched (C3), and a stage that was dispatched and never confirmed stopped needs an explicit acknowledgement before a retry.
- Repeated crashes at every boundary that recovery itself passes through.
- Mismatched files and temporary leftovers are quarantined, and quarantine name collisions get `-2`/`-3` and are repeatable. (Corrupted records already marked published, and a missing `final-status.json` on a finished attempt, are covered by the review-findings tests below.)
- Rule (b) adopts a consistent `final-status.json` and refuses an inconsistent one.
- Damage never changes an outcome.
- Queued and running attempts are interrupted and never resumed.

**Other core tests:**
- **C2 and F5** (`tests/core/records.test.ts`, 7): the required files for each outcome, checked against what each real outcome actually publishes, and an inventory that lists record, outside-review, temporary and quarantine entries exactly.
- **F4** (`tests/core/outside.test.ts`, 7): numbering, collisions, a crash after the link, before the link and after "published", damage, and a crash during the quarantine move.
- **F2, F6 and the operation layer** (`tests/core/projects.test.ts`, 11):
  - registration refusals, a business-line change blocking the project, archived projects, and own-folder sources only;
  - one project's records cannot reach another's;
  - deleting leaves the clone byte for byte unchanged, and is blocked while an attempt is active;
  - unknown operations and bad or oversized input are rejected, and ownership is taken from stored records;
  - the exact sharing sentence for both orders.
- **State machine** (`tests/core/state-machine.test.ts`, 6) and **example tasks** (`tests/core/seed.test.ts`, 1).
- **Codex review findings** (`tests/core/review-findings.test.ts`, 19), most in both role orders:
  - finding 1: cancellation unconfirmed, then a crash, then interrupted still requires acknowledgement; a crash after a confirmed dispatch requires it too; nothing is asked when every stage ended by result, confirmed stop or explicit resolution; the acknowledgement is recorded;
  - finding 2: a corrupted published record of a finished or running attempt is quarantined and stays required; a missing or changed `final-status.json` of a finished attempt is written again with the same bytes;
  - finding 3: rule (b) refuses "complete" that the published files can't support, and quarantines JSON `null`, a list, a null or hash-less file entry, a non-list `files` and non-JSON, settling interrupted without throwing;
  - finding 4: a RULES.md business change during a run blocks every later write (the clone is unchanged byte for byte), recovery writes nothing into the blocked clone, and the missing `final-status.json` is published once the folder matches again; a folder path change blocks starting and outside reviews.

**Static and Electron checks** (`tests/static/boundaries.test.ts`, 13):
- No `child_process`, spawn or exec, no http/https/net/tls or fetch, no WebSocket, no git and no provider program invocation anywhere in `src/`.
- Files are read only by the main process, and only from the built interface.
- No reference to `helo-walkup`, `helo-hoe` or `~/Desktop/Helo/`.
- No `dangerouslySetInnerHTML` or `innerHTML`, and no Apply, Merge or Approve buttons.
- The preload's list equals the API allow-list.
- The Electron preferences, the CSP, path containment in the `app://` handler, the request allow-list, and the IPC sender check as a function (another window, a subframe and other origins are refused).
- That the main process wires up its navigation, window, download, permission and sender guards. This part is a source-text check; the guards are exercised for real by the smoke test.

**Interface** (`tests/ui/app.test.tsx`, 10), in jsdom. The real React app, driven through the same operation layer the main process uses:
- the banner on every screen;
- the project list and a registration refusal;
- the default role order and switching it;
- creating, approving and running a task through to three labelled outputs, with the export wording and no Apply, Merge or Approve;
- every outcome and record-state display;
- the Codex-drafts sharing screen;
- the F5 inventory and the outside-review paste;
- cancelling, a simulated crash, and the connection page.

### Test output (verbatim, `npx vitest run --reporter=verbose`)

```
 RUN  v5.0.5 /Users/ahmedelhelaly/Desktop/Helo-Shared/helo-workspace-app

 ✓ tests/static/boundaries.test.ts > source boundaries > never starts a process, opens a network connection, or uses git 61ms
 ✓ tests/static/boundaries.test.ts > source boundaries > reads files only in the main process, and only the built renderer 2ms
 ✓ tests/static/boundaries.test.ts > source boundaries > never references the real business folders or repositories 3ms
 ✓ tests/static/boundaries.test.ts > source boundaries > never renders generated content as HTML 1ms
 ✓ tests/static/boundaries.test.ts > source boundaries > has no Apply, Merge or Approve changes controls 2ms
 ✓ tests/static/boundaries.test.ts > preload > exposes exactly the allow-listed operations, plus onChanged 1ms
 ✓ tests/static/boundaries.test.ts > preload > exposes no generic IPC, filesystem, process or event object 0ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > uses contextIsolation, sandbox, no node integration and web security 4ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > has a restrictive CSP with no remote scripts or unsafe evaluation 1ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > serves only files inside the built renderer folder 1ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > allows requests only to the app origin 0ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > accepts IPC only from the app window's main frame on the app origin 0ms
 ✓ tests/static/boundaries.test.ts > Electron security settings > main process denies navigation, new windows, webviews, downloads and permissions, and validates the sender 1ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (claude drafting) > cancellation unconfirmed with a confirmed dispatch → restart → interrupted still requires acknowledgement before a retry 97ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > complete and needs attention require all nine 3ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > failed, cancelled and interrupted require final-status.json plus exactly the frozen list 1ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > rejects inconsistent lists (a gap, or complete without every stage) 1ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > completes three stages, each produced by the right provider, with unresolved issues kept 21ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > reports "no issues reported" when the review has no findings 12ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > gives needs attention for an unmet acceptance criterion, with all nine record files 10ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is fail, and never forwards rejected output 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is fail, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when synthesis is fail, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is refuse, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is refuse, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when synthesis is malformed, and never forwards rejected output 9ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is empty, and never forwards rejected output 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is duplicate-final, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is missing-final, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is wrong-hash, and never forwards rejected output 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when review is tool-event, and never forwards rejected output 5ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > each real outcome publishes exactly its required files (claude drafting) 143ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > each real outcome publishes exactly its required files (codex drafting) 59ms
 ✓ tests/core/records.test.ts > C2: required record files for every outcome > a cancelled attempt requires what was published before cancellation 7ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (claude drafting) > a crash after the dispatch was confirmed but before any result also requires acknowledgement 56ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (claude drafting) > does not ask when every dispatched stage ended (result, confirmed stop, or explicit resolution) 40ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (codex drafting) > cancellation unconfirmed with a confirmed dispatch → restart → interrupted still requires acknowledgement before a retry 29ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when draft is truncated, and never forwards rejected output 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails cleanly when synthesis is wrong-provenance, and never forwards rejected output 9ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > rejects a synthesis that omits a review finding 20ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > sends exactly the R4 payloads, and each -sent.json hash matches the bytes actually sent 20ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > does not dispatch a stage whose -sent.json cannot be published 41ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > fails with "collision" and replaces nothing when a record name already exists 5ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > shows disk-full and permission failures with the path 2ms
 ✓ tests/core/records.test.ts > F5 inventory > lists record files, outside reviews, temporary leftovers and quarantine content exactly, with full paths 22ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (codex drafting) > a crash after the dispatch was confirmed but before any result also requires acknowledgement 55ms
 ✓ tests/core/review-findings.test.ts > finding 1 (High): retry after unconfirmed activity (codex drafting) > does not ask when every dispatched stage ended (result, confirmed stop, or explicit resolution) 31ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > quarantines a corrupted published record of a finished attempt; the outcome is unchanged and the record shows quarantined 10ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > keeps the outcome when final-status.json cannot be written, and republishes it on restart 25ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > ignores a duplicate submission (same idempotency key) 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > refuses a start whose approval does not match the frozen packet 1ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > cancels during the review: the owned process confirms exit and the outcome is cancelled 7ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > turns a stage timeout into failed through cancellation semantics 43ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > shows cancellation unconfirmed when the process ignores cancellation, blocks retry, quarantines the late result, and resolves explicitly 34ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > republishes a missing final-status.json of an already-final attempt with the same bytes and outcome 9ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > a changed final-status.json of a final attempt is quarantined and replaced with the recorded bytes 9ms
 ✓ tests/core/review-findings.test.ts > finding 2 (Medium): recovery reconciles records already marked published > a published record corrupted while the attempt was running is quarantined and stays required (damaged, not intact) 4ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > refuses "complete" with matching IDs when the published files cannot support it 1ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines JSON null and settles interrupted without throwing 7ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines a list and settles interrupted without throwing 9ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines a null file entry and settles interrupted without throwing 8ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines a file entry without a hash and settles interrupted without throwing 9ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines files not a list and settles interrupted without throwing 8ms
 ✓ tests/core/review-findings.test.ts > finding 3 (Medium): rule (b) never adopts an impossible or malformed final-status.json > quarantines not JSON and settles interrupted without throwing 7ms
 ✓ tests/core/review-findings.test.ts > finding 4 (Medium): project identity is rechecked before every write > a RULES.md business change during a run blocks every later write; the attempt still gets exactly one outcome 37ms
 ✓ tests/core/review-findings.test.ts > finding 4 (Medium): project identity is rechecked before every write > a folder path change also blocks writes 1ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > a late result after a confirmed cancel cannot change the terminal state 29ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with claude drafting > a new attempt re-runs all three stages from the frozen packet and keeps the earlier attempt 13ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > completes three stages, each produced by the right provider, with unresolved issues kept 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > reports "no issues reported" when the review has no findings 10ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > gives needs attention for an unmet acceptance criterion, with all nine record files 7ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is fail, and never forwards rejected output 5ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is fail, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when synthesis is fail, and never forwards rejected output 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is refuse, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is refuse, and never forwards rejected output 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when synthesis is malformed, and never forwards rejected output 7ms
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

 ✓ tests/core/seed.test.ts > seeded showcase > produces every required state using the real (simulated) engine 406ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > saves numbered files with the fixed first line, never as a provider stage 60ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > moves to the next number when the numbered name already exists 1ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > recovers a crash after the hard link but before the temporary file is removed 4ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > recovers a crash before the link as "not saved" and asks for the paste again 2ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > recovers a crash after the database records published (leftover temp file of a successful save is quarantined) 5ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > shows a published save whose file was changed or removed as damaged, with mismatched content quarantined 8ms
 ✓ tests/core/outside.test.ts > outside reviews (F4) > survives a crash during the quarantine move and repeats it safely 1ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is empty, and never forwards rejected output 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is duplicate-final, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is missing-final, and never forwards rejected output 5ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is wrong-hash, and never forwards rejected output 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when review is tool-event, and never forwards rejected output 5ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when draft is truncated, and never forwards rejected output 4ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails cleanly when synthesis is wrong-provenance, and never forwards rejected output 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > rejects a synthesis that omits a review finding 8ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > sends exactly the R4 payloads, and each -sent.json hash matches the bytes actually sent 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > does not dispatch a stage whose -sent.json cannot be published 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > fails with "collision" and replaces nothing when a record name already exists 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > shows disk-full and permission failures with the path 3ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > keeps the outcome when final-status.json cannot be written, and republishes it on restart 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > ignores a duplicate submission (same idempotency key) 6ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > refuses a start whose approval does not match the frozen packet 0ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > cancels during the review: the owned process confirms exit and the outcome is cancelled 4ms
 ✓ tests/core/projects.test.ts > F2 projects > refuses a second project for the same folder or the same business, a RULES.md mismatch, and a missing RULES.md 6ms
 ✓ tests/core/projects.test.ts > F2 projects > blocks a project whose RULES.md business line changed, until it is registered again 4ms
 ✓ tests/core/projects.test.ts > F2 projects > archived projects cannot start tasks 2ms
 ✓ tests/core/projects.test.ts > F2 projects > a task can use sources from its own project folder only 1ms
 ✓ tests/core/projects.test.ts > F2 projects > keeps project records in their own clone: project A writes nothing into project B 13ms
 ✓ tests/core/projects.test.ts > F6 deleting > removes only the app records and leaves the clone byte-for-byte unchanged 11ms
 ✓ tests/core/projects.test.ts > F6 deleting > blocks deletion while an attempt is running 2ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > rejects unknown operations and malformed or oversized input 1ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > derives ownership from stored records: a project ID from the renderer cannot reach another project 1ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > refuses a drafter equal to the reviewer by construction: the reviewer is always the other provider 1ms
 ✓ tests/core/projects.test.ts > operation layer (what the renderer can call) > names the actual providers in order on the sharing screen, for both role orders (R4) 1ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > has the happy path queued → drafting → reviewing → synthesizing → validating → complete 2ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > includes needs attention as an outcome of validating (C2) 1ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > has failed, cancelling, cancelled and interrupted as explicit alternatives from every running stage 0ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > never leaves a terminal state (late or duplicate events cannot change it) 2ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > cannot skip stages 0ms
 ✓ tests/core/state-machine.test.ts > attempt state machine > treats cancellation unconfirmed as active (blocks retry and deletion) 1ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > turns a stage timeout into failed through cancellation semantics 43ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > shows cancellation unconfirmed when the process ignores cancellation, blocks retry, quarantines the late result, and resolves explicitly 30ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > a late result after a confirmed cancel cannot change the terminal state 28ms
 ✓ tests/core/lifecycle.test.ts > lifecycle with codex drafting > a new attempt re-runs all three stages from the frozen packet and keeps the earlier attempt 11ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > success > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 1925ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the simulation banner on every screen 709ms
 ✓ tests/ui/app.test.tsx > simulated app interface > lists the two fictional projects and refuses a second project for the same business 455ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > review fails > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 1124ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > a crash after final-status.json says complete but before the database records it keeps "complete" 76ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > shows dispatch as uncertain when the app stopped after dispatch started but before it was confirmed (C3) 30ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > shows "prepared; not dispatched" when the app stopped after -sent.json but before dispatch started (C3) 15ms
 ✓ tests/ui/app.test.tsx > simulated app interface > composer defaults to Claude drafting and Codex reviewing; switching shows the other order on the sharing preview 389ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (claude drafting) > survives repeated crashes during recovery itself 278ms
 ✓ tests/ui/app.test.tsx > simulated app interface > creates a task, shows the sharing screen, runs it and shows three provider-labelled outputs with export-only wording 902ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > success > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 1865ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows every outcome and record-state display from the showcase tasks 1612ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the sharing screen for the Codex-drafts role order 453ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > review fails > gives exactly one outcome at every crash point, never changes a decided outcome, and never re-runs a stage 1135ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > a crash after final-status.json says complete but before the database records it keeps "complete" 81ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > shows dispatch as uncertain when the app stopped after dispatch started but before it was confirmed (C3) 30ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > shows "prepared; not dispatched" when the app stopped after -sent.json but before dispatch started (C3) 15ms
 ✓ tests/core/recovery.test.ts > crash at every boundary (codex drafting) > survives repeated crashes during recovery itself 279ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the F5 inventory with its warning, and saves a pasted outside review 583ms
 ✓ tests/core/recovery.test.ts > recovery details > quarantines a mismatched record file and a leftover temporary file, and lists them as not valid records 16ms
 ✓ tests/core/recovery.test.ts > recovery details > handles quarantine name collisions with -2, -3 and is repeatable 0ms
 ✓ tests/core/recovery.test.ts > recovery details > rule (b): adopts a consistent published final-status.json when the database has no outcome 11ms
 ✓ tests/core/recovery.test.ts > recovery details > rule (b) refuses an inconsistent final-status.json, quarantines it and falls to (c) interrupted 11ms
 ✓ tests/core/recovery.test.ts > recovery details > damage after completion never changes the outcome: "Complete — record damaged", before and after restart 9ms
 ✓ tests/core/recovery.test.ts > recovery details > marks queued and running attempts interrupted at once, never resuming them 79ms
 ✓ tests/ui/app.test.tsx > simulated app interface > cancels a running attempt from the interface 789ms
 ✓ tests/ui/app.test.tsx > simulated app interface > simulated crash and restart marks running work interrupted, through the interface 756ms
 ✓ tests/ui/app.test.tsx > simulated app interface > shows the connection page as simulated and every checklist row unverified 372ms

 Test Files  10 passed (10)
      Tests  150 passed (150)
   Start at  23:07:57
   Duration  9.24s (tests 84%, environment 8%, import 5%, transform 3%)

exit: 0
```

### Electron smoke test output (verbatim)

```
SMOKE {"banner":true,"hasRequire":false,"hasProcess":false,"heloKeys":["archiveProject","cancelAttempt","createTask","deleteProject","deleteTask","exportArtifacts","getConnection","getEvents","getInventory","getTask","listProjects","listScenarios","listSimFolders","listTasks","onChanged","previewSharing","registerProject","renameProject","resolveCancellation","saveOutsideReview","simulateCrashAndRestart","simulateDamage","startAttempt"],"projects":2,"windowOpenResult":"denied","evalBlocked":true,"fetchBlocked":true,"notificationPermission":"denied","badInputRejected":true,"locationAfterNavigationAttempt":"app://helo/index.html","windowsBefore":1,"windowsAfter":1,"contextIsolation":true,"sandbox":true,"nodeIntegration":false,"webSecurity":true,"electron":"44.9.3"}
SMOKE PASSED
exit: 0
```

## 4. What was not done

**Out of scope per the brief, not done:**
- No real calls to Codex, Claude, OpenAI or Anthropic; `codex` and `claude` are never run.
- No reading or writing of any real repository or folder.
- No real F3 file writing into clones, no SQLite store, and carried item C1 is not settled.
- No git operations by the app; no packaging, signing, auto-update, telemetry or distribution.

**Simulated rather than real:**
- `SimFs` stands in for the clone's `app-records/`. It keeps F3's rules (exclusive create, publication by no-replace hard link, no rename or overwrite, and quarantine moves), but none of the operating-system protections are exercised: the `O_DIRECTORY | O_NOFOLLOW` folder handles, `openat`/`linkat`/`unlinkat`, flushing to disk, and symlink or folder-swap races. Real disk-full and permission errors aren't exercised either; they are only simulated.
- `SimDb` stands in for SQLite: each transaction is applied all at once, which can be tested but is not a real database.
- The plan's "process and file monitoring" check (no git process, `.git/` untouched) is replaced by static source checks, since the app touches no real disk.

**Not verified:**
- **Electron security guidance was not re-checked online**: your network rule allowed only the package install. The settings follow the plan's list and what I knew about Electron's checklist before this session.
- **The packaged production configuration was not tested**: packaging is out of scope. Electron fuses (for example turning off `RunAsNode` and the Node inspector) need packaging tools, so they are not set.
- **I did not visually review every screen.** The layout was checked through the interface tests and the smoke test, which loads the real window and finds the banner and both projects, but I did not take or inspect screenshots. Please click through it yourself.

**Differences from the plan, by design:**
- **Timings**: the stage, attempt and grace timings are shortened, as shown in section 2.
- **Attempt ID**: P holds the task ID but not the attempt ID, so one frozen P can be reused for every retry, which the plan requires. The attempt ID is in each stage payload and in the header of `packet.md`.
- **Fictional businesses and folders**: projects use fictional businesses ("Example Business A/B (fictional)") and simulated folder paths, not Walk-Up Method or House of Experts.
- **Crash during cancellation unconfirmed**: an attempt in "cancellation unconfirmed" that goes through a simulated crash becomes "interrupted", following recovery rule (c). Its dispatch still shows "confirmed" (it was acknowledged), but the stage is marked "Not confirmed stopped", and a retry needs your explicit acknowledgement, which is recorded. (The first version of this report claimed this, but the code did not do it; see finding 1 in section 6.) Please check this matches your intent.
- **Already-final attempts on restart**: the plan's validation line says already-final attempts are "left alone", but recovery now republishes a missing `final-status.json` for them from the exact bytes kept when the outcome was decided, and quarantines a changed copy first. The outcome is never changed. This is the carried item C1 question; C1 itself stays open for the persistence approval.
- **Blocked projects**: a project whose folder path or RULES.md business line changed gets no further writes at all, including recovery's quarantine moves and `final-status.json`. Outcomes are still settled in the (simulated) database. The interface has no "register again" flow, because nothing in the simulation can change a folder except the tests.
- **No process descendants**: the fake adapters have no real processes, so there is nothing to test about hung descendants or process groups. Cancellation is confirmed or unconfirmed by the fake adapter's behaviour.
- **Cancelling between stages**: cancelling between stages (no stage in flight) ends as cancelled at the next scheduling point.

**Housekeeping:**
- `npm` audit, fund and update-notifier checks are turned off in `.npmrc`, so npm made no calls beyond the install.
- The Electron app itself (a zip of over 100 MB, from GitHub) was downloaded the first time `electron` was run, not during `npm install`.
- Your two input documents (`docs/Build-Brief-Simulated-v1.md` and `docs/Implementation-Plan-DRAFT.md`) were not committed. Commit them yourself if you want them in the repository.

## 5. How C2 and C3 were settled

### C2: required record files for every outcome, and "needs attention" in the state machine

**State machine** (`src/core/state-machine.ts`):
- The happy path is queued → drafting → reviewing → synthesizing → validating → **complete | needs_attention**.
- From the stages there are also failed, cancelling and interrupted.
- cancelling leads to cancelled, failed (on timeout) or cancellation_unconfirmed.
- cancellation_unconfirmed leads to cancelled or failed (only by explicit resolution), or to interrupted (on restart).
- Terminal states equal the outcome and have no transitions out. Tests check that no terminal state can change.

**Outcome decided at validating:**
- An unmet acceptance criterion in the validated synthesis gives **needs attention**.
- Otherwise the outcome is complete, labelled "unresolved issues remain" or "no issues reported".
- A synthesis that misses a review finding or an acceptance criterion is rejected, which gives failed.

**Required files** (`requiredFiles` in `src/core/records.ts`):

| Outcome | Required record files |
|---|---|
| complete | all nine: `packet.md`, `sharing-plan.json`, the three `-sent.json`, the three stage outputs, `final-status.json` |
| needs attention | all nine (all three stage outputs were published and validated) |
| failed | `final-status.json` plus exactly the record files the finalizing transaction listed as published |
| cancelled | the same rule as failed |
| interrupted | the same rule as failed (the list is taken after recovery's file reconciliation, step 1) |

The file list is frozen when the outcome is decided, and the exact `final-status.json` bytes are kept with it. So later damage can only make the record state damaged. It can never change what is required or what the outcome is.

Two consistency rules back this up:
- "complete" or "needs attention" can never be chosen without all eight earlier files published. A run that somehow reached that point would be recorded as failed instead.
- A file list with a gap is rejected, because files are published strictly in order.

The tests check each real outcome's files on disk against this list, in both role orders.

### C3: "prepared payload and dispatch intent", and dispatch confirmed or uncertain shown separately

**The file:**
- Each `N-stage-sent.json` now states `"meaning": "Prepared payload and dispatch intent"`.
- A note in it says it does not prove delivery.
- The F5 inventory describes it the same way.
- It is published before dispatch, and if it can't be published the stage is not dispatched.

**The dispatch journal** is in the simulated database:
- "started" is recorded just before the adapter is called;
- "confirmed" is recorded when the adapter acknowledges, with its dispatch ID;
- "ended" is recorded, with its evidence, when the stage's activity is known to have stopped: a result or error came back, the owned process confirmed exit, or you explicitly resolved it (resolving "cancellation unconfirmed", or acknowledging at retry). Acknowledgement of a dispatch is never treated as evidence that it stopped.

**What each stage shows**, from that journal (separate from the `-sent.json` file):

| Status | When |
|---|---|
| Dispatch confirmed | the adapter acknowledged |
| Dispatch uncertain | the dispatch started but no acknowledgement was recorded, for example after a crash |
| Payload prepared; not dispatched | `-sent.json` exists but dispatch never started |
| Not prepared | nothing has been prepared for this stage |

Any stage of an earlier, finished attempt that was dispatched and never "ended" (shown as "Not confirmed stopped") means a new attempt needs your explicit confirmation that the earlier activity has stopped, with the possible duplicate billing disclosed. That covers an uncertain dispatch, and also a confirmed dispatch whose result never came back (for example after a crash, or after cancellation unconfirmed). Tests cover all four statuses, including the crash points between `-sent.json`, "started" and "confirmed".

## 6. Independent Codex review: findings and fixes

Ahmed ran the Codex review in read-only mode on this branch on 2026-11-06. Claude checked each finding against the code before changing anything; all five were valid.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | A restart turned "cancellation unconfirmed" into "interrupted" while the dispatch stayed "confirmed", so a retry was allowed without confirming the earlier activity stopped. The check looked only at uncertain dispatches. | The dispatch journal now records when each stage's activity ended and on what evidence. A retry needs your acknowledgement whenever any dispatched stage of an earlier attempt never ended. The acknowledgement is recorded as the resolution. The stage shows "Not confirmed stopped". (`src/core/engine.ts`: `unresolvedStages`, `needsStopAcknowledgement`, `markEnded`; `src/core/schema.ts`: `DispatchRow.endedAt`, `endEvidence`.) |
| 2 | Medium | Recovery reconciled only records still marked "intended", and skipped finished attempts, so corrupted published records were never quarantined and a missing `final-status.json` on a finished attempt was never republished. | Recovery step 1 now also checks every published record and quarantines content that no longer matches; the record stays required, so it shows as quarantined (damaged). Finished attempts get a missing `final-status.json` written again from the exact bytes kept with the outcome. Outcomes never change. |
| 3 | Medium | Rule (b) could adopt "complete" for an attempt with no stage outputs, and malformed `final-status.json` shapes (JSON `null`, null file entries) could throw and stop recovery. | Adoption now validates the whole shape without throwing and also requires the listed files to support the outcome (the C2 consistency check). Anything else is quarantined and the attempt settles as interrupted. |
| 4 | Medium | Project identity (folder path and RULES.md business line) was checked at registration and task start, but not before every write. | Every record publication, quarantine move, outside-review save and recovery write now rechecks the project first. A blocked project gets no writes; the stage fails with "project blocked, nothing written". |
| 5 | Low | The Electron security tests only searched source text, and the smoke test printed the security preferences without requiring them. | The IPC sender check is now a function with unit tests (another window, a subframe and other origins are refused). The smoke test now requires the four security preferences and actually tries `window.open`, `eval`, `fetch`, a permission request, a malformed operation and a navigation inside the live window, failing unless each is refused. It still can't forge an IPC call from a subframe, because the CSP forbids frames. |

Codex also noted that "no processes or real-disk access" needed qualifying: Electron runs as processes, and the main process reads the built interface files. Section 1 now says so. Codex found no real provider call, no application subprocess or network client, no git operation, no access to real project folders, and no concrete bypass of the Electron guards.

The Codex review has not been repeated on the fixed code. A second pass over this diff would confirm the fixes.

---

The code is on branch `build/simulated-v1`, in local commits (the original build and the review fixes). Nothing is pushed or merged.

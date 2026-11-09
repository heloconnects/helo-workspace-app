# Build brief: persistence v1, round 3 fixes

From Omar, 2026-11-08. For the Claude Code session in `~/Desktop/Helo-Shared/helo-workspace-app/`, on branch `build/persistence-v1` (now at `3a5f7ba`). Ahmed approved the approach in chat on 2026-11-08 ("Accept, block and warn").

## Read first

- `~/Desktop/Helo-Shared/Codex-Review-Persistence-Round3.md`: the round 3 independent review. Its final answer is at the end of the file.
- `docs/Implementation-Plan-DRAFT.md`: now **revision 9**. Ahmed copied it over the old revision 7 copy. Read "Threat model and the move limit" under F3.

Omar checked all three remaining issues against the code; all are real.

## Fix 1 (High): block and warn on a detected swap (plan revision 9)

Ahmed accepted that macOS cannot move "only this exact file". Do not try to close the race. Instead:

1. In `safe_publish.c`, keep detection and the one attempt to move the entry back. Report the two cases distinctly, either as two error codes or as one code with a flag: "swapped, moved back" and "swapped, NOT moved back".
2. On either case:
   - nothing is published from that write;
   - the attempt follows the normal F3 rules for a failed record publication;
   - the project is **blocked**: the block is recorded in SQLite, survives restarts, and stops every task and write in that project.
3. The interface shows:
   - the exact folder and names involved;
   - whether the entry was moved back;
   - plain advice: "Check this folder. Something replaced a file while the app was saving it."

   Only an explicit **"I have checked this folder"** action by the user lifts the block, and that action is recorded.
4. Start-up recovery: a non-regular or unexpected entry at a record name is never counted as published. If it is a regular file, it goes to quarantine. Otherwise it stays where it is and is listed in the F5 inventory.
5. Remove every "always moved back" style claim from comments, the interface and `docs/Build-Report-Persistence-v1.md`.
6. Tests:
   - both cases, triggered through a test hook if a real race can't be staged;
   - the block survives a relaunch;
   - writes stay refused while blocked;
   - unblocking is recorded;
   - recovery treats a swapped-in folder at a record name as not published.

## Fix 2 (Medium): one unreadable attempt must not break task views or lists

`service.ts` `attemptView` → `computeRecordState` → `fs.hash` can throw for a finalized or finalizing attempt whose folder is unreadable. That error currently breaks `taskView` and `taskSummary` for the whole project.
- Isolate each attempt. An unreadable attempt shows its outcome (from SQLite) with record state "cannot be checked right now", plus the path and error.
- Every other attempt and task still loads.
- Add a test with a **finalizing or final** attempt whose folder is unreadable; the existing test only covers a running one.

## Fix 3 (Medium): outside-review recovery per save

`engine.ts` wraps all of `recoverOutsideSaves` in one isolation boundary, so the first unreadable save stops the rest and the temporary-file cleanup.
- Isolate each save and each task's `outside/` folder.
- A failing one is noted and retried on the next start; the others are recovered.
- Test: an unreadable earlier save plus a healthy later save. The later one is reconciled and its temporary files are cleaned.

## Rules (unchanged)

- Fake adapters only.
- Nothing installed or downloaded without Ahmed's yes.
- No git by the app.
- Commit on `build/persistence-v1`; do not push.
- Update `docs/Build-Report-Persistence-v1.md`:
  - add a "Round 3" section with the real test output;
  - say plainly what is detected versus prevented.
- Stop there. Codex re-checks next, run by Ahmed.

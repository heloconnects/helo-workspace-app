# Standalone Codex + Claude workspace — implementation plan DRAFT

Revision 9 · 2026-11-08 · Omar. Revision 9 adds the stated limit of the no-replace move, decided by Ahmed in chat ("Accept, block and warn") after the round 3 Codex review of persistence v1 (`~/Desktop/Helo-Shared/Codex-Review-Persistence-Round3.md`, High issue 1). See "Threat model and the move limit" under F3.

Revision 8 · 2026-11-08 · Omar. Revision 8 adopts `docs/Plan-Amendment-Persistence-v1.md` from the persistence v1 build, word for word except for cross-references:
- F3 publication and quarantine use a no-replace move (`renameatx_np` with `RENAME_EXCL`), and the app deletes nothing. The build report says Ahmed approved this in that session ("No-replace move", 2026-11-07); Omar has not seen that chat.
- The F2 check is tied to the folder handle that the write goes through.
- C1 is closed.

Not yet independently reviewed as plan text; the code implementing it was reviewed by Codex twice. Revision 7 answers the four findings of `Codex-Review-Rev6.md` (Omar checked them: all valid, including Omar's second wording error about `sharing-plan.json`). It separates an attempt's fixed outcome from its record state, separates execution failure from publication failure, completes outside-review cleanup and corrects the F5 file descriptions. Revision 6 rewrote F3, F4 and F5 to answer the six findings and the wording notes in `Codex-Review-Rev5.md` (Omar checked all against the text; all valid, including Omar's error that `packet.md` holds provider outputs). Revision 5: Ahmed decided in chat ("Yes, simplify") that the first release runs **no git at all**: it writes task records as plain files into the clone, and Ahmed commits and pushes them himself. See "Revision 5: files only, no app git", which replaces revision 4's R1, R3, R5 and R6 and narrows R2. It answers the six findings of `Codex-Review-Rev4.md` and its two leftover lines (Omar checked all against the text; all valid). Revision 4 answered the seven findings of the independent Codex review of revision 3 (`Codex-Review-Rev3.md`, run by Ahmed; Omar checked each finding against this text and found all seven valid); see "Revision 4: repository storage contract". Revision 2 was revised against the independent-review findings Ahmed supplied in chat (the full review report was not supplied). Revision 3 made the private GitHub repositories `helo-walkup` and `helo-hoe` the app's storage, as Ahmed approved in chat on 2026-11-06 ("Yes, app on GitHub"); see the section "Revision 3: GitHub repositories as storage", which overrides any earlier line it contradicts. This is design coverage, not a claim that capabilities have been verified or that the plan has passed review. No implementation, installation, provider launch, credential access or development folder creation has happened.

## Product

A local desktop dashboard with multiple projects. Ahmed enters a substantive task once; the drafter provider drafts, the other provider reviews, and the drafter produces a synthesis (roles per "Revision 4", item R4) that cites the two outputs and preserves unresolved disagreement. Each completed task shows all three artifacts. A failed provider means the task is incomplete, never “reviewed by both.” Project files and task history stay on the Mac; selected context is transmitted to the respective provider.

The app is a separate workspace, not an extension of this office's team personas. New projects start empty. Walk-Up and House of Experts are not imported automatically. Each import requires selection of project-specific sources; frozen files remain source material rather than worker write targets. Real participant scripts remain excluded under the current hold.

## First release

- Project list: create, rename, archive; name, instructions and explicitly selected context files.
- Project page: task composer, task list, status and recent results.
- Task view: brief and context manifest; draft, review and synthesis, each labelled with the provider that produced it; errors and cancellation.
- Connection page: provider executable availability, signed-in status where officially supported, and a non-secret diagnostic result. Authentication happens through each provider's supported flow; never scrape browser sessions or collect passwords.
- Results view: “Review results and export,” “Export artifacts,” and “Proposed changes — text only.” No Apply, Merge, or Approve changes controls. Two kinds of writes are clearly separated in the interface: (1) **task records** the app itself writes as plain files under `app-records/` in the clone (F3), never committed or pushed by the app, labelled "Task record — saved by the app"; (2) **proposed changes to project files**, shown as text only and never written, committed or pushed by the app. Existing project files are never modified.

Excluded: cloud hosting, collaboration accounts, automatic schedules, continuous chat interception, automatic project imports, publishing, deployments, autonomous spending and simultaneous modification of shared files. Installer signing and public distribution are later work.

## Revision 3: GitHub repositories as storage

**Why.** The shared environment (`TeamManagement/Reports/Four-Tool-Shared-Environment-DRAFT.md`, Option A, approved) keeps all work in two private repositories that ChatGPT and the Claude app can read through their GitHub connectors. The app becomes the easy way to run Codex and Claude Code tasks on those repositories, so nothing built for the repositories is wasted and all four tools see the same files.

**Changes to revision 2** (items 4 to 8 and the validation paragraph below are SUPERSEDED, first by revision 4 and now by revision 5, and kept only as history; item 3's commit SHA is dropped by F1):

1. **One app project = one local clone of one repository** in `~/Desktop/Helo-Shared/`. The app does not let a task use more than one repository, so Walk-Up and House of Experts material never meet in one task. Projects are added by choosing a clone folder; nothing is imported automatically.
2. **The repository's `RULES.md` is part of every task packet P**, as app-controlled project instructions, alongside the app's own boundary policy. The app's boundary policy wins if the two conflict.
3. **Context comes from the repository.** Ahmed selects files from the clone. Each snapshot records the file path inside the repository, the commit SHA and the content hash. Files in `approved/` can be selected as sources but are never write targets. Adapters still never mount the clone (the mandatory adapter boundary is unchanged).
4. **Roles follow `RULES.md`.** Each task names a drafter provider. The reviewer must be the other provider, and the app refuses a task where they match. The synthesis comes from the drafter in a fresh session. The default (Claude drafts, Codex reviews, as in RULES.md, or Codex drafts, Claude reviews, as in revision 2) is a decision for Ahmed.
5. **Artifacts are saved into the repository, not only in the app.** When a task completes, the app writes the task packet to `tasks/<task-id>.md`, the review to `reviews/<provider>-<date>-<task-id>.md`, and the draft and synthesis to `work/<task-id>-DRAFT.md`. It commits them locally on a new branch `app/<task-id>`. SQLite keeps only run state, manifests and hashes.
6. **Git safety.** Git runs through argument arrays with a verified executable. The app never checks out, commits to, merges into or rewrites `main`. It never force-pushes, never writes to `approved/`, and stops if the clone has uncommitted changes in paths it would write. It writes only the files named in step 5.
7. **Pushing is Ahmed's action, per task.** A "Push branch to GitHub" button shows the branch, the files and the remote, and asks for confirmation each time. The app stores no GitHub token. It uses the Mac's existing git sign-in, which the app never reads. Merging stays on GitHub, by Ahmed only. There are still no Apply, Merge or Approve controls.
8. **ChatGPT and the Claude app** are not run by the app; they read the repository through their connectors. An "Add outside review" action lets Ahmed paste a ChatGPT or Claude-app answer. The app saves it to `reviews/` labelled "pasted by Ahmed; source not verified by the app" and never counts it as a provider stage.
9. **Out of scope:** phone or WhatsApp access (a separate decision in the inbox), GitHub API calls, pull-request creation, and reading GitHub from inside the app.

**New validation (in addition to the list below):** clean and dirty clones; a task never writes outside its five named paths; `main` and `approved/` unchanged byte for byte after every test; branch-name collisions; push declined, failed and offline; a clone of the wrong repository or one with no `RULES.md` is rejected; a drafter equal to the reviewer is refused; a pasted outside review is never shown as a provider result.

## Revision 5: files only, no app git

This section overrides revision 4 wherever they differ. Revision 4's **R1 (isolated commits and pushes), R3 (attempt history and SQLite-Git recovery), R5 (push disclosure) and R6 (outside reviews) are SUPERSEDED**. **R4 (role-dependent payloads) and R7 (live verification steps) stay unchanged.** R2 is replaced by F2 below.

**F1. The app never runs git.** No git executable, library, hook, configuration, credential helper, network transport or ref is used by the app, so no git configuration, filter, hook or sign-in can affect it. The app has no commit, push, branch, merge or pull feature. Ahmed reviews the files and commits and pushes them himself, outside the app (GitHub Desktop or Terminal). Pushing from the app is excluded from v1; bringing it back later is a separate plan and review. Earlier mentions of commit SHAs in source snapshots (revision 3, item 3) are dropped: a snapshot records the path inside the clone, the content hash and the time it was read.

**F2. Projects and separation (replaces R2).**
- Registering a project: Ahmed picks the clone's top-level folder and the business (Walk-Up Method or House of Experts). The folder path is resolved with no symlinks. A `RULES.md` must exist at the top level, and its "Business in this repository" line must match the business Ahmed picked.
- **One project per folder and one project per business.** A second registration of the same resolved folder, or a second project for the same business, is refused. This replaces the remote-URL and root-commit identity of R2, which needed git. Limitation, stated in the interface: the app does not check which GitHub repository the folder belongs to. Ahmed confirms that once, at registration, and the app records his confirmation.
- Before every task and every write, the app re-checks the resolved folder path and the `RULES.md` business line. The folder's identity (device and inode) is recorded at registration. Each write opens the project root once as a handle (refusing a symlink anywhere in its path), checks that handle's identity and the `RULES.md` business line read through it, and then opens every folder below it relative to that same handle. The folder that was checked is therefore the folder that is written to; replacing the root folder after the check cannot redirect a write (revision 8). Any change blocks the project until Ahmed registers it again.
- A task can use sources from its own project's folder only.

**F3. Writing task records (replaces R3; rewritten in revision 6).**

*Files.* Each attempt has a new folder `app-records/<task-id>/<attempt-id>/` inside the clone. It holds up to nine **record files**, each published once and never changed:

| File | Written when | Holds |
|---|---|---|
| `packet.md` | before stage 1 | P: brief, acceptance criteria, instructions, frozen roles, the full text of every selected source with its hash. No provider output. |
| `sharing-plan.json` | before stage 1 | The sharing Ahmed approved: which provider receives which kind of content in which order (R4), and the hash of P. It cannot hold later payload hashes. |
| `1-draft-sent.json`, `2-review-sent.json`, `3-synthesis-sent.json` | just before that stage is dispatched | The actual transmission record for that stage: provider, adapter version, exact payload hash, the hashes of the earlier artifacts it includes, and the time. |
| `1-draft.md`, `2-review.md`, `3-synthesis.md` | when that stage's output is validated | The provider's validated output. |
| `final-status.json` | once, when the attempt's final outcome is decided | The outcome (complete, needs attention, failed, cancelled, interrupted) and which record files exist. |

A stage's `-sent.json` file is published before the stage is dispatched. If it cannot be published, the stage is not dispatched.

*Temporary and recovery files* are separate from record files and are the only other things the app writes. Temporary files are named `.tmp-<write-id>` in the same folder and deleted straight after publication. A `quarantine/` sub-folder keeps leftover or mismatched content found during recovery. Both are listed in the inventory Ahmed sees before committing (F5), with quarantine marked "not a valid record".

*Safe publication (finding 1).* All paths are built by the app from fixed patterns. The app opens the project root, then each folder down to the attempt folder, as directory handles without following symlinks (`O_DIRECTORY | O_NOFOLLOW`), and checks each is a real folder. All later operations are relative to those handles (`openat`, and `renameatx_np` with `RENAME_EXCL` for moves; no `unlinkat`, since the app deletes nothing), so replacing a folder path after the check cannot redirect a write. A record file is written to a new temporary file (exclusive create), flushed to disk, then **published with a no-replace move (macOS `renameatx_np` with `RENAME_EXCL`) to the final name, which fails if that name already exists**. The folder is then flushed to disk. A plain rename, which would replace an existing file, is never used. The app never deletes any file: a temporary file whose publication failed is moved to quarantine, and a pre-existing `.tmp-` name that the app did not create is left alone. Only a regular file is moved, checked through a handle held across the move (revision 8).

*Threat model and the move limit (revision 9, decided by Ahmed).*
- **What the app protects against:** its own crashes and bugs, power loss within what the disk's flush guarantees, mistakes, and other programs' ordinary file activity.
- **What it does not protect against:** a deliberately hostile program running under Ahmed's own account. Such a program could already read, change or delete any of his files, so no file-writing rule in this app can stop it.
- **The limit, stated plainly.** macOS moves whatever entry holds a name at the moment of the move. It cannot move "only this exact file". If another entry is swapped in at the source name at that exact moment:
  - the app detects it afterwards (the moved entry is not the file it checked);
  - it reports "swapped";
  - it tries once to move that entry back.

  If moving it back fails, or the app is killed between the two moves, the swapped-in entry may stay at the destination name. Nothing is deleted, and nothing is ever claimed as published.
- **Block and warn.** When a swap is detected:
  - Nothing is published from that write, whether or not the entry was moved back. The attempt's outcome is decided by the normal F3 rules for a failed record publication.
  - The project is **blocked**: no further task or write in it.
  - The interface shows the exact folder and names involved, whether the entry was moved back, and what to check.
  - The block is recorded in SQLite so that it survives restarts. Only Ahmed lifts it, with a deliberate "I have checked this folder" action.
  - Start-up recovery treats a swapped-in entry found at a record name as not a valid record (quarantined if it is a regular file, otherwise left in place and listed), never as published.
- **Claims.** No document, interface text or report may say a swapped-in entry is "always moved back". If the final name already exists, the write fails with "collision", nothing is replaced, and the attempt stops as failed.

*Who decides the outcome (finding 2).* SQLite is authoritative while an attempt runs. Once `final-status.json` is published, that file is authoritative and is never replaced. Every file publication follows one order: (1) a SQLite transaction records the intent and planned hash; (2) the file is published; (3) a SQLite transaction records it as published. Finishing an attempt follows the same order. (1) A SQLite transaction records "finalizing" with the chosen outcome and the planned hash of `final-status.json`. "Complete" is chosen only once all three stage outputs are recorded as published and validated, which is the transactional completion of "Task lifecycle". (2) `final-status.json` is published. (3) A SQLite transaction records the attempt as final.

*Two separate things (revision 7, finding 1).* Each attempt has an **outcome** and a **record state**, and the interface always shows both.
- The **outcome** is what happened when the attempt ran: complete, needs attention, failed, cancelled or interrupted. It is decided once, in the "finalizing" transaction, and never changed afterwards.
- The **record state** is whether the files on disk still match: **intact** (every record file required for that outcome exists and matches its recorded hash) or **damaged** (anything required is missing, mismatched or quarantined, each one listed). It is recomputed on every start and every time an attempt is shown.
- A damaged record is never shown as intact. A completed attempt with a damaged record shows as "Complete — record damaged", with the list. For "complete", the required files are `packet.md`, `sharing-plan.json`, all three `-sent.json` files, all three stage output files and `final-status.json`.

*Execution failure versus publication failure (finding 2).*
- If a stage fails, or a stage record (`packet.md`, `sharing-plan.json`, a `-sent.json` or a stage output) cannot be published, the attempt stops. Its outcome is decided as **failed** in the finalizing transaction.
- Once the finalizing transaction has recorded an outcome, nothing changes it. If `final-status.json` then cannot be published, the outcome stays as recorded (for example "complete"). Only the record state shows "final-status file not on disk", with the path and error. Recovery retries publishing the same outcome on every start.

*Recovery after a crash.* Every step can be repeated, so recovery is safe even if recovery itself crashes.
1. **Reconcile files first, without changing any outcome.** For each record file with a recorded intent, `final-status.json` included: if it exists and matches the planned hash, record it as published. This also covers a crash after the move but before the folder flush or the SQLite acknowledgement. If it exists but does not match, move it to quarantine and record it as not published. If it is missing, record it as not published. Leftover `.tmp-` files also go to quarantine.
2. **Settle the outcome**, in this order. The first rule that applies wins:
   - (a) SQLite already records an outcome (finalizing or final). Keep it. If a matching `final-status.json` is published, mark the attempt final. Otherwise publish `final-status.json` with that same outcome; a mismatched file was quarantined in step 1.
   - (b) No outcome in SQLite, but a published `final-status.json` exists. It names this attempt's ID, and its outcome and file list are consistent with the record files SQLite knows. Adopt its outcome, finalizing then final.
   - (c) Neither: the attempt was still running. Record "finalizing" with outcome **interrupted**, then publish `final-status.json`.
3. **Recompute the record state** of every attempt, including ones already final before the crash.

Each attempt therefore keeps or gets exactly one outcome at every crash point. Damage found later never turns into a different outcome. No stage is re-run automatically, and the other restart rules in "Task lifecycle" are unchanged.

*Safe quarantine moves.* Content goes to `quarantine/<original-name>-<write-id>` by the same no-replace move, which is atomic: there is no separate removal of the old name. If that name exists, the app adds `-2`, `-3` and so on. A move is repeatable: after a crash the source name is simply gone, and the copy is in quarantine. Only regular files are moved; anything else (a symlink, a FIFO) stays where it is and is listed in the F5 inventory (revision 8).

The repository's own `tasks/`, `reviews/` and `work/` folders are never written by the app. Copying a result there is a proposed change (text only), done by a person.

**F4. Outside reviews (replaces R6; rewritten in revision 6, finding 4).** Each save is its own operation, independent of every attempt.
- SQLite table `outside_saves` holds a save ID, task ID, source, text hash, chosen number and state: intended, published or not saved.
- Files live in `app-records/<task-id>/outside/`: published as `<n>-<source>-<YYYY-MM-DD>.md`, where `<source>` is `chatgpt` or `claude-app` as Ahmed chooses; temporary files are `.tmp-<save-id>`; quarantine is `outside/quarantine/`.
- Publication uses the F3 safe-publication procedure. If the numbered name already exists, the no-replace move fails and the app tries the next number (recording the new number in SQLite first), up to 100 tries, then reports an error.
- Each file starts with "Pasted by Ahmed; source not verified by the app". It is never edited (a correction is a new save), never changes any attempt's state or files, never writes `final-status.json`, and never counts as a provider stage.
- Recovery (revision 7, finding 3) runs over every save in `outside_saves`, intended or published, and then over the whole `outside/` folder:
  1. An intended save whose numbered file exists with the matching hash is recorded as published. Otherwise it is recorded as not saved, and the interface asks Ahmed to paste it again.
  2. A published save whose file is missing or mismatched is shown as damaged, listed the same way as attempt records. Mismatched content goes to quarantine.
  3. Any `.tmp-` file left in `outside/`, whatever its save's state (including after a successful publication), is moved to `outside/quarantine/` with the safe quarantine move from F3.

  Every step can be repeated, including after a crash during cleanup.

**F5. Before Ahmed commits (replaces R5; corrected in revision 6, finding 6).** When an attempt reaches its final state, and after an outside review is saved, the app shows the inventory of everything in that task's `app-records/` folder, with full paths:
- record files, outside reviews and any quarantine content, flagged as such;
- what each file holds:
  - `packet.md`: the brief, instructions, frozen roles and the full text of every selected source;
  - `sharing-plan.json`: only the sharing Ahmed approved and the hash of P, with no source text;
  - each `-sent.json` file: that stage's transmission record (provider, adapter version and hashes), with no content;
  - the stage `.md` files: the providers' outputs;
  - `final-status.json`: the outcome and the file list;
  - outside reviews: the pasted text;
  - quarantine files: whatever content was moved there;
- the record state of each attempt (intact or damaged).

It warns plainly: Once Ahmed commits and pushes these files, everyone with access to the repository can read them, and so can connected tools (ChatGPT and the Claude app through their GitHub connectors). Git history keeps them even if they are deleted later. The app pushes nothing.

**F6. Deleting (replaces the deletion promise in "Data model and separation").** Deleting a task or project in the app removes only the app's own records (SQLite rows and its application-data folder). The app never deletes anything inside the clone, including `app-records/`. The interface says so, and says that files already committed stay in git history and on GitHub until Ahmed removes them himself. "Delete" in the app means "remove from the app", not erasing the content.

**Validation for revision 5** (replaces the revision 3 and revision 4 validation additions):
- No git process is started and no file under `.git/` is touched, checked by process and file monitoring in tests.
- Writes stay inside `app-records/`. A symlinked `app-records` folder, task folder or attempt folder, or a symlinked clone root, is refused. Replacing a checked folder with a symlink or another folder between the check and the write does not redirect the write.
- An existing file is never replaced, including when another process creates the destination name after the temporary file was made; outside-review numbering collides correctly under concurrent saves.
- Crashes at every boundary in F3 and F4 (before and after each SQLite transaction and each publication, during finishing, and repeated crashes during recovery) each give exactly one outcome, matching F3's recovery rules. That includes a crash after `final-status.json` says "complete" but before SQLite records it.
- Missing and corrupted record files, both before and after finalization, never change a recorded outcome. They always make the record state damaged, and a damaged complete attempt is never shown as intact.
- A `final-status.json` publication failure keeps the recorded outcome and is retried with the same outcome. A failed stage or stage-record publication gives "failed". Already-final attempts keep their outcome and are otherwise left alone, except that recovery republishes a missing `final-status.json` from the stored finalizing bytes (moving a mismatched copy to quarantine first). Their record state is always recomputed.
- Outside reviews: crash after the move but before the folder flush; crash after SQLite records published; crash during quarantine moves; quarantine name collisions.
- Each `-sent.json` file's payload hash matches the bytes actually sent, in both role orders; a stage whose `-sent.json` could not be published is not dispatched.
- The F5 inventory lists record files, outside reviews, temporary leftovers and quarantine content exactly.
- Disk-full and permission failures are shown with the path.
- A second project for the same folder or business is refused, and a `RULES.md` business mismatch is refused.
- The app never writes to `tasks/`, `reviews/`, `work/` or `approved/`.
- Deleting in the app leaves the clone byte-for-byte unchanged.
- Both role orders run through the full test set (R4).

## Revision 4: repository storage contract (R1, R3, R5 and R6 SUPERSEDED by revision 5; R2 replaced by F2; R4 and R7 still apply)

This section replaces items 4 to 8 and the "New validation" paragraph of revision 3 wherever they differ. Items 1 to 3 and 9 of revision 3 stay, as replaced by F2 (revision 5).

**R1. Isolated commits and pushes (review finding 1, High).**
- The app never uses the clone's working tree or index to commit. For every write it builds the commit itself in a private temporary index (`GIT_INDEX_FILE` set to an app-owned file), from blobs it hashed itself, on top of the recorded base commit. Unrelated staged or unstaged changes in the clone therefore cannot enter the commit, and the clone's checked-out files are never touched.
- Git runs with a fixed, app-controlled configuration: system and global configuration ignored (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`), hooks disabled (`core.hooksPath` set to an empty app-owned folder), no clean/smudge or other filters, no `.gitattributes` processing for app-written paths, `core.fsmonitor` off, and no aliases. Only plumbing commands are used (`hash-object`, `update-index`, `write-tree`, `commit-tree`, `update-ref` with the expected old value).
- Before a ref is updated, the app checks that the new commit's tree differs from its parent only in the exact paths it planned (R3), and that each blob's hash matches the artifact hash in SQLite. Any extra, missing or changed path aborts.
- One app operation at a time per repository, with an app lock file; the ref update uses compare-and-swap, so a concurrent change by another tool makes it fail rather than overwrite.
- **Push binds to what Ahmed confirmed.** The confirmation screen shows the remote name and URL, the branch, the full commit SHA and the list of paths. On confirm the app runs exactly `git push <remote-url-as-recorded> <commit-sha>:refs/heads/app/<task-id>/<attempt-id>`, with no force, and only if the remote URL still matches the repository's registered destination (R2) and the local ref still points at the confirmed SHA. Anything changed since the screen was shown means a new confirmation.
- Tests: unrelated staged and unstaged files; an executable hook and a filter in the clone; a global git configuration with aliases and hooks; a concurrent commit on the same branch; the branch moving or the remote URL changing between confirmation and push; push declined, failed or offline.

**R2. Repository identity and separation (finding 2, High).**
- Registering a project needs: the clone's top-level folder resolved with no symlinks; its own `.git` directory (no linked worktrees, no `.git` file pointing elsewhere, no `GIT_DIR` override, no shared alternates); an `origin` URL that exactly matches one entry of an app allowlist set by Ahmed (proposed: the two `helo-walkup` and `helo-hoe` GitHub URLs); and a `RULES.md` at the top level.
- Identity is the pair (allowlisted remote URL, the repository's root commit SHA). A repository can be registered once; a second registration of the same identity, under any folder, is refused.
- Before every task and every write, the app re-checks the folder, the remote URL, the root commit and the absence of linked worktrees. Any change blocks the project until Ahmed re-registers it.
- Output paths are built only by the app from fixed patterns (R3), checked to contain no `..`, absolute parts or special characters, and validated as tree paths inside the commit (R1), so no filesystem symlink in the clone can redirect a write.
- Tests: the same repository registered twice under different folders; a linked worktree; a symlinked clone folder or `app-records` parent; an `origin` URL changed after registration; a repository outside the allowlist.

**R3. Attempt history and recovery between SQLite and Git (finding 3, High).**
- Every attempt writes to its own folder, which is never reused or rewritten: `app-records/<task-id>/<attempt-id>/`. Files: `packet.md` (P), `manifest.json` (transmission manifests and hashes), `1-draft.md`, `2-review.md`, `3-synthesis.md` and `status.json` (final state and reason). Those are the six fixed paths. They replace the three paths of revision 3 (the "five named paths" in revision 3 was an error).
- Each valid stage output is committed as soon as it is validated: one commit per stage on the attempt's own branch `app/<task-id>/<attempt-id>`. Failed, cancelled or interrupted attempts keep their committed stages, plus a `status.json` that says so. Nothing is deleted or amended.
- Write order per stage: (a) SQLite records "commit pending" with the planned SHA inputs; (b) the app builds and checks the commit (R1); (c) compare-and-swap ref update; (d) SQLite records "committed" with the commit SHA. On restart, the app compares SQLite with the branch: a commit that exists but is not recorded is checked against the planned hashes and then recorded; a recorded intent with no commit is marked "not committed" and the stage is treated as not completed. No provider stage is re-run automatically.
- Attempt branches and folders stay separate from the repository's own `tasks/`, `reviews/` and `work/` folders, which remain for people and the drafting tools. Copying a result into `work/` is a proposed change (text only), done by a person.

**R4. Role-dependent payloads (finding 4, High).**
- Each task chooses a drafter (Codex or Claude). The reviewer is always the other provider; the synthesis is always the drafter, in a fresh session. Roles are frozen in P before stage 1 and cannot change within an attempt.
- The stage table in "Task lifecycle" is written for both orders: Draft goes to the drafter's provider; Review goes to the reviewer's provider with P plus the full validated draft; Synthesis goes to the drafter's provider with P plus the validated draft and review. The pre-run sharing screen names the actual providers in order. For example, "OpenAI (Codex) receives P; Anthropic (Claude) receives P and Codex's draft; OpenAI receives P, the draft and Claude's review" or the reverse.
- Tests run both orders through every lifecycle, failure and transmission test.
- The default order is still Ahmed's decision. It only preselects the choice and changes no safety rule.

**R5. What pushing publishes (finding 5, Medium).**
- Before any push, a second screen lists everything that will become readable on GitHub: every file in the attempt folder, including `packet.md` with the full text of every selected source, both providers' outputs, and the branch's whole history back to the base commit.
- It states plainly: anything pushed can be read by everyone with access to the repository and by connected tools (ChatGPT and the Claude app through their GitHub connectors), and may be copied by them. Deleting it in the app or locally does not remove those copies, and removing it from GitHub history is a separate manual job.
- Sources taken from files not yet committed to the repository are marked on this screen.

**R6. Pasted outside reviews (finding 6, Medium).**
- Saved to `app-records/<task-id>/outside/<n>-<source>-<YYYY-MM-DD>.md`, where `<source>` is `chatgpt` or `claude-app` as Ahmed chooses, and the file starts with "Pasted by Ahmed; source not verified by the app".
- Committed by the same R1 procedure, on its own branch `app/<task-id>/outside-<n>`, never on an attempt branch. Never edited after saving; a correction is a new numbered file.
- Adding one never changes an attempt's state, completion or `status.json`, and never counts as a provider stage. Pushing it follows R1 and R5.

**R7. Live verification in steps (finding 7, Medium).** Milestone 3 is split into separate approvals. 3a: documentation evidence and fake-adapter tests (no provider calls). 3b: narrowly scoped live compatibility probes, each approved by Ahmed beforehand, with no project content: fixed fictional text, the exact command, the expected number of calls, and which checklist rows each probe settles. 3c: end-to-end live approval only once every checklist row is settled. Approval of one step never implies the next.

## Proposed implementation

Use Electron with a React/TypeScript interface, a local SQLite task store and a main-process provider runner. Confirm the installed toolchain before choosing exact supported dependency versions. No dependency installation before the plan gate is cleared.

Electron gives a standalone window and local process access. Require nodeIntegration=false, contextIsolation=true, sandbox=true and webSecurity=true. A minimal preload exposes named typed operations, never generic IPC, filesystem or command execution. Main validates sender/frame/origin, schemas, sizes, stored project ownership and operation state. Serve fixed packaged local content with restrictive CSP, no remote scripts or unsafe evaluation. Render generated content as inert text or sanitized Markdown with raw HTML disabled. Deny unexpected navigation, new windows, webviews, downloads, permission requests and external protocols. Documentation links require user action and an HTTPS allowlist. Renderer cannot contact providers directly. No production remote debugging, telemetry or automatic updates. Pin dependencies/lockfile; verify current official Electron security guidance before coding and test the packaged production settings. These UI protections do not establish provider-process isolation.

Implement provider adapters as separate modules. Proposed routes are supported Codex and Claude Code command-line interfaces, only after verifying official documentation, local availability, account eligibility, usage terms and supported authentication. Codex scripted mode is documented at https://learn.chatgpt.com/docs/non-interactive-mode . Claude's current interface has not been verified. Do not substitute a persona or another OpenAI model for Claude. If either route is unsupported, present the verified API alternative and its costs for approval rather than silently switching.

Run verified executable paths with argument arrays, never shell interpolation, and a minimal environment. Keep task content and secrets out of process arguments/logs where supported; otherwise resolve this compatibility issue before approval. Use per-task working directories, manifests, timeouts, bounded output and three provider stages per attempt. Source content and generated artifacts are untrusted data. Neither can grant tools, select files, initiate another task, navigate the UI or approve an action.

### Mandatory adapter boundary — release blocker

Both adapters MUST enforce tool disabling and approved-context-only access before live use. No shell, file tools, browsing/search, MCP, connectors, plugins, delegation or interactive permission escape. No implicit workspace scan, home/project instruction loading, inherited integrations, past conversations, cached session resume or unrelated project context. Every stage uses a fresh session. Prompts asking workers not to use tools are insufficient.

Use supported adapter controls plus a verified execution boundary that prevents arbitrary source-file reads/writes, unrelated project access and undeclared network destinations. Do not mount project originals. Individually document minimal runtime/authentication resources; they must remain unavailable as model tools and excluded from model context. General home-directory access is not an acceptable authentication workaround. A manifest or working directory alone does not enforce isolation.

Fail closed if either exact supported CLI/version/configuration cannot enforce this contract. No silent weaker mode or provider substitution. CLI capability is currently **UNVERIFIED for both providers**. If a CLI fails, propose for separate approval a supported direct API route: tools omitted/disabled, explicit fresh messages only, no implicit hosted files/search/history, rejection of tool-call outputs, and an app-owned network client that gives the model no local filesystem access. Verify both providers' semantics, identity, authentication and billing. Disclose if the OpenAI API route would differ from Ahmed's intended Codex interface; obtain approval rather than silently substituting it.

### Documented compatibility checklist

Maintain one evidence record per adapter/version/platform/model: official documentation URL and retrieval date, exact configuration, documented versus tested status, test method/result and reviewer. Every blank is UNVERIFIED. Version, endpoint, authentication, tool-policy or configuration changes invalidate affected checks and block live execution until reverified.

| Check | Required evidence and pass condition | Codex | Claude |
|---|---|---|---|
| Supported versions | Exact CLI/API version, model ID, macOS/architecture support and pin/upgrade policy | UNVERIFIED; none selected | UNVERIFIED; none selected |
| Authentication | Official supported flow, expiry/revocation, minimal runtime resources; no credential contents in payloads/logs | UNVERIFIED | UNVERIFIED |
| Account eligibility | Actual account/plan/territory eligible for selected interface, model and app use | UNVERIFIED | UNVERIFIED |
| Billing | Subscription versus API charges, rate/usage limits, available usage reporting and approved budget | UNVERIFIED | UNVERIFIED |
| Invocation | Exact argument array/request schema, fresh/non-interactive session, fixed endpoint/model, limits and error/retry semantics | UNVERIFIED | UNVERIFIED |
| Tools and context | Complete tool disabling, inherited config exclusion, enforced filesystem/network boundary and denied adversarial access | UNVERIFIED — BLOCKER | UNVERIFIED — BLOCKER |
| Output validation | Final-message/event schema, reported provenance, errors/refusals/truncation/tool-call handling | UNVERIFIED | UNVERIFIED |
| Cancellation | Owned process/request cancellation, descendants, termination evidence and remote generation/billing limits | UNVERIFIED | UNVERIFIED |
| Data handling | Exact destinations, retention/settings and local cache behavior; permitted sharing scope | UNVERIFIED | UNVERIFIED |

The previously consulted Codex scripted-run reference above does not establish this complete contract. No Claude invocation or supported local version is established. No new capability checks occurred for this revision. Later verification must consult current official documentation; local checks/authentication/live tests require their applicable approval and must not inspect credential contents.

## Task lifecycle

Before execution show the three-stage transmission manifest, naming the providers in the attempt's frozen order (R4). User approval explicitly covers the drafter's draft going to the reviewer's provider and the review returning to the drafter's provider, as well as selected task sources. This approval does not cover changed context, future tasks or live calls without Ahmed's separate live-call approval.

Define immutable packet P: versioned app-controlled instructions/output schema; user brief and acceptance criteria; explicitly selected project instructions; selected text snapshots with logical source IDs, safe display names, hashes and selected contents; opaque task/attempt IDs. Exclude absolute paths, credentials, unrelated project names, prior task history and implicit settings. Sources/project instructions remain below app boundary policy. V1 supports explicitly selected regular text only, no binary attachments or automatic extraction.

| Stage | Destination | Exact task content transmitted | Required output |
|---|---|---|---|
| Draft | Drafter's provider (OpenAI via the Codex adapter, or Anthropic via the Claude adapter), as frozen in P | P plus drafting instructions | Draft, source references, assumptions, limitations and unmet criteria |
| Review | The other provider | P plus the full validated draft artifact plus review instructions | Verdict; numbered findings with severity/evidence; corrections, coverage and unresolved issues |
| Synthesis | Drafter's provider, fresh session | P plus the full validated draft and review artifacts plus synthesis instructions | Deliverable; disposition of every review finding; remaining issues; acceptance-criteria assessment |

An artifact contains schema-validated response fields, never hidden reasoning, stderr, debug events or credentials. Partial/rejected output is not forwarded. Inventory transport-required authentication/provider metadata separately from model context. Hash each serialized payload and store the manifest. No other cross-provider sharing is permitted. Source snapshots freeze before stage 1; later edits cannot change an active attempt. Oversized input stops before transmission: request reduced selection, never silently truncate/summarize/retrieve. Changed selection creates a new packet and sharing approval.

### Valid completion

Each stage must have successful transport/process termination, a recognized final response, sufficient supported provider/model provenance, correct bounded schema, required nonempty content, matching task/input identifiers and hashes, and no forbidden tool events, truncation, refusal or protocol errors. Exit zero or nonempty text alone is insufficient. Reject duplicate/missing final messages, malformed and out-of-order events. Store requested and reported provider/model separately; absent provenance blocks compatibility approval, never invent it.

Execution completes only after all three valid outputs and their provenance commit transactionally and synthesis accounts for every review finding. Distinguish “Workflow complete — unresolved issues remain” and “Workflow complete — no issues reported.” Unmet acceptance criteria yield “Needs attention.” Completion does not mean the deliverable is factually verified or accepted by Ahmed. User acceptance is separate and does not enable source changes. Record usage only when supplied with units/origin; absent usage/cost is “Unavailable,” not zero.

State machine: queued → drafting → reviewing → synthesizing → validating → complete; failed, cancelling, cancelled and interrupted are explicit alternatives. Persist intent before dispatch, dispatch identifiers/timestamps and results before scheduling the next stage. One stage per attempt at a time; a local submission idempotency key prevents double-click dispatch. Late/duplicate events cannot change terminal states.

Cancellation stops scheduling, enters cancelling and signals only the owned process group/request. Proposed graceful window: five seconds, then terminate owned local descendants and confirm exit. Never kill by process name or stale reused PID. Unconfirmed termination displays “Cancellation unconfirmed,” blocks retry and requires cleanup resolution. Late results are quarantined. Local cancellation does not promise remote generation/billing stops; disclose uncertainty. Proposed stage timeout 180 seconds, total attempt limit 600 seconds; timeout follows cancellation semantics. Input/output byte/token caps must be selected from verified interfaces before adapter approval.

Crash/restart: mark active and queued attempts interrupted; never auto-dispatch, resume or replay them. Preserve published valid record files; quarantine partial/corrupt files and check hashes. Use temporary writes, no-replace publication and SQLite transactions, following the F3 recovery order. Reconcile owned child handles or documented remote status only through a separately authorized action; no automatic provider polling. Unknown remote completion stays unknown, not failed-with-safe-retry.

V1 retry is manual “Start new attempt” only after old activity is confirmed stopped or explicitly resolved, with possible duplicate billing disclosed. Re-run all three stages from the frozen packet under a new attempt ID; no reuse of earlier downstream artifacts or overwritten history. Changed context requires a new packet/approval. Failure blocks successors. Disable hidden SDK/CLI retries or document and bound them; uncontrollable repeat dispatch blocks route approval.

## Data model and separation

Tables: projects, context_sources, tasks, attempts, task_context_snapshots, provider_runs, artifacts, transmission_manifests and schema_migrations. Every object belongs to one project; main derives ownership from stored records on every read/write/export/delete, never trusts renderer project IDs alone. Archived projects cannot start tasks.

Import only user-selected regular text snapshots. Canonicalize and check opened file identity/root containment and stable contents during import to prevent path/symlink races. Reject traversal, symlinks, devices, sockets, executables, oversized files and unsupported encoding. No recursive directory imports. Block credential/hidden configuration paths, preview selection and warn about apparent embedded secrets without claiming scanning is complete. Workers never mount originals. Manifest checks are not isolation: the mandatory adapter boundary must also pass.

Use opaque internal filenames and project-scoped directories. Export through a main-process save dialog with safe names, file types, path checks and explicit overwrite confirmation. Reject imported originals, protected/frozen sources, app configuration and other projects' storage as destinations. No generic renderer read/write operation. Generated content is inert and never auto-executed. Deletion is blocked while runs are active or cancellation unconfirmed; it removes only the app's own records and application-data files, with transactional metadata and recoverable cleanup, and never touches the clone (F6). Backups must not broaden access.

App data lives in its own OS application-data directory, outside Helo. Source code will be developed in a separately approved project location. No alteration of office guards, permission rules or existing instruction files. No storage of provider credentials in task records. Store only selected context and necessary outputs; provide project export and deletion with a clear statement that provider-side copies follow provider terms. No promise of deletion from third-party systems or OS backups.

## Milestones and gates

1. Ahmed runs independent Codex review of this plan outside the office; Omar checks findings and revises it. No implementation before that review.
2. Once revision 7 passes independent review, Ahmed separately approves the development location and simulated-interface scope; only then create the folder and build the clearly simulated interface. Plan revision alone authorizes neither step. Proposed location: a third private repository, `helo-workspace-app`, created by Ahmed and cloned into `~/Desktop/Helo-Shared/`. It holds app code only, never business files. Tests use throwaway fictional repositories, never the clones of `helo-walkup` or `helo-hoe`.
3. Persistence/adapters require their approved scope, in the three separately approved steps of R7: 3a documentation evidence and fake-adapter tests; 3b narrowly approved live compatibility probes with fixed fictional text; 3c end-to-end live approval once every checklist row is settled and the mandatory boundary is enforced. Alternative interfaces/security changes return to Ahmed. Simulated-build approval never authorizes live provider calls.
4. After live-call approval, run one entirely fictional task end to end. Inspect raw outputs to verify actual Codex and Claude participation. Measure latency and exposed usage without extrapolating invented costs.
5. Ahmed runs the second independent code review. Address findings, repeat affected tests and produce a local launchable app. Distribution, signing, deployment and office-data migration remain separate approvals.

## Required validation

- Lifecycle: successful three-stage task; unresolved/unmet criteria; every provider failure; malformed/empty/refused/truncated output; false exit success; missing/duplicate/out-of-order final events; wrong identity/hash/task; synthesis omitting reviewer findings.
- Recovery: crash before/after dispatch, before/after each SQLite transaction and each file publication (F3 steps 1-3), during finishing, and during recovery itself; partial writes/corruption; restart at each stage with no replay; duplicate submission and late results. Cancellation/timeout at every stage, hung descendants, completion races, unconfirmed remote status and blocked retry. Full manual retry preserves prior attempts and does not duplicate successors.
- Separation/export: Project A cannot read/select/export/delete B records; traversal, symlink/race and unsupported imports rejected; source hashes unchanged; protected targets, overwrite behavior, active-run deletion and recovery cleanup checked.
- Mandatory adapter contract: exact pinned versions; hostile/empty inherited configuration; attempted tool/MCP/plugin use, outside-context reads, writes, undeclared network and cross-project access denied. Any forbidden action blocks live release. Fake tests do not prove actual provider controls.
- Transmission: inspect fake serialized requests against all three payload definitions; no extra files/history/paths/secrets/debug output; exact hashes; rejected outputs never forwarded; no silent truncation.
- Electron: renderer cannot access Node/storage/providers, bypass typed IPC, inject scripts/HTML, navigate, spawn windows/protocols or acquire unexpected permissions. Test production packaged configuration.
- UI: two fictional projects; conspicuous simulation label; three contributions; needs-attention, failed/interrupted/cancellation-unconfirmed states; explicit two-way cross-provider sharing manifest; export-only wording; relaunch/history/export/deletion.
- Live smoke test: one fictional task only after approval. No claim of end-to-end provider integration from simulated tests.

## Carried items from the revision 7 review (open; settle before the persistence approval)

The independent review of revision 7 (`Codex-Review-Rev7.md`) found the plan ready for the simulated-interface gate. These three Medium items do not block that gate, but they are NOT yet fixed:

- **C1: SETTLED (revision 8).** Persistence v1 keeps the exact `final-status.json` bytes in the durable finalizing record and republishes only those bytes (`docs/Build-Report-Persistence-v1.md` section 5); the validation wording is aligned. Original item: retain the exact serialized bytes of `final-status.json` from the finalizing record, or define deterministic reconstruction, so that republishing never rebuilds the file list from current disk. Also align the validation line "Already-final attempts are left alone" with recovery's republishing of a missing final-status file.
- **C2 and C3: settled in code** in simulated v1 (`docs/Build-Report-Simulated-v1.md`: required files per outcome; dispatch shown as confirmed, uncertain or prepared-not-dispatched), reviewed by Codex. The plan text for them has NOT yet been written into F3; Omar adds it in the next revision. Original items follow.
- **C2** (settle during the simulated build's state tests; before persistence approval): define the required record files for every outcome (needs attention, failed, cancelled, interrupted), and add "needs attention" to the state machine.
- **C3** (settle during simulated dispatch and restart tests; before live-adapter approval): rename the `-sent.json` files' meaning to "prepared payload and dispatch intent", and show whether dispatch was confirmed or is uncertain separately, from the dispatch journal.

## Open decisions

**UNRESOLVED BLOCKERS:** both adapters' tool disabling and approved-context-only enforcement; all compatibility evidence (versions, authentication, eligibility, billing, invocation, provenance, cancellation and data handling). No live route is approved. API alternatives need evidence and separate approval, including whether the OpenAI route meets the Codex requirement.

**PENDING REVIEW:** revision 3 failed independent review (7 findings, 4 High); revision 4 addressed them and failed review (3 resolved, 4 partly, 6 new findings); revision 5 removed app-side git (Ahmed's decision) and failed review on its file-writing contract (6 findings, 3 High); revision 6 rewrote that contract and failed review on recovery (4 findings, 2 High); revision 7 fixed recovery and **passed independent review for the simulated-interface gate** (`Codex-Review-Rev7.md`, 2026-11-06; 3 Medium carried items C1-C3 above). Passing review authorizes nothing: Ahmed's separate approval is needed for the development location and the simulated build. The revision 4 remote-URL allowlist decision is withdrawn (F2 no longer uses remotes). **PENDING APPROVAL AFTER REVIEW:** development location (the proposed `helo-workspace-app` repository; replaces `~/Desktop/DualWorkspace`, which was never created) and simulated interface build. **NEW DECISION (revision 3):** default drafter and reviewer order. Electron stack/dependency versions remain proposed/unverified. **PENDING BEFORE LIVE:** provider/model choice, retention acceptance, size limits, exact sharing scope and approved run budget. No “free/unlimited” usage assumption.

## Finding-to-change checklist

| Supplied finding | Addressed in this revision | Remaining gate |
|---|---|---|
| Mandatory tools/context restrictions | Fail-closed contract for both adapters, verified isolation, alternative approval route | Real capability UNVERIFIED |
| Compatibility checklist | Per-provider evidence table, exact versions/configuration and recheck triggers | Evidence required before live |
| Exact stage sharing | P definition and three-stage outbound matrix for both role orders (R4): draft to the reviewer's provider, review back to the drafter's provider | Payload tests and sharing approval |
| Completion | Schema/protocol/provenance checks; SQLite transactions and F3 finishing order; acceptance separate | Implement/test later |
| Cancellation/crash | Owned teardown, uncertainty, no replay, atomic recovery | Verify process/remote behavior |
| Retries | Full manual new attempt, no reused artifacts, bounded hidden retries | Fake tests and compatibility |
| Project/file boundaries | Snapshot imports, ownership/race checks, export restrictions and safe deletion | Boundary tests |
| Electron | Renderer/preload/IPC/CSP/navigation/process controls | Official guidance and packaged checks |
| Expanded validation | Failure/recovery/contract/transmission/boundary/security/UI cases | Not run |
| Export-only UI | Exact labels; no apply/merge controls | Simulated UI review after approval |

## Independent review prompt for Ahmed

Review revision 7 before implementation. First, for each of the four findings in `Codex-Review-Rev6.md` and the three items it marked PARTLY RESOLVED, say whether revision 7 makes it RESOLVED, PARTLY RESOLVED or NOT RESOLVED. Then look for new issues that revision 7 introduces. Rank by severity and say plainly whether any remaining issue must block the next gate (a clearly simulated interface built with fake adapters only), or could be handled during that build and its tests. Read only this document; do not edit files, install dependencies, launch providers, create folders, change permissions or access credentials. Check supplied findings are covered in design; distinguish design coverage from verified capability. Assess mandatory tool-free approved-context-only enforcement, compatibility evidence, exact cross-provider payloads, completion/acceptance, cancellation/crash/retry races, project/file boundaries, Electron controls, validation, export-only wording and approval sequencing. Return severity-ranked findings and whether the plan is ready for the next approval gate. Review authorizes neither implementation nor live calls.

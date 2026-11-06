# Proposed plan amendment from persistence v1

For Omar, to fold into `docs/Implementation-Plan-DRAFT.md` (revision 7) as a new revision. Drafted by Claude Code on 2026-11-07 after the independent Codex review of persistence v1. **Claude has not edited the plan.**

It records two changes Ahmed has already approved in chat, and the wording that closes carried item C1. Each item gives the plan text it changes and the proposed replacement.

## 1. F3 safe publication: a no-replace move instead of a hard link plus removal

**Approved by Ahmed in chat on 2026-11-07** ("No-replace move"), after Codex's High finding 1.

**Why.** macOS can only delete a file by its name. Between checking a file and deleting it, another program can swap something else in under that name, and the app would then delete the replacement. A hard link followed by removing the temporary name needs exactly that kind of deletion. So does the old quarantine move (link, then remove the old name). That window can be narrowed but never closed.

macOS's `renameatx_np` with `RENAME_EXCL` moves a file atomically and fails if the destination name exists. Whatever is at the source name is moved, never deleted, so the app needs no deletion at all.

**Current text (F3, "Safe publication"):**

> A record file is written to a new temporary file (exclusive create), flushed to disk, then **published with a hard link to the final name, which fails if that name already exists**, and the temporary file is unlinked. The folder is then flushed to disk. A plain rename, which would replace an existing file, is never used.

**Proposed text:**

> A record file is written to a new temporary file (exclusive create), flushed to disk, then **published with a no-replace move (macOS `renameatx_np` with `RENAME_EXCL`) to the final name, which fails if that name already exists**. The folder is then flushed to disk. A plain rename, which would replace an existing file, is never used, and the app never deletes any file: a temporary file whose publication failed is moved to quarantine, and a pre-existing `.tmp-` name that the app did not create is left alone.

**Current text (F3, "Safe quarantine moves"):**

> Content goes to `quarantine/<original-name>-<write-id>`, published with the same no-replace hard link and then removed from its old name. If that name exists, the app adds `-2`, `-3` and so on. A move is repeatable: if the quarantine copy already exists with the same hash, only the old name is removed.

**Proposed text:**

> Content goes to `quarantine/<original-name>-<write-id>` by the same no-replace move, which is atomic: there is no separate removal of the old name. If that name exists, the app adds `-2`, `-3` and so on. A move is repeatable: after a crash the source name is simply gone, and the copy is in quarantine. Only regular files are moved; anything else (a symlink, a FIFO) stays where it is and is listed in the F5 inventory.

**Elsewhere in F3:** the recovery wording "a crash after the hard link but before the folder flush or the SQLite acknowledgement" becomes "a crash after the move but before the folder flush or the SQLite acknowledgement". The meaning is unchanged.

## 2. F2 re-check tied to the folder handle that is written through

Codex's High finding 2. This is an implementation detail that closes a gap between the F2 check and F3's handles. It isn't a change of intent.

**Proposed addition to F2**, after "Before every task and every write, the app re-checks the resolved folder path and the `RULES.md` business line":

> The folder's identity (device and inode) is recorded at registration. Each write opens the project root once as a handle (refusing a symlink anywhere in its path), checks that handle's identity and the `RULES.md` business line read through it, and then opens every folder below it relative to that same handle. The folder that was checked is therefore the folder that is written to; replacing the root folder after the check cannot redirect a write.

## 3. Carried item C1: wording that closes it

**What the code does.** The finalizing record keeps the exact serialized bytes and hash of `final-status.json`, including its file list taken from the database, never from disk. That record is held durably in the SQLite store. Every republish writes those stored bytes, so republishing never rebuilds the file list from current disk.

**Current text (validation for revision 5):**

> A `final-status.json` publication failure keeps the recorded outcome and is retried with the same outcome. A failed stage or stage-record publication gives "failed". Already-final attempts are left alone, apart from their record state.

**Proposed text:**

> A `final-status.json` publication failure keeps the recorded outcome and is retried with the same outcome. A failed stage or stage-record publication gives "failed". Already-final attempts keep their outcome and are otherwise left alone, except that recovery republishes a missing `final-status.json` from the stored finalizing bytes (moving a mismatched copy to quarantine first). Their record state is always recomputed.

**Proposed change to "Carried items":** mark C1 as settled in persistence v1 (`docs/Build-Report-Persistence-v1.md`, section 5), once this wording is adopted.

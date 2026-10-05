import { invoke } from "@tauri-apps/api/core";
import type { RepoInfo } from "../bindings/RepoInfo";
import type { Status } from "../bindings/Status";
import type { LineOp } from "../bindings/LineOp";
import type { OpEntry } from "../bindings/OpEntry";
import type { GraphPage } from "../bindings/GraphPage";
import type { CommitDetails } from "../bindings/CommitDetails";
import type { Refs } from "../bindings/Refs";
import type { StashOp } from "../bindings/StashOp";
import type { Side } from "../bindings/Side";
import type { DeviceCode } from "../bindings/DeviceCode";

export const openRepo = (path: string) => invoke<RepoInfo>("open_repo", { path });
export const recentRepos = () => invoke<string[]>("recent_repos");
export const repoStatus = (path: string) => invoke<Status>("repo_status", { path });
export const stage = (path: string, paths: string[]) => invoke<void>("stage", { path, paths });
export const unstage = (path: string, paths: string[]) => invoke<void>("unstage", { path, paths });
export const discard = (path: string, paths: string[]) => invoke<void>("discard", { path, paths });
export const commit = (path: string, message: string, amend: boolean) => invoke<void>("commit", { path, message, amend });
/** null before the first commit. */
export const headMessage = (path: string) => invoke<string | null>("head_message", { path });
/** `lines` index into the lines of the file's `fileDiff` text. */
export const applyLines = (path: string, file: string, op: LineOp, lines: number[]) =>
  invoke<void>("apply_lines", { path, file, op, lines });
/** Newest first, already-undone entries left out. */
export const opLog = (path: string) => invoke<OpEntry[]>("op_log", { path });
export const undo = (path: string, id: string) => invoke<void>("undo", { path, id });
/** null = binary or over 1 MB. */
export const fileDiff = (path: string, file: string, staged: boolean) =>
  invoke<string | null>("file_diff", { path, file, staged });
/** Graph rows `offset..offset + limit`, newest first. */
export const graphRows = (path: string, offset: number, limit: number) =>
  invoke<GraphPage>("graph_rows", { path, offset, limit });
export const commitDetails = (path: string, oid: string) => invoke<CommitDetails>("commit_details", { path, oid });
/** null = binary or over 1 MB. */
export const commitFileDiff = (path: string, oid: string, file: string) =>
  invoke<string | null>("commit_file_diff", { path, oid, file });
export const refs = (path: string) => invoke<Refs>("refs", { path });
/** `track`: create a local branch tracking remote branch `name` ("origin/feat") and switch to it. */
export const checkout = (path: string, name: string, track: boolean) => invoke<void>("checkout", { path, name, track });
export const createBranch = (path: string, name: string, checkout: boolean) => invoke<void>("create_branch", { path, name, checkout });
/** Fails with code "not_merged" unless `force`. Undoable via the op log. */
export const deleteBranch = (path: string, name: string, force: boolean) => invoke<void>("delete_branch", { path, name, force });
/** Merges `rev` into the current branch, or with `cherryPick` applies that one commit. Code "conflicts" = stopped halfway. */
export const merge = (path: string, rev: string, cherryPick: boolean) => invoke<void>("merge", { path, rev, cherryPick });
/** Aborts the in-progress merge/cherry-pick (changed files backed up first). */
export const abortOp = (path: string) => invoke<void>("abort", { path });
/** Annotated when `message` isn't empty. */
export const createTag = (path: string, name: string, target: string, message: string) =>
  invoke<void>("create_tag", { path, name, target, message });
export const deleteTag = (path: string, name: string) => invoke<void>("delete_tag", { path, name });
/** Stashes all changes, untracked files included. */
export const stashSave = (path: string, message: string) => invoke<void>("stash_save", { path, message });
/** `oid` must still be stash@{index}, else code "stale". */
export const stash = (path: string, op: StashOp, index: number, oid: string) => invoke<void>("stash", { path, op, index, oid });
// Network ops. git may ask for credentials meanwhile through the "askpass" event (see AskpassDialog).
export const fetchAll = (path: string) => invoke<void>("fetch", { path });
/** Merges the upstream (no rebase); code "conflicts" = stopped halfway. Undoable. */
export const pull = (path: string) => invoke<void>("pull", { path });
/** Pushes the current branch; without an upstream it goes to origin and becomes the upstream. Code "rejected" = pull first. */
export const push = (path: string) => invoke<void>("push", { path });
export const pushTag = (path: string, name: string) => invoke<void>("push_tag", { path, name });
/** `name` is the remote branch, e.g. "origin/feat". Undo pushes it back. */
export const deleteRemoteBranch = (path: string, name: string) => invoke<void>("delete_remote_branch", { path, name });
/** Clones `url` into `dest` (missing or empty folder) and opens it. Progress comes as "clone-progress" events (git's lines). */
export const cloneRepo = (url: string, dest: string) => invoke<RepoInfo>("clone_repo", { url, dest });
/** Takes one side of each conflicted file whole (backed up first, undoable) and marks it resolved. */
export const resolve = (path: string, paths: string[], side: Side) => invoke<void>("resolve", { path, paths, side });
/** Working-tree text of a file; null = binary or over 1 MB. */
export const workFile = (path: string, file: string) => invoke<string | null>("work_file", { path, file });
/** Opens a repo file in its default app. */
export const openFile = (path: string, file: string) => invoke<void>("open_file", { path, file });
/** Answers an "askpass" prompt; null cancels (git then fails). */
export const askpassReply = (id: number, answer: string | null) => invoke<void>("askpass_reply", { id, answer });
// GitHub sign-in (OAuth device flow). The token stays in the OS keychain; git gets it via askpass.
export const githubStart = () => invoke<DeviceCode>("github_start");
/** Resolves with the login once the user approves `code` on GitHub; code "expired" / "denied" otherwise. */
export const githubFinish = (code: DeviceCode) => invoke<string>("github_finish", { code });
/** null = signed out. */
export const githubUser = () => invoke<string | null>("github_user");
export const githubSignOut = () => invoke<void>("github_sign_out");

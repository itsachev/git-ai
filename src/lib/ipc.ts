import { invoke } from "@tauri-apps/api/core";
import type { RepoInfo } from "../bindings/RepoInfo";
import type { Status } from "../bindings/Status";
import type { LineOp } from "../bindings/LineOp";
import type { OpEntry } from "../bindings/OpEntry";
import type { GraphPage } from "../bindings/GraphPage";
import type { CommitDetails } from "../bindings/CommitDetails";
import type { Refs } from "../bindings/Refs";
import type { StashOp } from "../bindings/StashOp";

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

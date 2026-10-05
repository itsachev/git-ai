import { invoke } from "@tauri-apps/api/core";
import type { RepoInfo } from "../bindings/RepoInfo";
import type { Status } from "../bindings/Status";
import type { LineOp } from "../bindings/LineOp";
import type { OpEntry } from "../bindings/OpEntry";

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

import { invoke } from "@tauri-apps/api/core";
import type { RepoInfo } from "../bindings/RepoInfo";
import type { Status } from "../bindings/Status";

export const openRepo = (path: string) => invoke<RepoInfo>("open_repo", { path });
export const recentRepos = () => invoke<string[]>("recent_repos");
export const repoStatus = (path: string) => invoke<Status>("repo_status", { path });
export const stage = (path: string, paths: string[]) => invoke<void>("stage", { path, paths });
export const unstage = (path: string, paths: string[]) => invoke<void>("unstage", { path, paths });
export const discard = (path: string, paths: string[]) => invoke<void>("discard", { path, paths });
export const commit = (path: string, message: string) => invoke<void>("commit", { path, message });
/** null = binary or over 1 MB. */
export const fileDiff = (path: string, file: string, staged: boolean) =>
  invoke<string | null>("file_diff", { path, file, staged });
